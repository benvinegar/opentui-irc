import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../src/contracts/common";
import type { ControlHandler, ControlRequest, ControlServer } from "../../src/contracts/control";
import {
  acquireControlLease,
  createControlClient,
  createControlServer,
  probeControlServer,
  resolveControlPaths,
  type ControlLease,
  type ControlLimits,
} from "../../src/control/socket";

const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function profile(): Promise<string> {
  const config = await mkdtemp(join(tmpdir(), "openirc-ipc-test-"));
  const paths = value(await resolveControlPaths(config));
  cleanups.push(() => rm(config, { force: true, recursive: true }));
  cleanups.push(() => rm(paths.directory, { force: true, recursive: true }));
  return config;
}
async function lease(config: string): Promise<ControlLease> {
  const acquired = value(await acquireControlLease(config, signal()));
  cleanups.push(() => acquired.release());
  return acquired;
}
const request = (id = "id"): ControlRequest => ({
  version: 1,
  id,
  method: "status",
  params: {},
  permissions: ["inspect"],
});
const handler: ControlHandler = async (input) => ({
  version: 1,
  id: input.id,
  ok: true,
  result: { text: "你好 😀" },
});
async function start(
  configDirectory: string,
  options: {
    handler?: ControlHandler;
    limits?: ControlLimits;
    signal?: AbortSignal;
    afterResponse?: (request: ControlRequest, response: unknown) => void | Promise<void>;
  } = {},
): Promise<ControlServer> {
  const server = value(await createControlServer({ configDirectory, handler, ...options }));
  cleanups.push(() => server.close());
  return server;
}
async function raw(path: string, chunks: readonly (string | Buffer)[]): Promise<string> {
  return await new Promise<string>((done, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw test timeout"));
    }, 2000);
    const received: Buffer[] = [];
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      done(Buffer.concat(received).toString("utf8"));
    });
  });
}
async function fake(
  config: string,
  connected: (socket: Socket) => void,
): Promise<{ server: Server; path: string }> {
  const claim = await lease(config);
  const server = createServer(connected);
  await new Promise<void>((done) => server.listen(claim.paths.socketPath, done));
  await chmod(claim.paths.socketPath, 0o600);
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return { server, path: claim.paths.socketPath };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("secure profile paths and leases", () => {
  test("canonicalizes aliases, including missing children, and keeps Unix socket paths short/private", async () => {
    const config = await profile();
    const alias = `${config}-alias`;
    await symlink(config, alias);
    cleanups.push(() => unlink(alias));
    const direct = value(await resolveControlPaths(join(config, "missing", "nested")));
    const linked = value(await resolveControlPaths(join(alias, "missing", "nested")));
    cleanups.push(() => rm(direct.directory, { recursive: true, force: true }));
    expect(direct).toEqual(linked);
    expect(direct.socketPath.length).toBeLessThan(104);
    expect((await lstat(direct.directory)).mode & 0o777).toBe(0o700);
  });

  test("live lease is exclusive across offline/server starts and release is idempotent", async () => {
    const config = await profile();
    const held = await lease(config);
    expect((await lstat(held.paths.leasePath)).mode & 0o777).toBe(0o600);
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    expect((await createControlServer({ configDirectory: config, handler })).ok).toBe(false);
    await held.release();
    await held.release();
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
    await start(config);
    expect(value(await probeControlServer(config, signal()))).toBe("live");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
  });

  test("an ambiguous lease never becomes live/offline eligibility even with an accepting socket", async () => {
    const config = await profile();
    await start(config);
    const paths = value(await resolveControlPaths(config));
    await writeFile(paths.leasePath, "", { mode: 0o600 });
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect(
      (await createControlClient({ configDirectory: config }).request(request(), signal())).ok,
    ).toBe(false);
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
  });

  test("simultaneous startup/offline claims admit exactly one writer", async () => {
    const config = await profile();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => acquireControlLease(config, signal())),
    );
    const winners = attempts.filter((attempt) => attempt.ok);
    expect(winners).toHaveLength(1);
    for (const winner of winners) if (winner.ok) await winner.value.release();
    const startup = await Promise.all([
      createControlServer({ configDirectory: config, handler }),
      acquireControlLease(config, signal()),
    ]);
    expect(startup.filter((result) => result.ok)).toHaveLength(1);
    for (const result of startup)
      if (result.ok) {
        if ("close" in result.value) await result.value.close();
        else await result.value.release();
      }
  });

  test("reclaims only a proven-dead PID; malformed/empty/ambiguous/live leases stay busy", async () => {
    const config = await profile();
    const paths = value(await resolveControlPaths(config));
    for (const text of [
      "",
      "junk",
      "0\n00000000-0000-0000-0000-000000000000\n",
      `${process.pid}\n00000000-0000-0000-0000-000000000000\n`,
    ]) {
      await writeFile(paths.leasePath, text, { mode: 0o600 });
      expect(value(await probeControlServer(config, signal()))).toBe("busy");
      expect((await acquireControlLease(config, signal())).ok).toBe(false);
      expect(await readFile(paths.leasePath, "utf8")).toBe(text);
      await unlink(paths.leasePath);
    }
    // Linux/macOS PID_MAX is far below this value; ESRCH is independently checked by implementation.
    await writeFile(paths.leasePath, "2147483647\n00000000-0000-0000-0000-000000000000\n", {
      mode: 0o600,
    });
    const recovered = await lease(config);
    expect(await readFile(paths.leasePath, "utf8")).toContain(`${process.pid}\n`);
    await recovered.release();
  });

  test("parallel stale recovery cannot delete a winning lease", async () => {
    const config = await profile();
    const paths = value(await resolveControlPaths(config));
    await writeFile(paths.leasePath, "2147483647\n00000000-0000-0000-0000-000000000000\n", {
      mode: 0o600,
    });
    const attempts = await Promise.all(
      Array.from({ length: 16 }, () => acquireControlLease(config, signal())),
    );
    const winners = attempts.filter((attempt) => attempt.ok);
    expect(winners).toHaveLength(1);
    expect(await readFile(paths.leasePath, "utf8")).toContain(`${process.pid}\n`);
    for (const winner of winners) if (winner.ok) await winner.value.release();
  });

  test("fails closed on directory/lease/socket symlinks, wrong modes/types/owners", async () => {
    const config = await profile();
    const paths = value(await resolveControlPaths(config));
    await chmod(paths.directory, 0o755);
    expect((await resolveControlPaths(config)).ok).toBe(false);
    await chmod(paths.directory, 0o700);
    const target = join(config, "untouched");
    await writeFile(target, "secret", { mode: 0o600 });
    await symlink(target, paths.leasePath);
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await unlink(paths.leasePath);
    await writeFile(paths.leasePath, "", { mode: 0o644 });
    expect((await probeControlServer(config, signal())).ok).toBe(false);
    await unlink(paths.leasePath);
    await mkdir(paths.leasePath, { mode: 0o700 });
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await rm(paths.leasePath, { recursive: true });
    await symlink(target, paths.socketPath);
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    expect((await probeControlServer(config, signal())).ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("secret");
    await unlink(paths.socketPath);
    await writeFile(paths.socketPath, "not socket", { mode: 0o600 });
    expect((await createControlServer({ configDirectory: config, handler })).ok).toBe(false);
    await unlink(paths.socketPath);
    if (process.getuid?.() === 0) {
      await chown(paths.directory, 12345, 12345);
      expect((await resolveControlPaths(config)).ok).toBe(false);
      await chown(paths.directory, 0, 0);
    }
    await rm(paths.directory, { recursive: true });
    await symlink(config, paths.directory);
    expect((await resolveControlPaths(config)).ok).toBe(false);
    await unlink(paths.directory);
  });

  test("live orphan socket forbids offline fallback; refused socket plus live lease stays busy; dead orphan recovers", async () => {
    const config = await profile();
    const paths = value(await resolveControlPaths(config));
    const script = `import {createServer} from 'node:net'; import {chmodSync} from 'node:fs'; const s=createServer(socket=>socket.on('error',()=>{})); s.listen(${JSON.stringify(paths.socketPath)},()=>{chmodSync(${JSON.stringify(paths.socketPath)},0o600);console.log('ready')});`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    cleanups.push(async () => {
      child.kill();
      await child.exited;
    });
    const reader = child.stdout.getReader();
    expect((await reader.read()).done).toBe(false);
    reader.releaseLock();
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    // Simulate a server dying while the offline/startup profile owner is still alive.
    await writeFile(paths.leasePath, `${process.pid}\n00000000-0000-0000-0000-000000000000\n`, {
      mode: 0o600,
    });
    child.kill("SIGKILL");
    await child.exited;
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect(
      (await createControlClient({ configDirectory: config }).request(request(), signal())).ok,
    ).toBe(false);
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await unlink(paths.leasePath);
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
    const server = await start(config);
    await server.close();
  });

  test("release preserves replacement files and aborted acquisitions do not reserve", async () => {
    const config = await profile();
    const held = await lease(config);
    await unlink(held.paths.leasePath);
    await writeFile(held.paths.leasePath, "replacement", { mode: 0o600 });
    await held.release();
    expect(await readFile(held.paths.leasePath, "utf8")).toBe("replacement");
    const abort = new AbortController();
    abort.abort();
    expect((await acquireControlLease(config, abort.signal)).ok).toBe(false);
  });
});

