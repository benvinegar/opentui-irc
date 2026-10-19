import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Result } from "../contracts/common";
import {
  CONTROL_VERSION,
  DEFAULT_CONTROL_PERMISSIONS,
  type ControlError,
  type ControlMethod,
  type ControlPermission,
  type ControlRequest,
  type ControlResponse,
  type JsonObject,
  type JsonValue,
} from "../contracts/control";

export interface ControlCliContext {
  readonly configDirectory?: string;
}

export interface ControlCliOptions {
  readonly execute: (
    request: ControlRequest,
    signal: AbortSignal,
    context: ControlCliContext,
  ) => Promise<ControlResponse>;
  readonly input?: () => Promise<string>;
  readonly read?: (path: string) => Promise<string>;
  /** Receives exactly one JSON envelope, without its terminating newline. */
  readonly output?: (jsonLine: string) => void;
  readonly signal?: AbortSignal;
  readonly requestId?: () => string;
}

export interface ParsedControlCli {
  readonly configDirectory?: string;
  readonly permissions: readonly ControlPermission[];
  readonly command: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

const JSON_LIMIT = 1024 * 1024;
const SECRET_LIMIT = 64 * 1024;
const GLOBAL_FLAGS = ["json", "help", "allow-read", "allow-send", "allow-destructive"];
const VALUE_FLAGS = new Set([
  "config-dir",
  "file",
  "expected-revision",
  "text",
  "network",
  "conversation",
  "sender",
  "after",
  "before",
  "cursor",
  "limit",
  "id",
  "name",
  "host",
  "nick",
  "port",
  "key",
]);
const BOOLEAN_FLAGS = new Set([
  ...GLOBAL_FLAGS,
  "stdin",
  "dry-run",
  "confirm",
  "no-tls",
  "auto-connect",
  "unmute",
]);
const MUTATION_FLAGS = ["file", "stdin", "dry-run", "expected-revision", "confirm"];
interface CommandSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly flags: readonly string[];
  readonly usage: string;
}
const COMMANDS: readonly CommandSpec[] = [
  { name: "help", min: 0, max: 0, flags: [], usage: "help" },
  { name: "capabilities", min: 0, max: 0, flags: [], usage: "capabilities" },
  { name: "status", min: 0, max: 0, flags: [], usage: "status" },
  { name: "config schema", min: 0, max: 0, flags: [], usage: "config schema" },
  { name: "config get", min: 0, max: 0, flags: [], usage: "config get" },
  {
    name: "config plan",
    min: 0,
    max: 0,
    flags: MUTATION_FLAGS,
    usage: "config plan --file PATH|- | --stdin [--expected-revision REV]",
  },
  {
    name: "config apply",
    min: 0,
    max: 0,
    flags: MUTATION_FLAGS,
    usage: "config apply --file PATH|- | --stdin [--dry-run] [--expected-revision REV] [--confirm]",
  },
  {
    name: "config set",
    min: 2,
    max: 2,
    flags: ["dry-run", "expected-revision", "confirm"],
    usage: "config set SECTION.PATH JSONVALUE [--dry-run] [--expected-revision REV] [--confirm]",
  },
  {
    name: "config reload",
    min: 0,
    max: 0,
    flags: ["dry-run", "expected-revision", "confirm"],
    usage: "config reload [--dry-run] [--expected-revision REV] [--confirm]",
  },
  { name: "networks list", min: 0, max: 0, flags: [], usage: "networks list" },
  {
    name: "networks add",
    min: 0,
    max: 0,
    flags: [...MUTATION_FLAGS, "id", "name", "host", "nick", "port", "no-tls", "auto-connect"],
    usage:
      "networks add --file PROFILE.json | --id ID --name NAME --host HOST --nick NICK [--port PORT] [--no-tls] [--auto-connect]",
  },
  {
    name: "networks update",
    min: 1,
    max: 1,
    flags: MUTATION_FLAGS,
    usage: "networks update ID|NAME --file PROFILE.json [--dry-run] [--expected-revision REV]",
  },
  {
    name: "networks remove",
    min: 1,
    max: 1,
    flags: ["dry-run", "expected-revision", "confirm"],
    usage: "networks remove ID|NAME [--dry-run] [--expected-revision REV] [--confirm]",
  },
  ...["connect", "disconnect", "reconnect"].map((verb): CommandSpec => ({
    name: `networks ${verb}`,
    min: 1,
    max: 1,
    flags: [],
    usage: `networks ${verb} ID|NAME`,
  })),
  {
    name: "channels join",
    min: 2,
    max: 2,
    flags: ["key"],
    usage: "channels join NETWORK CHANNEL [--key SECRET_REF]",
  },
  { name: "conversations list", min: 0, max: 0, flags: [], usage: "conversations list" },
  {
    name: "conversations query",
    min: 2,
    max: 2,
    flags: [],
    usage: "conversations query NETWORK NICK",
  },
  ...["activate", "close"].map((verb): CommandSpec => ({
    name: `conversations ${verb}`,
    min: 1,
    max: 1,
    flags: [],
    usage: `conversations ${verb} ID`,
  })),
  {
    name: "conversations mute",
    min: 1,
    max: 2,
    flags: ["unmute"],
    usage: "conversations mute ID [true|false] [--unmute]",
  },
  { name: "operations", min: 0, max: 0, flags: [], usage: "operations" },
  { name: "operations list", min: 0, max: 0, flags: [], usage: "operations list" },
  {
    name: "history search",
    min: 0,
    max: 0,
    flags: ["text", "network", "conversation", "sender", "after", "before", "cursor", "limit"],
    usage:
      "history search --text TEXT [--network ID|NAME] [--conversation ID] [--sender NICK] [--after MS] [--before MS] [--cursor CURSOR] [--limit N] --allow-read",
  },
  {
    name: "timeline get",
    min: 1,
    max: 1,
    flags: [],
    usage: "timeline get CONVERSATION_ID --allow-read",
  },
  { name: "discovery get", min: 1, max: 1, flags: [], usage: "discovery get NETWORK" },
  {
    name: "action",
    min: 0,
    max: 0,
    flags: ["file", "stdin", "confirm"],
    usage: "action --file ACTION.json | --stdin [--confirm]",
  },
  { name: "secrets store", min: 0, max: 0, flags: ["stdin"], usage: "secrets store --stdin" },
  {
    name: "shutdown",
    min: 0,
    max: 0,
    flags: ["confirm"],
    usage: "shutdown --allow-destructive --confirm",
  },
];

