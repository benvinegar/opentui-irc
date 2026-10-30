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

const PERMISSION_FLAGS: readonly (readonly [string, ControlPermission])[] = [
  ["allow-read", "read-messages"],
  ["allow-send", "send-messages"],
  ["allow-destructive", "destructive"],
];
const SOURCE_COMMANDS = ["config plan", "config apply", "action", "networks update"];
const NETWORK_FIELDS = ["id", "name", "host", "nick", "port", "no-tls", "auto-connect"];
const REQUIRED_NETWORK_FIELDS = ["id", "name", "host", "nick"];
type CommandRule = (parsed: ParsedControlCli, source: boolean) => boolean;
/** Command-specific constraints beyond positional arity and the flag allowlist. */
const COMMAND_RULES = new Map<string, CommandRule>([
  ...SOURCE_COMMANDS.map((name): [string, CommandRule] => [name, (_parsed, source) => source]),
  ["secrets store", (parsed) => has(parsed, "stdin")],
  ["history search", (parsed) => textFlag(parsed, "text") !== undefined],
  [
    "conversations mute",
    (parsed) => {
      const muted = parsed.command[3];
      return muted === undefined || (["true", "false"].includes(muted) && !has(parsed, "unmute"));
    },
  ],
  [
    "networks add",
    // A profile comes from either a full JSON source or construction flags, never both.
    (parsed, source) =>
      source
        ? !NETWORK_FIELDS.some((name) => Object.hasOwn(parsed.flags, name))
        : REQUIRED_NETWORK_FIELDS.every((name) => Boolean(textFlag(parsed, name))),
  ],
]);

/** Store one `--flag`, `--flag=value` or `--flag value`; returns the last consumed index. */
function readFlag(
  flags: Record<string, string | true>,
  args: readonly string[],
  index: number,
): number {
  const argument = args[index]!;
  const equal = argument.indexOf("=");
  const name = argument.slice(2, equal < 0 ? undefined : equal);
  if (Object.hasOwn(flags, name)) fail();
  if (VALUE_FLAGS.has(name)) {
    const next = equal < 0 ? index + 1 : index;
    const value = equal < 0 ? args[next] : argument.slice(equal + 1);
    if (value === undefined || value.length === 0 || value.startsWith("--")) fail();
    flags[name] = value;
    return next;
  }
  if (!BOOLEAN_FLAGS.has(name) || equal >= 0) fail();
  flags[name] = true;
  return index;
}
function tokenize(args: readonly string[]): Pick<ParsedControlCli, "command" | "flags"> {
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
    if (positionalOnly || !argument.startsWith("--")) command.push(argument);
    else if (argument === "--") positionalOnly = true;
    else index = readFlag(flags, args, index);
  }
  return { command, flags };
}
function validateCommand(parsed: ParsedControlCli): void {
  const spec = specFor(parsed.command);
  if (!spec) fail();
  const count = parsed.command.length - spec.name.split(" ").length;
  if (count < spec.min || count > spec.max) fail();
  for (const name of Object.keys(parsed.flags)) {
    if (name !== "config-dir" && !GLOBAL_FLAGS.includes(name) && !spec.flags.includes(name)) fail();
  }
  const file = textFlag(parsed, "file");
  if (file !== undefined && has(parsed, "stdin")) fail();
  const source = file !== undefined || has(parsed, "stdin");
  const rule = COMMAND_RULES.get(spec.name);
  if (rule && !rule(parsed, source)) fail();
}

