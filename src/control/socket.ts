import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import type { Result } from "../contracts/common";
import type {
  ControlClient,
  ControlError,
  ControlHandler,
  ControlRequest,
  ControlResponse,
  ControlServer,
} from "../contracts/control";
import { parseControlRequest, parseControlResponse } from "./protocol";

export interface ControlPaths {
  readonly directory: string;
  readonly socketPath: string;
  readonly leasePath: string;
}
export interface ControlLease {
  readonly paths: ControlPaths;
  release(): Promise<void>;
}
export interface ControlLimits {
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxConnections?: number;
  readonly timeoutMs?: number;
}
export const DEFAULT_CONTROL_LIMITS = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxConnections: 16,
  timeoutMs: 10_000,
} as const;

type Limits = { [K in keyof typeof DEFAULT_CONTROL_LIMITS]: number };
type Failure = { ok: false; error: ControlError };
function failure(
  code: ControlError["code"],
  message: string,
  retryable = false,
  unknown = false,
): Failure {
  return {
    ok: false,
    error: { code, message, retryable, ...(unknown ? { outcome: "unknown" } : {}) },
  };
}
const unsafe = () => failure("unavailable", "Unsafe control filesystem paths.");
const busy = () => failure("conflict", "Control profile is busy.", true);
const cancelled = (submitted = false) =>
  failure("cancelled", "Control request cancelled.", false, submitted);
class SafeFailure extends Error {
  constructor(readonly result: Failure) {
    super(result.error.message);
  }
}
function fsCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
function uid(): number {
  if (!process.getuid) throw new SafeFailure(unsafe());
  return process.getuid();
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new SafeFailure(cancelled());
}
function limits(input: ControlLimits = {}): Limits {
  const result = { ...DEFAULT_CONTROL_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    const ceiling =
      key === "timeoutMs" ? 300_000 : key === "maxConnections" ? 1024 : 16 * 1024 * 1024;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new SafeFailure(failure("invalid-input", "Invalid control transport limits."));
    }
  }
  return result;
}
async function maybeStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (fsCode(error) === "ENOENT") return undefined;
    throw error;
  }
}
function privateStat(stat: Stats, kind: "directory" | "socket" | "file"): void {
  const type =
    kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile();
  if (
    !type ||
    stat.isSymbolicLink() ||
    stat.uid !== uid() ||
    (stat.mode & 0o7777) !== (kind === "directory" ? 0o700 : 0o600) ||
    (kind === "file" && stat.nlink !== 1)
  ) {
    throw new SafeFailure(unsafe());
  }
}
function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function removeOwn(path: string, identity: Stats): Promise<void> {
  const current = await maybeStat(path);
  if (current && same(current, identity)) await unlink(path);
}
async function canonical(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (fsCode(error) !== "ENOENT" || (await maybeStat(current))) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** /tmp is deliberate: short enough for macOS sockaddr_un, independent of config path length.
 * The private parent prevents cross-UID renames. Arbitrary same-UID code is trusted, not sandboxed.
 * In particular same-UID malicious rename races cannot be prevented with path-based Unix APIs. */
export async function resolveControlPaths(
  configDirectory: string,
): Promise<Result<ControlPaths, ControlError>> {
  try {
    if (!configDirectory || configDirectory.includes("\0"))
      return failure("invalid-input", "Invalid configuration directory.");
    const config = await canonical(configDirectory);
    const parent = await realpath("/tmp");
    const parentStat = await lstat(parent);
    if (
      !parentStat.isDirectory() ||
      (parentStat.uid !== 0 && parentStat.uid !== uid()) ||
      ((parentStat.mode & 0o022) !== 0 && (parentStat.mode & 0o1000) === 0)
    )
      throw new SafeFailure(unsafe());
    const hash = createHash("sha256").update(config).digest("hex").slice(0, 24);
    const directory = join(parent, `openirc-${uid()}-${hash}`);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (fsCode(error) !== "EEXIST") throw error;
    }
    privateStat(await lstat(directory), "directory");
    return {
      ok: true,
      value: {
        directory,
        socketPath: join(directory, "control.sock"),
        leasePath: join(directory, "profile.lease"),
      },
    };
  } catch (error) {
    return error instanceof SafeFailure ? error.result : unsafe();
  }
}