function error(code: ControlError["code"], message: string): ControlError {
  return { code, message, retryable: false };
}
function invalid(): ControlError {
  return error(
    "invalid-input",
    "Invalid control command or arguments; use --help for the command catalog.",
  );
}
class CliFailure extends Error {
  constructor(readonly detail: ControlError) {
    super(detail.message);
  }
}
function fail(detail = invalid()): never {
  throw new CliFailure(detail);
}
function specFor(command: readonly string[]): CommandSpec | undefined {
  return (
    COMMANDS.find((spec) => spec.name === command.slice(0, 2).join(" ")) ??
    COMMANDS.find((spec) => spec.name === command[0])
  );
}
function textFlag(parsed: ParsedControlCli, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}
function has(parsed: ParsedControlCli, name: string): boolean {
  return parsed.flags[name] === true;
}

/** Pure parser: never reads stdin/files, resolves config directories, or opens adapters. */
export function parseControlCli(args: readonly string[]): Result<ParsedControlCli, ControlError> {
  try {
    if (
      args.length > 256 ||
      args.reduce((size, arg) => size + Buffer.byteLength(arg, "utf8"), 0) > JSON_LIMIT
    )
      fail();
    const flags: Record<string, string | true> = Object.create(null);
    const command: string[] = [];
    let positionalOnly = false;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!;
      if (!positionalOnly && argument === "--") {
        positionalOnly = true;
      } else if (!positionalOnly && argument.startsWith("--")) {
        const equal = argument.indexOf("=");
        const name = argument.slice(2, equal < 0 ? undefined : equal);
        if (Object.hasOwn(flags, name)) fail();
        if (VALUE_FLAGS.has(name)) {
          const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
          if (value === undefined || value.length === 0 || value.startsWith("--")) fail();
          flags[name] = value;
        } else if (BOOLEAN_FLAGS.has(name) && equal < 0) {
          flags[name] = true;
        } else fail();
      } else command.push(argument);
    }
    const permissions: ControlPermission[] = [...DEFAULT_CONTROL_PERMISSIONS];
    if (flags["allow-read"]) permissions.push("read-messages");
    if (flags["allow-send"]) permissions.push("send-messages");
    if (flags["allow-destructive"]) permissions.push("destructive");
    const directory = flags["config-dir"];
    const parsed: ParsedControlCli = {
      ...(typeof directory === "string" ? { configDirectory: directory } : {}),
      permissions,
      command,
      flags,
    };
    if (has(parsed, "help")) return { ok: true, value: parsed };
    const spec = specFor(command);
    if (!spec) fail();
    const count = command.length - spec.name.split(" ").length;
    if (count < spec.min || count > spec.max) fail();
    for (const name of Object.keys(flags)) {
      if (name !== "config-dir" && !GLOBAL_FLAGS.includes(name) && !spec.flags.includes(name))
        fail();
    }
    const file = textFlag(parsed, "file");
    if (file !== undefined && has(parsed, "stdin")) fail();
    const source = file !== undefined || has(parsed, "stdin");
    if (["config plan", "config apply", "action", "networks update"].includes(spec.name) && !source)
      fail();
    if (spec.name === "secrets store" && !has(parsed, "stdin")) fail();
    if (spec.name === "history search" && textFlag(parsed, "text") === undefined) fail();
    if (
      spec.name === "conversations mute" &&
      command[3] !== undefined &&
      !["true", "false"].includes(command[3])
    )
      fail();
    if (spec.name === "conversations mute" && command[3] !== undefined && has(parsed, "unmute"))
      fail();
    if (spec.name === "networks add") {
      const construction = ["id", "name", "host", "nick", "port", "no-tls", "auto-connect"];
      if (source && construction.some((name) => Object.hasOwn(flags, name))) fail();
      if (!source && ["id", "name", "host", "nick"].some((name) => !textFlag(parsed, name))) fail();
    }
    return { ok: true, value: parsed };
  } catch (cause) {
    return { ok: false, error: cause instanceof CliFailure ? cause.detail : invalid() };
  }
}