/** Pure parser: never reads stdin/files, resolves config directories, or opens adapters. */
export function parseControlCli(args: readonly string[]): Result<ParsedControlCli, ControlError> {
  try {
    const { command, flags } = tokenize(args);
    const permissions: ControlPermission[] = [...DEFAULT_CONTROL_PERMISSIONS];
    for (const [flag, permission] of PERMISSION_FLAGS)
      if (flags[flag]) permissions.push(permission);
    const directory = flags["config-dir"];
    const parsed: ParsedControlCli = {
      ...(typeof directory === "string" ? { configDirectory: directory } : {}),
      permissions,
      command,
      flags,
    };
    if (!has(parsed, "help")) validateCommand(parsed);
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

function invalidConfig(): never {
  return fail(error("protocol", "Configuration response is invalid."));
}

/** One CLI invocation: request IDs, permission intent, input sources and a cached config read. */
class ControlCliRun {
  /** ID of the latest submitted request; a failure is reported against it. */
  id = "cli";
  readonly positional: readonly string[];
  private document: JsonObject | undefined;

  constructor(
    readonly parsed: ParsedControlCli,
    readonly spec: CommandSpec,
    private readonly options: ControlCliOptions,
    private readonly signal: AbortSignal,
  ) {
    this.positional = parsed.command.slice(spec.name.split(" ").length);
  }

  text(name: string): string | undefined {
    return textFlag(this.parsed, name);
  }
  has(name: string): boolean {
    return has(this.parsed, name);
  }
  hasSource(): boolean {
    return this.text("file") !== undefined || this.has("stdin");
  }
  confirm(): JsonObject {
    return this.has("confirm") ? { confirm: true } : {};
  }
  required(permission: ControlPermission): void {
    if (!this.parsed.permissions.includes(permission))
      fail(error("permission-denied", "Explicit permission intent is required for this command."));
  }

  async execute(method: ControlMethod, params: JsonObject = {}): Promise<ControlResponse> {
    if (this.signal.aborted) fail(error("cancelled", "Control command cancelled."));
    const nextId = this.options.requestId ?? randomUUID;
    this.id = nextId();
    const request: ControlRequest = {
      version: 1,
      id: this.id,
      method,
      params,
      permissions: this.parsed.permissions,
    };
    const context: ControlCliContext =
      this.parsed.configDirectory === undefined
        ? {}
        : { configDirectory: this.parsed.configDirectory };
    try {
      return await this.options.execute(request, this.signal, context);
    } catch {
      fail({
        ...error(
          "unavailable",
          "Control execution failed; outcome may be unknown. No retry was attempted.",
        ),
        outcome: "unknown",
      });
    }
  }
  dispatch(action: JsonObject): Promise<ControlResponse> {
    return this.execute("action.dispatch", { action, ...this.confirm() });
  }
  async save(edit: JsonObject, plan = false): Promise<ControlResponse> {
    return this.execute(plan || this.has("dry-run") ? "config.plan" : "config.apply", {
      edit,
      expectedRevision: await this.revision(),
      ...this.confirm(),
    });
  }

  /** Read JSON from `--file PATH`, or stdin for `--file -` and `--stdin`. */
  async source(): Promise<JsonValue> {
    const { options, signal } = this;
    const file = this.text("file");
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
  }
  async sourceObject(): Promise<JsonObject> {
    const value = await this.source();
    if (!object(value)) fail();
    return value;
  }
  async secret(): Promise<string> {
    const { options, signal } = this;
    return bounded(
      await cancellableRead(
        options.input ?? (() => readStdinBounded(SECRET_LIMIT, signal)),
        signal,
      ),
      SECRET_LIMIT,
    );
  }

  async config(): Promise<JsonObject> {
    if (this.document) return this.document;
    const result = await this.execute("config.get");
    if (!result.ok) fail(result.error);
    if (!object(result.result) || typeof result.result.revision !== "string") invalidConfig();
    this.document = result.result;
    return this.document;
  }
  async revision(): Promise<string> {
    return this.text("expected-revision") ?? String((await this.config()).revision);
  }
  async profiles(): Promise<readonly JsonObject[]> {
    const current = await this.config();
    if (!object(current.user) || !Array.isArray(current.user.networks)) invalidConfig();
    const networks: JsonObject[] = [];
    for (const profile of current.user.networks) {
      if (!object(profile) || typeof profile.id !== "string" || typeof profile.name !== "string")
        invalidConfig();
      networks.push(profile);
    }
    return networks;
  }
  /** Selectors match a profile ID before a unique display name. */
  async select(selector: string): Promise<JsonObject> {
    const networks = await this.profiles();
    const byId = networks.find((profile) => profile.id === selector);
    if (byId) return byId;
    const matches = networks.filter((profile) => profile.name === selector);
    if (matches.length !== 1)
      fail(error("invalid-input", "Network selector is missing or ambiguous; use a profile ID."));
    return matches[0]!;
  }
  async networkId(selector: string): Promise<JsonValue> {
    return (await this.select(selector)).id!;
  }
}

type CommandHandler = (run: ControlCliRun) => Promise<ControlResponse>;

/** Parameterless commands that map directly onto one control method. */
const DIRECT_METHODS: readonly (readonly [string, ControlMethod])[] = [
  ["capabilities", "capabilities"],
  ["status", "status"],
  ["config schema", "config.schema"],
  ["config get", "config.get"],
  ["networks list", "networks.list"],
  ["conversations list", "conversations.list"],
  ["operations", "operations.list"],
  ["operations list", "operations.list"],
];

async function configSet(run: ControlCliRun): Promise<ControlResponse> {
  const [path, value] = run.positional;
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
  return run.save({ section: section!, patch });
}

async function configReload(run: ControlCliRun): Promise<ControlResponse> {
  const expectedRevision = run.text("expected-revision");
  if (run.has("dry-run"))
    return run.execute("config.reload", {
      dryRun: true,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...run.confirm(),
    });
  return run.execute("config.reload", {
    dryRun: false,
    expectedRevision: expectedRevision ?? (await diskRevision(run)),
    ...run.confirm(),
  });
}
/** config.get describes the live snapshot, not an externally edited disk revision. */
async function diskRevision(run: ControlCliRun): Promise<string> {
  const inspected = await run.execute("config.reload", { dryRun: true });
  if (!inspected.ok) fail(inspected.error);
  if (
    !object(inspected.result) ||
    typeof inspected.result.revision !== "string" ||
    inspected.result.revision.length === 0
  )
    fail(error("protocol", "Configuration reload inspection response is invalid."));
  return inspected.result.revision;
}

/** A full profile from `--file`/`--stdin`, or one built from construction flags with defaults. */
async function inputProfile(run: ControlCliRun): Promise<JsonObject> {
  if (run.hasSource()) return run.sourceObject();
  const nick = run.text("nick")!;
  const tls = !run.has("no-tls");
  const port = run.text("port");
  const portNumber = port === undefined ? (tls ? 6697 : 6667) : Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) fail();
  return {
    id: run.text("id")!,
    name: run.text("name")!,
    endpoints: [{ host: run.text("host")!, port: portNumber, tls }],
    identity: { nick, alternateNicks: [], username: nick, realname: nick },
    autoConnect: run.has("auto-connect"),
    autoJoin: [],
  };
}
async function networksAdd(run: ControlCliRun): Promise<ControlResponse> {
  const profile = await inputProfile(run);
  const networks = [...(await run.profiles())];
  if (typeof profile.id !== "string" || networks.some((item) => item.id === profile.id)) fail();
  networks.push(profile);
  return run.save({ section: "user", patch: { networks } });
}
async function networksUpdate(run: ControlCliRun): Promise<ControlResponse> {
  const profile = await inputProfile(run);
  const networks = [...(await run.profiles())];
  const selected = await run.select(run.positional[0]!);
  const index = networks.findIndex((item) => item.id === selected.id);
  if (profile.id !== selected.id)
    fail(error("invalid-input", "A replacement profile must preserve the selected profile ID."));
  networks[index] = profile;
  return run.save({ section: "user", patch: { networks } });
}
async function networksRemove(run: ControlCliRun): Promise<ControlResponse> {
  const networks = [...(await run.profiles())];
  const selected = await run.select(run.positional[0]!);
  networks.splice(
    networks.findIndex((item) => item.id === selected.id),
    1,
  );
  const exclusions = await remainingExclusions(run, networks);
  return run.save({
    section: "user",
    patch: {
      networks,
      ...(exclusions === undefined ? {} : { history: { excludedConversations: exclusions } }),
    },
  });
}
/** History exclusions that still name a remaining profile, if the config declares any. */
async function remainingExclusions(
  run: ControlCliRun,
  networks: readonly JsonObject[],
): Promise<JsonValue[] | undefined> {
  const current = await run.config();
  const history =
    object(current.user) && object(current.user.history) ? current.user.history : undefined;
  const exclusions = history?.excludedConversations;
  if (exclusions === undefined) return undefined;
  if (
    !Array.isArray(exclusions) ||
    exclusions.some((rule) => !object(rule) || typeof rule.networkId !== "string")
  )
    invalidConfig();
  return exclusions.filter(
    (rule) => object(rule) && networks.some((network) => network.id === rule.networkId),
  );
}

async function historySearch(run: ControlCliRun): Promise<ControlResponse> {
  run.required("read-messages");
  const query: Record<string, JsonValue> = { text: run.text("text")!, limit: 50 };
  const keys = { conversation: "conversationId", sender: "sender", cursor: "cursor" };
  for (const [flag, key] of Object.entries(keys)) {
    const value = run.text(flag);
    if (value !== undefined) query[key] = value;
  }
  for (const flag of ["after", "before", "limit"]) {
    const value = run.text(flag);
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (flag === "limit" ? 1 : 0)) fail();
    query[flag] = number;
  }
  const network = run.text("network");
  if (network !== undefined) query.networkId = await run.networkId(network);
  return run.execute("history.search", query);
}