async function readLease(path: string): Promise<{ stat: Stats; pid?: number } | undefined> {
  const stat = await maybeStat(path);
  if (!stat) return undefined;
  privateStat(stat, "file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!same(stat, opened)) throw new SafeFailure(busy());
    if (stat.size > 128) return { stat };
    const bytes = Buffer.alloc(129);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (!same(opened, after)) throw new SafeFailure(busy());
    const text = bytes.subarray(0, bytesRead).toString("ascii");
    const match = /^([1-9][0-9]{0,9})\n[0-9a-f-]{36}\n$/.exec(text);
    const pid = match ? Number(match[1]) : undefined;
    return pid !== undefined && Number.isSafeInteger(pid) && pid <= 2_147_483_647
      ? { stat, pid }
      : { stat };
  } finally {
    await file.close();
  }
}
function dead(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return fsCode(error) === "ESRCH";
  }
}

/** No payload is sent: a probe must never dispatch a mutation. */
function socketAlive(path: string, signal: AbortSignal): Promise<"live" | "refused" | "busy"> {
  return new Promise((done) => {
    if (signal.aborted) {
      done("busy");
      return;
    }
    const socket = createConnection(path);
    const finish = (value: "live" | "refused" | "busy") => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      done(value);
    };
    const abort = () => finish("busy");
    const timer = setTimeout(() => finish("busy"), 250);
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      // Bun can report ENOENT for a dead Unix endpoint whose socket inode still exists.
      const code = fsCode(error);
      finish(code === "ECONNREFUSED" || code === "ENOENT" ? "refused" : "busy");
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function reclaimLease(path: string, signal: AbortSignal): Promise<boolean> {
  // Serialize stale reclaimers so two observers cannot unlink a newly acquired lease.
  const recoveryPath = `${path}.recovery`;
  let recovery;
  try {
    recovery = await open(
      recoveryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (fsCode(error) === "EEXIST") {
      const stat = await lstat(recoveryPath);
      privateStat(stat, "file");
      return false;
    }
    throw error;
  }
  const identity = await recovery.stat();
  try {
    checkAbort(signal);
    const lease = await readLease(path);
    if (!lease || !dead(lease.pid)) return false;
    checkAbort(signal);
    const current = await maybeStat(path);
    if (!current || !same(current, lease.stat)) return false;
    await unlink(path);
    return true;
  } finally {
    await recovery.close();
    await removeOwn(recoveryPath, identity);
  }
}

/** Reserve before application boot OR offline writes, even when the control listener is disabled.
 * Release does not follow symlinks and only removes the exact lease inode it created.
 * Empty/ambiguous/live/PID-reused leases fail closed. Recovery mutex crash leftovers fail busy. */
export async function acquireControlLease(
  configDirectory: string,
  signal: AbortSignal,
): Promise<Result<ControlLease, ControlError>> {
  if (signal.aborted) return cancelled();
  const resolved = await resolveControlPaths(configDirectory);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  try {
    checkAbort(signal);
    let file;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        file = await open(
          paths.leasePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        if (fsCode(error) !== "EEXIST") throw error;
        if (attempt !== 0 || !(await reclaimLease(paths.leasePath, signal))) return busy();
      }
    }
    if (!file) return busy();
    let identity = await file.stat();
    let releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      releasing ??= removeOwn(paths.leasePath, identity);
      return releasing;
    };
    try {
      await file.writeFile(`${process.pid}\n${randomUUID()}\n`);
      await file.sync();
      identity = await file.stat();
      privateStat(identity, "file");
      await file.close();
      checkAbort(signal);
      const socket = await maybeStat(paths.socketPath);
      if (socket) {
        privateStat(socket, "socket");
        if ((await socketAlive(paths.socketPath, signal)) !== "refused")
          throw new SafeFailure(busy());
        checkAbort(signal);
        await removeOwn(paths.socketPath, socket);
        if (await maybeStat(paths.socketPath)) throw new SafeFailure(busy());
      }
      checkAbort(signal);
      return { ok: true, value: { paths, release } };
    } catch (error) {
      identity = await file.stat().catch(() => identity);
      await file.close().catch(() => {});
      await release();
      throw error;
    }
  } catch (error) {
    return error instanceof SafeFailure ? error.result : unsafe();
  }
}

/** 'absent' is advisory, not a write reservation: acquireControlLease is still mandatory.
 * Never derive offline eligibility from a failed RPC (including ECONNREFUSED or timeout). */
export async function probeControlServer(
  configDirectory: string,
  signal: AbortSignal,
): Promise<Result<"absent" | "live" | "busy", ControlError>> {
  if (signal.aborted) return cancelled();
  const resolved = await resolveControlPaths(configDirectory);
  if (!resolved.ok) return resolved;
  try {
    const lease = await readLease(resolved.value.leasePath);
    const socket = await maybeStat(resolved.value.socketPath);
    if (socket) {
      privateStat(socket, "socket");
      const status = await socketAlive(resolved.value.socketPath, signal);
      checkAbort(signal);
      if (status === "live") {
        return { ok: true, value: lease?.pid !== undefined && !dead(lease.pid) ? "live" : "busy" };
      }
      if (status === "busy") return { ok: true, value: "busy" };
    }
    if (lease && !dead(lease.pid)) return { ok: true, value: "busy" };
    const acquired = await acquireControlLease(configDirectory, signal);
    if (!acquired.ok)
      return acquired.error.code === "conflict" ? { ok: true, value: "busy" } : acquired;
    await acquired.value.release();
    return { ok: true, value: "absent" };
  } catch (error) {
    return error instanceof SafeFailure ? error.result : unsafe();
  }
}

/** Accumulate bytes, not decoded chunks; fatal UTF-8 decode only after the bounded line completes. */
function frameReader(
  maxBytes: number,
  onLine: (line: string) => void,
  onInvalid: () => void,
): (chunk: Buffer) => void {
  let buffer: Buffer | undefined;
  let size = 0;
  let complete = false;
  return (chunk) => {
    if (complete) {
      if (chunk.length) onInvalid();
      return;
    }
    if (size + chunk.length > maxBytes) {
      complete = true;
      onInvalid();
      return;
    }
    const newline = chunk.indexOf(10);
    if (newline >= 0 && newline !== chunk.length - 1) {
      complete = true;
      onInvalid();
      return;
    }
    // A single capped byte buffer avoids per-chunk object growth for tiny writes.
    buffer ??= Buffer.allocUnsafe(maxBytes);
    chunk.copy(buffer, size);
    size += chunk.length;
    if (newline < 0) return;
    complete = true;
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size - 1));
      buffer = undefined;
      onLine(line);
    } catch {
      buffer = undefined;
      onInvalid();
    }
  };
}
function json(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function errorResponse(id: string, error: ControlError): ControlResponse {
  return { version: 1, id, ok: false, error };
}

export async function createControlServer(options: {
  configDirectory: string;
  handler: ControlHandler;
  afterResponse?: (request: ControlRequest, response: ControlResponse) => void | Promise<void>;
  signal?: AbortSignal;
  limits?: ControlLimits;
}): Promise<Result<ControlServer, ControlError>> {
  let budget: Limits;
  try {
    budget = limits(options.limits);
  } catch (error) {
    return error instanceof SafeFailure ? error.result : unsafe();
  }
  const root = options.signal ?? new AbortController().signal;
  const acquired = await acquireControlLease(options.configDirectory, root);
  if (!acquired.ok) return acquired;
  const lease = acquired.value;
  // net.Server automatically unlinks its bind path on close, without an inode check.
  // Publish an exclusive hard link and remove the random bind name immediately so
  // closing the listener cannot unlink a replacement at the public socket path.
  const bindingPath = join(lease.paths.directory, `bind-${randomUUID().slice(0, 16)}.sock`);
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  let socketIdentity: Stats | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closed || sockets.size >= budget.maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    let accepted = false;
    let responding = false;
    const timer = setTimeout(() => {
      controller.abort();
      socket.destroy();
    }, budget.timeoutMs);
    const respond = (response: ControlResponse, request?: ControlRequest) => {
      if (responding || socket.destroyed || closed) return;
      responding = true;
      let checked = parseControlResponse(response);
      if (!checked.ok || (request && response.id !== request.id)) {
        checked = {
          ok: true,
          value: errorResponse(
            request?.id ?? "invalid",
            failure("internal", "Invalid control handler response.").error,
          ),
        };
      }
      let outgoing = checked.value;
      let bytes = Buffer.from(`${JSON.stringify(outgoing)}\n`);
      if (bytes.length > budget.maxResponseBytes) {
        outgoing = errorResponse(
          request?.id ?? "invalid",
          failure("protocol", "Control response exceeds byte limit.").error,
        );
        bytes = Buffer.from(`${JSON.stringify(outgoing)}\n`);
      }
      if (bytes.length > budget.maxResponseBytes) {
        socket.destroy();
        return;
      }
      socket.end(bytes, () => {
        if (controller.signal.aborted || closed) return;
        if (request && options.afterResponse) {
          try {
            void Promise.resolve(options.afterResponse(request, outgoing)).catch(() => {});
          } catch {
            /* No raw exceptions escape. */
          }
        }
      });
    };
    const invalid = () => {
      controller.abort();
      if (accepted || responding) socket.destroy();
      else respond(errorResponse("invalid", failure("protocol", "Invalid control request.").error));
    };
    socket.on(
      "data",
      frameReader(
        budget.maxRequestBytes,
        (line) => {
          const parsed = parseControlRequest(json(line));
          if (!parsed.ok) {
            invalid();
            return;
          }
          accepted = true;
          void Promise.resolve()
            .then(() => {
              if (controller.signal.aborted || closed) return undefined;
              return options.handler(parsed.value, controller.signal);
            })
            .then(
              (response) => {
                if (response && !controller.signal.aborted) respond(response, parsed.value);
              },
              () => {
                if (!controller.signal.aborted)
                  respond(
                    errorResponse(
                      parsed.value.id,
                      failure("internal", "Control handler failed.").error,
                    ),
                    parsed.value,
                  );
              },
            );
        },
        invalid,
      ),
    );
    socket.on("error", () => {
      controller.abort();
      socket.destroy();
    });
    socket.on("end", () => {
      if (!accepted && !responding) invalid();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      sockets.delete(socket);
    });
  });
  // Do not let handler promises delay bounded shutdown; cancellation is cooperative.
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    root.removeEventListener("abort", abort);
    closing = (async () => {
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => {
        const timer = setTimeout(done, Math.min(budget.timeoutMs, 1000));
        server.close(() => {
          clearTimeout(timer);
          done();
        });
      });
      if (socketIdentity) await removeOwn(lease.paths.socketPath, socketIdentity).catch(() => {});
      await lease.release();
    })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  const listenerFailed = () => {
    // A listening failure is not an application shutdown. The lifecycle owner
    // may still be using/flushing storage; retain its profile lease until close().
    closed = true;
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    server.close(() => {});
  };
  try {
    checkAbort(root);
    await new Promise<void>((done, reject) => {
      const error = (cause: Error) => {
        server.removeListener("listening", listening);
        reject(cause);
      };
      const listening = () => {
        server.removeListener("error", error);
        done();
      };
      server.once("error", error);
      server.once("listening", listening);
      server.listen(bindingPath);
    });
    // chmod only our just-bound socket, never an existing endpoint. link is
    // exclusive (EEXIST fails); no rename/overwrite of another endpoint is possible.
    const bound = await lstat(bindingPath);
    if (!bound.isSocket() || bound.uid !== uid()) throw new SafeFailure(unsafe());
    await chmod(bindingPath, 0o600);
    await link(bindingPath, lease.paths.socketPath);
    await unlink(bindingPath);
    socketIdentity = await lstat(lease.paths.socketPath);
    privateStat(socketIdentity, "socket");
    server.on("error", listenerFailed);
    root.addEventListener("abort", abort, { once: true });
    checkAbort(root);
    return { ok: true, value: { socketPath: lease.paths.socketPath, close } };
  } catch (error) {
    await close().catch(() => {});
    return error instanceof SafeFailure
      ? error.result
      : failure("unavailable", "Control listener could not start.");
  }
}