function object(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item: unknown) => jsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, item]: [string, unknown]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && jsonValue(item, depth + 1),
  );
}
function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    fail(error("invalid-input", "Control input exceeds the byte limit."));
  }
  return value;
}
function parseJson(value: string): JsonValue {
  bounded(value, JSON_LIMIT);
  try {
    const result: unknown = JSON.parse(value);
    if (!jsonValue(result)) fail();
    return result;
  } catch {
    fail(error("invalid-input", "Invalid JSON control input."));
  }
}
function cancellation(): CliFailure {
  return new CliFailure(error("cancelled", "Control command cancelled."));
}
function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation();
}
/** Observe late reader rejections as well as racing cancellation; never submit their late values. */
async function cancellableRead(read: () => Promise<string>, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancellation());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      checkCancelled(signal);
      return read();
    });
    const value = await Promise.race([pending, aborted]);
    checkCancelled(signal);
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function readFileBounded(path: string, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  // Avoid blocking on a FIFO before we can reject non-regular inputs below.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    checkCancelled(signal);
    const stat = await file.stat();
    checkCancelled(signal);
    if (!stat.isFile())
      fail(
        error(
          "invalid-input",
          "Control input must be a regular file; use --stdin for redirected input.",
        ),
      );
    if (stat.size > JSON_LIMIT)
      fail(error("invalid-input", "Control input exceeds the byte limit."));
    const buffer = Buffer.alloc(JSON_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      checkCancelled(signal);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > JSON_LIMIT) fail(error("invalid-input", "Control input exceeds the byte limit."));
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
function readStdinBounded(limit: number, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const stdin = process.stdin;
  if (stdin.isTTY) fail(error("invalid-input", "Redirect stdin explicitly for control input."));
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(limit);
    const wasFlowing = stdin.readableFlowing;
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      stdin.removeListener("close", onClose);
      // Do not destroy shared stdin, alter its encoding, or pause another active consumer.
      if (wasFlowing !== true && stdin.listenerCount("data") === 0) stdin.pause();
    };
    const onError = (cause: unknown) => {
      if (settled) return;
      cleanup();
      reject(cause);
    };
    const onAbort = () => onError(cancellation());
    const onClose = () =>
      onError(new CliFailure(error("invalid-input", "Control input closed before completion.")));
    const onEnd = () => {
      if (settled) return;
      cleanup();
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
      } catch (cause) {
        reject(cause);
      }
    };
    const onData = (chunk: string | Uint8Array) => {
      if (settled) return;
      const size = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
      if (size > limit - bytes) {
        onError(new CliFailure(error("invalid-input", "Control input exceeds the byte limit.")));
        return;
      }
      buffer.set(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk, bytes);
      bytes += size;
    };
    if (stdin.readableEnded) {
      onEnd();
      return;
    }
    if (stdin.destroyed) {
      onClose();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.on("close", onClose);
    stdin.on("data", onData);
    if (signal.aborted) onAbort();
    else stdin.resume();
  });
}
function catalog(): JsonObject {
  return {
    protocolVersion: CONTROL_VERSION,
    commands: COMMANDS.map(({ name, usage }) => ({ name, usage })),
    globalOptions: [
      "--config-dir PATH",
      "--json",
      "--help",
      "--allow-read",
      "--allow-send",
      "--allow-destructive",
    ],
    defaultPermissions: [...DEFAULT_CONTROL_PERMISSIONS],
    permissionIntentOnly: true,
    limits: { jsonInputBytes: JSON_LIMIT, secretInputBytes: SECRET_LIMIT },
    secretInput:
      "stdin only; strips exactly one final LF or CRLF; never an argv value or password file",
    networkProfiles:
      "add/update --file accepts a full profile; arrays replace; selectors match ID before unique display name",
    networkDefaults:
      "add --id --name --host --nick uses TLS port 6697 (plaintext port 6667 with --no-tls), username/realname=nick, empty alternateNicks/autoJoin, autoConnect=false",
    revisions:
      "Mutations fetch config.get when needed; an explicit --expected-revision is never silently rebased. No retries.",
    confirmation:
      "--confirm attaches confirm:true; destructive changes also require --allow-destructive and server permission",
  };
}