/** Strips exactly one final LF or CRLF. */
async function secretsStore(run: ControlCliRun): Promise<ControlResponse> {
  const input = await run.secret();
  const value = input.endsWith("\r\n")
    ? input.slice(0, -2)
    : input.endsWith("\n")
      ? input.slice(0, -1)
      : input;
  if (value.length === 0) fail(error("invalid-input", "Secret input must not be empty."));
  return run.execute("secrets.store", { value });
}

const networkAction =
  (verb: string): CommandHandler =>
  async (run) =>
    run.dispatch({
      type: `network.${verb}`,
      networkId: await run.networkId(run.positional[0]!),
    });
const conversationAction =
  (verb: string): CommandHandler =>
  (run) =>
    run.dispatch({ type: `conversation.${verb}`, conversationId: run.positional[0]! });

const HANDLERS = new Map<string, CommandHandler>([
  ...DIRECT_METHODS.map(([name, method]): [string, CommandHandler] => [
    name,
    (run) => run.execute(method),
  ]),
  ["config plan", async (run) => run.save(await run.sourceObject(), true)],
  ["config apply", async (run) => run.save(await run.sourceObject())],
  ["config set", configSet],
  ["config reload", configReload],
  ["networks add", networksAdd],
  ["networks update", networksUpdate],
  ["networks remove", networksRemove],
  ["networks connect", networkAction("connect")],
  ["networks disconnect", networkAction("disconnect")],
  ["networks reconnect", networkAction("reconnect")],
  [
    "channels join",
    async (run) => {
      const key = run.text("key");
      return run.dispatch({
        type: "conversation.join",
        networkId: await run.networkId(run.positional[0]!),
        channel: run.positional[1]!,
        ...(key === undefined ? {} : { key }),
      });
    },
  ],
  [
    "conversations query",
    async (run) =>
      run.dispatch({
        type: "conversation.query",
        networkId: await run.networkId(run.positional[0]!),
        nick: run.positional[1]!,
      }),
  ],
  ["conversations activate", conversationAction("activate")],
  ["conversations close", conversationAction("close")],
  [
    "conversations mute",
    (run) => {
      const [conversationId, muted] = run.positional;
      return run.dispatch({
        type: "conversation.mute",
        conversationId: conversationId!,
        muted: muted === undefined ? !run.has("unmute") : muted === "true",
      });
    },
  ],
  [
    "timeline get",
    (run) => {
      run.required("read-messages");
      return run.execute("timeline.get", { conversationId: run.positional[0]! });
    },
  ],
  ["history search", historySearch],
  [
    "discovery get",
    async (run) =>
      run.execute("discovery.get", { networkId: await run.networkId(run.positional[0]!) }),
  ],
  ["action", async (run) => run.dispatch(await run.sourceObject())],
  ["secrets store", secretsStore],
  [
    "shutdown",
    (run) => {
      run.required("destructive");
      if (!run.has("confirm"))
        fail(error("invalid-input", "Shutdown requires explicit confirmation."));
      return run.execute("app.shutdown", run.confirm());
    },
  ],
]);

/** JSON-only adapter. All application/config/transport work belongs to the injected executor. */
export async function runControlCli(
  args: readonly string[],
  options: ControlCliOptions,
): Promise<number> {
  const output = options.output ?? ((line: string) => console.log(line));
  const signal = options.signal ?? new AbortController().signal;
  let run: ControlCliRun | undefined;
  let response: ControlResponse;
  try {
    const parsed = parseControlCli(args);
    if (!parsed.ok) fail(parsed.error);
    if (signal.aborted) fail(error("cancelled", "Control command cancelled."));
    if (has(parsed.value, "help") || parsed.value.command[0] === "help") {
      response = { version: 1, id: "cli", ok: true, result: catalog() };
    } else {
      const spec = specFor(parsed.value.command)!;
      const handler = HANDLERS.get(spec.name);
      if (!handler) fail();
      run = new ControlCliRun(parsed.value, spec, options, signal);
      response = await handler(run);
    }
  } catch (cause) {
    response = {
      version: 1,
      id: run?.id ?? "cli",
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