describe("bounded control NDJSON transport", () => {
  test("roundtrips parallel requests, invokes afterResponse and cleans socket and lease", async () => {
    const config = await profile();
    const after: string[] = [];
    const server = await start(config, {
      afterResponse(input) {
        after.push(input.id);
      },
    });
    expect((await lstat(server.socketPath)).mode & 0o777).toBe(0o600);
    const client = createControlClient({ configDirectory: config });
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => client.request(request(`id-${index}`), signal())),
    );
    for (const response of responses) expect(value(response).ok).toBe(true);
    expect(after).toHaveLength(10);
    await server.close();
    await server.close();
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
    const absent = await client.request(request(), signal());
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error).toMatchObject({ code: "unavailable", retryable: false });
  });

  test("closing removes only its own endpoint, never replacement files or symlinks", async () => {
    for (const kind of ["file", "symlink"] as const) {
      const config = await profile();
      const server = await start(config);
      const target = join(config, "preserved");
      await writeFile(target, "untouched", { mode: 0o600 });
      await unlink(server.socketPath);
      if (kind === "file") await writeFile(server.socketPath, "replacement", { mode: 0o600 });
      else await symlink(target, server.socketPath);
      await server.close();
      expect(await readFile(server.socketPath, "utf8")).toBe(
        kind === "file" ? "replacement" : "untouched",
      );
      expect(await readFile(target, "utf8")).toBe("untouched");
    }
  });

  test("handles UTF-8 byte chunk boundaries without replacement characters", async () => {
    const config = await profile();
    const server = await start(config, {
      handler: async (input) => ({ version: 1, id: input.id, ok: true, result: input.params }),
    });
    const bytes = Buffer.from(`${JSON.stringify({ ...request(), params: { text: "你好 😀" } })}\n`);
    const reply = JSON.parse(
      await raw(
        server.socketPath,
        Array.from(bytes, (byte) => Buffer.from([byte])),
      ),
    );
    expect(reply.result).toEqual({ text: "你好 😀" });
  });

  test("client waits across a split UTF-8 codepoint before fatal decoding", async () => {
    const config = await profile();
    await fake(config, (socket) =>
      socket.on("data", () => {
        const bytes = Buffer.from(
          `${JSON.stringify({ version: 1, id: "id", ok: true, result: "你好 😀" })}\n`,
        );
        const split = bytes.indexOf(Buffer.from("你")) + 1;
        socket.write(bytes.subarray(0, split));
        setTimeout(() => socket.end(bytes.subarray(split)), 5);
      }),
    );
    expect(
      value(await createControlClient({ configDirectory: config }).request(request(), signal())),
    ).toEqual({ version: 1, id: "id", ok: true, result: "你好 😀" });
  });

  test("rejects malformed/invalid UTF-8/oversized/multiple requests without dispatch or raw echo", async () => {
    const config = await profile();
    let dispatched = 0;
    const server = await start(config, {
      limits: { maxRequestBytes: 256 },
      handler: async (input, abort) => {
        dispatched++;
        return handler(input, abort);
      },
    });
    for (const bytes of [
      "secret-not-json\n",
      "{}\n",
      Buffer.from([0xff, 10]),
      "x".repeat(257),
      `${JSON.stringify(request())}\n${JSON.stringify(request())}\n`,
      `${JSON.stringify({ ...request(), params: { constructor: {} } })}\n`,
    ]) {
      const response = await raw(server.socketPath, [bytes]);
      expect(response).not.toContain("secret-not-json");
      if (response) expect(JSON.parse(response).ok).toBe(false);
    }
    expect(dispatched).toBe(0);
  });

  test("oversized responses become safe errors, never truncation or successful shutdown hooks", async () => {
    const config = await profile();
    let hookOk: boolean | undefined;
    const server = await start(config, {
      limits: { maxResponseBytes: 256 },
      handler: async (input) => ({
        version: 1,
        id: input.id,
        ok: true,
        result: "secret".repeat(500),
      }),
      afterResponse(_input, response) {
        if (response && typeof response === "object" && "ok" in response)
          hookOk = response.ok === true;
      },
    });
    const reply = JSON.parse(await raw(server.socketPath, [`${JSON.stringify(request())}\n`]));
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain("secret");
    expect(hookOk).toBe(false);
    const config2 = await profile();
    await start(config2, { limits: { maxResponseBytes: 1 } });
    expect(
      (await createControlClient({ configDirectory: config2 }).request(request(), signal())).ok,
    ).toBe(false);
  });

  test("timeouts/abort after submission report unknown and never permit offline fallback", async () => {
    const config = await profile();
    let admitted: (() => void) | undefined;
    const admission = new Promise<void>((done) => {
      admitted = done;
    });
    await start(config, {
      handler: async (_input, abort) => {
        admitted?.();
        await new Promise<void>((done) =>
          abort.addEventListener("abort", () => done(), { once: true }),
        );
        return { version: 1, id: "id", ok: true, result: null };
      },
    });
    const client = createControlClient({ configDirectory: config, timeoutMs: 30 });
    const timeout = await client.request(request(), signal());
    expect(timeout.ok).toBe(false);
    if (!timeout.ok)
      expect(timeout.error).toMatchObject({
        code: "timeout",
        outcome: "unknown",
        retryable: false,
      });
    await admission;
    expect(value(await probeControlServer(config, signal()))).toBe("live");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    const before = new AbortController();
    before.abort();
    const cancelledBefore = await client.request(request(), before.signal);
    if (!cancelledBefore.ok) expect(cancelledBefore.error.outcome).toBeUndefined();
    const after = new AbortController();
    const pending = client.request(request(), after.signal);
    await Bun.sleep(10);
    after.abort();
    const cancelledAfter = await pending;
    expect(cancelledAfter.ok).toBe(false);
    if (!cancelledAfter.ok)
      expect(cancelledAfter.error).toMatchObject({ code: "cancelled", outcome: "unknown" });
  });

  test("server timeout cancels handlers, bounds idle connections, and close unblocks clients", async () => {
    const config = await profile();
    let aborted = false;
    const server = await start(config, {
      limits: { maxConnections: 1, timeoutMs: 60 },
      handler: async (_input, abort) => {
        await new Promise<void>((done) =>
          abort.addEventListener(
            "abort",
            () => {
              aborted = true;
              done();
            },
            { once: true },
          ),
        );
        return { version: 1, id: "id", ok: true, result: null };
      },
    });
    const client = createControlClient({ configDirectory: config, timeoutMs: 500 });
    const pending = client.request(request(), signal());
    await Bun.sleep(15);
    const excess = await client.request(request("extra"), signal());
    expect(excess.ok).toBe(false);
    expect((await pending).ok).toBe(false);
    expect(aborted).toBe(true);
    const pendingClose = client.request(request(), signal());
    await Bun.sleep(10);
    await server.close();
    expect((await pendingClose).ok).toBe(false);
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
  });

  test("root abort closes server and afterResponse can close without deadlock", async () => {
    const config = await profile();
    const root = new AbortController();
    const server = await start(config, { signal: root.signal });
    root.abort();
    await server.close();
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
    const config2 = await profile();
    let shutdown: ControlServer | undefined;
    shutdown = await start(config2, {
      afterResponse: async () => {
        await shutdown?.close();
      },
    });
    const reply = await createControlClient({ configDirectory: config2 }).request(
      request(),
      signal(),
    );
    expect(value(reply).ok).toBe(true);
    await shutdown.close();
  });

  test("client rejects unsafe socket permissions, incomplete replies and split invalid UTF-8", async () => {
    const config = await profile();
    const server = await start(config);
    await chmod(server.socketPath, 0o666);
    const unsafe = await createControlClient({ configDirectory: config }).request(
      request(),
      signal(),
    );
    expect(unsafe.ok).toBe(false);
    expect((await probeControlServer(config, signal())).ok).toBe(false);
    await chmod(server.socketPath, 0o600);
    const config2 = await profile();
    await fake(config2, (socket) => socket.on("data", () => socket.end('{"version":1')));
    const incomplete = await createControlClient({ configDirectory: config2 }).request(
      request(),
      signal(),
    );
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.error.outcome).toBe("unknown");
    const config3 = await profile();
    await fake(config3, (socket) =>
      socket.on("data", () => {
        socket.write(Buffer.from([0xc3]));
        socket.end(Buffer.from([0x28, 10]));
      }),
    );
    expect(
      (await createControlClient({ configDirectory: config3 }).request(request(), signal())).ok,
    ).toBe(false);
  });

  test("client validates response version/id/size and hides raw platform/handler errors", async () => {
    for (const payload of [
      JSON.stringify({ version: 2, id: "id", ok: true, result: null }),
      JSON.stringify({ version: 1, id: "wrong", ok: true, result: null }),
      "secret-invalid-json",
      "x".repeat(300),
    ]) {
      const config = await profile();
      await fake(config, (socket) => {
        socket.on("data", () => socket.end(`${payload}\n`));
      });
      const result = await createControlClient({
        configDirectory: config,
        limits: { maxResponseBytes: 256 },
      }).request(request(), signal());
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret-invalid-json");
    }
    const config = await profile();
    await start(config, {
      handler: async () => {
        throw new Error("secret-handler-stack");
      },
    });
    const result = await createControlClient({ configDirectory: config }).request(
      request(),
      signal(),
    );
    expect(value(result).ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-handler-stack");
  });
});