/** JSON-only adapter. All application/config/transport work belongs to the injected executor. */
export async function runControlCli(
  args: readonly string[],
  options: ControlCliOptions,
): Promise<number> {
  const output = options.output ?? ((line: string) => console.log(line));
  const signal = options.signal ?? new AbortController().signal;
  const nextId = options.requestId ?? randomUUID;
  let finalId = "cli";
  let response: ControlResponse;
  try {
    const parsedResult = parseControlCli(args);
    if (!parsedResult.ok) fail(parsedResult.error);
    const parsed = parsedResult.value;
    if (signal.aborted) fail(error("cancelled", "Control command cancelled."));
    if (has(parsed, "help") || parsed.command[0] === "help") {
      response = { version: 1, id: finalId, ok: true, result: catalog() };
    } else {
      const spec = specFor(parsed.command)!;
      const positional = parsed.command.slice(spec.name.split(" ").length);
      const context: ControlCliContext =
        parsed.configDirectory === undefined ? {} : { configDirectory: parsed.configDirectory };
      const execute = async (
        method: ControlMethod,
        params: JsonObject = {},
      ): Promise<ControlResponse> => {
        if (signal.aborted) fail(error("cancelled", "Control command cancelled."));
        finalId = nextId();
        const request: ControlRequest = {
          version: 1,
          id: finalId,
          method,
          params,
          permissions: parsed.permissions,
        };
        try {
          return await options.execute(request, signal, context);
        } catch {
          fail({
            ...error(
              "unavailable",
              "Control execution failed; outcome may be unknown. No retry was attempted.",
            ),
            outcome: "unknown",
          });
        }
      };
      const required = (permission: ControlPermission): void => {
        if (!parsed.permissions.includes(permission))
          fail(
            error("permission-denied", "Explicit permission intent is required for this command."),
          );
      };
      const confirm = (): JsonObject => (has(parsed, "confirm") ? { confirm: true } : {});
      const source = async (): Promise<JsonValue> => {
        const file = textFlag(parsed, "file");
        const value =
          file === undefined || file === "-"
            ? await cancellableRead(
                options.input ?? (() => readStdinBounded(JSON_LIMIT, signal)),
                signal,
              )
            : await cancellableRead(
                () => (options.read ? options.read(file) : readFileBounded(file, signal)),
                signal,
              );
        return parseJson(value);
      };
      let document: JsonObject | undefined;
      const config = async (): Promise<JsonObject> => {
        if (document) return document;
        const result = await execute("config.get");
        if (!result.ok) fail(result.error);
        if (!object(result.result) || typeof result.result.revision !== "string") {
          fail(error("protocol", "Configuration response is invalid."));
        }
        document = result.result;
        return document;
      };
      const revision = async (): Promise<string> =>
        textFlag(parsed, "expected-revision") ?? String((await config()).revision);
      const profiles = async (): Promise<readonly JsonObject[]> => {
        const current = await config();
        if (!object(current.user) || !Array.isArray(current.user.networks))
          fail(error("protocol", "Configuration response is invalid."));
        const networks: JsonObject[] = [];
        for (const profile of current.user.networks) {
          if (
            !object(profile) ||
            typeof profile.id !== "string" ||
            typeof profile.name !== "string"
          )
            fail(error("protocol", "Configuration response is invalid."));
          networks.push(profile);
        }
        return networks;
      };
      const select = async (selector: string): Promise<JsonObject> => {
        const networks = await profiles();
        const byId = networks.find((profile) => profile.id === selector);
        if (byId) return byId;
        const matches = networks.filter((profile) => profile.name === selector);
        if (matches.length !== 1)
          fail(
            error("invalid-input", "Network selector is missing or ambiguous; use a profile ID."),
          );
        return matches[0]!;
      };
      const networkId = async (selector: string): Promise<JsonValue> =>
        (await select(selector)).id!;
      const dispatch = (action: JsonObject): Promise<ControlResponse> =>
        execute("action.dispatch", { action, ...confirm() });
      const save = async (edit: JsonObject, plan = false): Promise<ControlResponse> =>
        execute(plan || has(parsed, "dry-run") ? "config.plan" : "config.apply", {
          edit,
          expectedRevision: await revision(),
          ...confirm(),
        });
      switch (spec.name) {
        case "capabilities":
        case "status":
        case "config schema":
        case "config get":
        case "networks list":
        case "conversations list":
          response = await execute(
            (
              {
                capabilities: "capabilities",
                status: "status",
                "config schema": "config.schema",
                "config get": "config.get",
                "networks list": "networks.list",
                "conversations list": "conversations.list",
              } as const
            )[spec.name],
          );
          break;
        case "operations":
        case "operations list":
          response = await execute("operations.list");
          break;
        case "config plan":
        case "config apply": {
          const edit = await source();
          if (!object(edit)) fail();
          response = await save(edit, spec.name === "config plan");
          break;
        }
        case "config set": {
          const [path, value] = positional;
          const parts = path!.split(".");
          const section = parts.shift();
          if (
            !["user", "tui"].includes(section ?? "") ||
            parts.length === 0 ||
            parts.some(
              (part) =>
                !/^[a-zA-Z][a-zA-Z0-9]*$/.test(part) ||
                ["__proto__", "prototype", "constructor"].includes(part),
            )
          )
            fail();
          let patch: JsonValue = parseJson(value!);
          for (const part of parts.reverse()) patch = { [part]: patch };
          response = await save({ section: section!, patch });
          break;
        }
        case "config reload": {
          let expectedRevision = textFlag(parsed, "expected-revision");
          if (has(parsed, "dry-run")) {
            response = await execute("config.reload", {
              dryRun: true,
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
              ...confirm(),
            });
            break;
          }
          if (expectedRevision === undefined) {
            // config.get describes the live snapshot, not an externally edited disk revision.
            const inspected = await execute("config.reload", { dryRun: true });
            if (!inspected.ok) fail(inspected.error);
            if (
              !object(inspected.result) ||
              typeof inspected.result.revision !== "string" ||
              inspected.result.revision.length === 0
            )
              fail(error("protocol", "Configuration reload inspection response is invalid."));
            expectedRevision = inspected.result.revision;
          }
          response = await execute("config.reload", {
            dryRun: false,
            expectedRevision,
            ...confirm(),
          });
          break;
        }
        case "networks add":
        case "networks update":
        case "networks remove": {
          let profile: JsonObject | undefined;
          if (spec.name !== "networks remove") {
            if (textFlag(parsed, "file") !== undefined || has(parsed, "stdin")) {
              const input = await source();
              if (!object(input)) fail();
              profile = input;
            } else {
              const nick = textFlag(parsed, "nick")!;
              const tls = !has(parsed, "no-tls");
              const port = textFlag(parsed, "port");
              const portNumber = port === undefined ? (tls ? 6697 : 6667) : Number(port);
              if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) fail();
              profile = {
                id: textFlag(parsed, "id")!,
                name: textFlag(parsed, "name")!,
                endpoints: [{ host: textFlag(parsed, "host")!, port: portNumber, tls }],
                identity: { nick, alternateNicks: [], username: nick, realname: nick },
                autoConnect: has(parsed, "auto-connect"),
                autoJoin: [],
              };
            }
          }
          const networks = [...(await profiles())];
          if (spec.name === "networks add") {
            if (
              !profile ||
              typeof profile.id !== "string" ||
              networks.some((item) => item.id === profile.id)
            )
              fail();
            networks.push(profile);
          } else {
            const selected = await select(positional[0]!);
            const index = networks.findIndex((item) => item.id === selected.id);
            if (spec.name === "networks remove") networks.splice(index, 1);
            else {
              if (!profile || profile.id !== selected.id)
                fail(
                  error(
                    "invalid-input",
                    "A replacement profile must preserve the selected profile ID.",
                  ),
                );
              networks[index] = profile;
            }
          }
          response = await save({ section: "user", patch: { networks } });
          break;
        }
        case "networks connect":
        case "networks disconnect":
        case "networks reconnect":
          response = await dispatch({
            type: `network.${spec.name.split(" ")[1]}`,
            networkId: await networkId(positional[0]!),
          });
          break;
        case "channels join":
          response = await dispatch({
            type: "conversation.join",
            networkId: await networkId(positional[0]!),
            channel: positional[1]!,
            ...(textFlag(parsed, "key") === undefined ? {} : { key: textFlag(parsed, "key")! }),
          });
          break;
        case "conversations query":
          response = await dispatch({
            type: "conversation.query",
            networkId: await networkId(positional[0]!),
            nick: positional[1]!,
          });
          break;
        case "conversations activate":
        case "conversations close":
          response = await dispatch({
            type: `conversation.${spec.name.split(" ")[1]}`,
            conversationId: positional[0]!,
          });
          break;
        case "conversations mute":
          response = await dispatch({
            type: "conversation.mute",
            conversationId: positional[0]!,
            muted: positional[1] === undefined ? !has(parsed, "unmute") : positional[1] === "true",
          });
          break;
        case "timeline get":
          required("read-messages");
          response = await execute("timeline.get", { conversationId: positional[0]! });
          break;
        case "history search": {
          required("read-messages");
          const query: Record<string, JsonValue> = { text: textFlag(parsed, "text")!, limit: 50 };
          const keys = { conversation: "conversationId", sender: "sender", cursor: "cursor" };
          for (const [flag, key] of Object.entries(keys)) {
            const value = textFlag(parsed, flag);
            if (value !== undefined) query[key] = value;
          }
          for (const flag of ["after", "before", "limit"]) {
            const value = textFlag(parsed, flag);
            if (value === undefined) continue;
            const number = Number(value);
            if (!Number.isSafeInteger(number) || number < (flag === "limit" ? 1 : 0)) fail();
            query[flag] = number;
          }
          const network = textFlag(parsed, "network");
          if (network !== undefined) query.networkId = await networkId(network);
          response = await execute("history.search", query);
          break;
        }
        case "discovery get":
          response = await execute("discovery.get", { networkId: await networkId(positional[0]!) });
          break;
        case "action": {
          const action = await source();
          if (!object(action)) fail();
          response = await dispatch(action);
          break;
        }
        case "secrets store": {
          const input = bounded(
            await cancellableRead(
              options.input ?? (() => readStdinBounded(SECRET_LIMIT, signal)),
              signal,
            ),
            SECRET_LIMIT,
          );
          const value = input.endsWith("\r\n")
            ? input.slice(0, -2)
            : input.endsWith("\n")
              ? input.slice(0, -1)
              : input;
          if (value.length === 0) fail(error("invalid-input", "Secret input must not be empty."));
          response = await execute("secrets.store", { value });
          break;
        }
        case "shutdown":
          required("destructive");
          if (!has(parsed, "confirm"))
            fail(error("invalid-input", "Shutdown requires explicit confirmation."));
          response = await execute("app.shutdown", confirm());
          break;
        default:
          fail();
      }
    }
  } catch (cause) {
    response = {
      version: 1,
      id: finalId,
      ok: false,
      error:
        cause instanceof CliFailure
          ? cause.detail
          : error("invalid-input", "Unable to read or prepare control input."),
    };
  }
  output(JSON.stringify(response));
  return response.ok ? 0 : 1;
}