export function createControlClient(options: {
  configDirectory: string;
  timeoutMs?: number;
  limits?: ControlLimits;
}): ControlClient {
  return {
    async request(request, signal) {
      if (signal.aborted) return cancelled();
      const parsed = parseControlRequest(request);
      if (!parsed.ok) return parsed;
      let budget: Limits;
      try {
        budget = limits({
          ...options.limits,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        return error instanceof SafeFailure ? error.result : unsafe();
      }
      const bytes = Buffer.from(`${JSON.stringify(parsed.value)}\n`);
      if (bytes.length > budget.maxRequestBytes)
        return failure("protocol", "Control request exceeds byte limit.");
      const resolved = await resolveControlPaths(options.configDirectory);
      if (!resolved.ok) return resolved;
      try {
        checkAbort(signal);
        const socketStat = await maybeStat(resolved.value.socketPath);
        if (!socketStat)
          return failure(
            "unavailable",
            "Control socket is absent. Probe and reserve the profile before offline access.",
          );
        privateStat(socketStat, "socket");
        const lease = await readLease(resolved.value.leasePath);
        if (!lease || lease.pid === undefined || dead(lease.pid)) return busy();
      } catch (error) {
        return error instanceof SafeFailure ? error.result : unsafe();
      }
      return await new Promise<Result<ControlResponse, ControlError>>((done) => {
        let submitted = false;
        let settled = false;
        const socket = createConnection(resolved.value.socketPath);
        const finish = (result: Result<ControlResponse, ControlError>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          socket.destroy();
          done(result);
        };
        const abort = () => finish(cancelled(submitted));
        const timer = setTimeout(
          () =>
            finish(
              failure(
                "timeout",
                "Control request timed out; do not retry mutations automatically.",
                false,
                submitted,
              ),
            ),
          budget.timeoutMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        socket.once("connect", () => {
          if (signal.aborted) {
            abort();
            return;
          }
          submitted = true;
          socket.write(bytes);
        });
        socket.on(
          "data",
          frameReader(
            budget.maxResponseBytes,
            (line) => {
              const response = parseControlResponse(json(line));
              if (!response.ok || response.value.id !== parsed.value.id) {
                finish(failure("protocol", "Invalid control response.", false, submitted));
                return;
              }
              finish(response);
            },
            () =>
              finish(
                failure("protocol", "Invalid or oversized control response.", false, submitted),
              ),
          ),
        );
        socket.on("error", () =>
          finish(
            failure(
              "unavailable",
              "Control connection failed; offline fallback is unsafe.",
              false,
              submitted,
            ),
          ),
        );
        const disconnected = () =>
          finish(
            failure(
              "unavailable",
              "Control connection closed without a response.",
              false,
              submitted,
            ),
          );
        socket.on("end", disconnected);
        socket.on("close", disconnected);
      });
    },
  };
}
