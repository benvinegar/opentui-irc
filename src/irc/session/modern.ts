import type { AppError, OperationId, Result } from "../../contracts/common";
import type { FeatureSet } from "../../contracts/model";
import type { IrcFrame } from "../../contracts/protocol";
import type { SessionCommand, SessionPayload } from "../../contracts/session";
import { atom, failure, ok, plain, problem } from "./primitives";

/** Wire spellings pinned to ircv3/ircv3-specifications 9ff58d1342af67aff88753388f568542820c4bfe. */
export const modernProtocol = {
  history: "draft/chathistory",
  readMarker: "draft/read-marker",
  redaction: "draft/message-redaction",
  reply: "+reply",
  typing: "+typing",
  react: "+draft/react",
  unreact: "+draft/unreact",
} as const;
export interface ModernPolicy {
  readonly maxBatches: number;
  readonly maxBatchDepth: number;
  readonly maxBatchMessages: number;
  readonly maxBatchBytes: number;
  readonly maxHistoryMessages: number;
  readonly maxTypingEntries: number;
  readonly maxModernOperations: number;
  readonly queryTimeoutMs: number;
}
export const modernPolicyDefaults = {
  maxBatches: 32,
  maxBatchDepth: 8,
  maxBatchMessages: 1000,
  maxBatchBytes: 524_288,
  maxHistoryMessages: 100,
  maxTypingEntries: 1024,
  maxModernOperations: 128,
};
export const validServerId = (id: string) =>
  id.length > 0 &&
  id.length <= 512 &&
  !id.startsWith(":") &&
  !Array.from(id).some((c) => {
    const n = c.codePointAt(0)!;
    return n <= 32 || n === 127 || (n >= 128 && n <= 159);
  });
const timestamp = (value: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
};
const byteLength = (text: string) => new TextEncoder().encode(text).length;
// Only messages and their modern annotations are replayed; other playback is quarantined.
const PLAYBACK_COMMANDS = new Set(["PRIVMSG", "NOTICE", "TAGMSG", "REDACT"]);
const validTimestamp = (value: number) =>
  Number.isSafeInteger(value) && value >= -62_167_219_200_000 && value <= 253_402_300_799_999;
type History = {
  operationId: OperationId;
  target: string;
  limit: number;
  started: number;
  expired: boolean;
  label?: string;
  batch?: string;
  count: number;
  exhausted: boolean;
};
type Batch = {
  parent?: string;
  type: string;
  label?: string;
  history?: History;
  playback: boolean;
  started: number;
  count: number;
  bytes: number;
  depth: number;
};
type Typing = { target: string; nick: string; expires: number };
type Pending = { operationId: OperationId; started: number; command: SessionCommand["type"] };
type HistoryCommand = Extract<SessionCommand, { type: "history" }>;
interface Dependencies {
  readonly policy: ModernPolicy;
  readonly capabilities: () => ReadonlyMap<string, string | null>;
  readonly now: () => number;
  readonly fold: (value: string) => string;
  readonly self: (nick: string) => boolean;
  readonly emit: (payload: SessionPayload) => void;
  readonly changed: () => void;
  readonly fatal: (error: AppError) => void;
}

export function modernCapabilities(advertised: ReadonlyMap<string, string | null>): string[] {
  const desired: string[] = [];
  if (advertised.has("message-tags")) {
    if (
      advertised.has("batch") &&
      advertised.has("server-time") &&
      advertised.has(modernProtocol.history)
    )
      desired.push("batch", modernProtocol.history);
    if (advertised.has(modernProtocol.redaction)) desired.push(modernProtocol.redaction);
  }
  if (advertised.has("server-time") && advertised.has(modernProtocol.readMarker))
    desired.push(modernProtocol.readMarker);
  return desired;
}

/** Bounded IRCv3 state; historical state-changing events never enter live membership reducers. */
export class ModernSession {
  private readonly batches = new Map<string, Batch>();
  private readonly typing = new Map<string, Typing>();
  private readonly outgoingTyping = new Map<string, number>();
  private readonly typingWritten = new Map<string, number>();
  private readonly markers = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private history: History | undefined;
  private seenMessageId = false;
  private tagDeny: string[] = [];
  private historyMaximum: number;
  private referenceTypes = ["timestamp", "msgid"];
  private labelSequence = 0;
  constructor(private readonly deps: Dependencies) {
    this.historyMaximum = deps.policy.maxHistoryMessages;
  }
  private has(cap: string) {
    return this.deps.capabilities().has(cap);
  }
  private allowed(tag: string) {
    const name = tag.slice(1);
    return this.tagDeny[0] === "*"
      ? this.tagDeny.includes(`-${name}`)
      : !this.tagDeny.includes(name);
  }
  features(): FeatureSet {
    const tags = this.has("message-tags");
    const replies = tags && this.seenMessageId && this.allowed(modernProtocol.reply);
    return {
      history:
        tags && this.has("server-time") && this.has("batch") && this.has(modernProtocol.history),
      replies,
      typing: tags && this.allowed(modernProtocol.typing),
      reactions:
        replies && this.allowed(modernProtocol.react) && this.allowed(modernProtocol.unreact),
      readMarkers: this.has("server-time") && this.has(modernProtocol.readMarker),
      redaction: tags && this.has(modernProtocol.redaction),
      multiline: false,
    };
  }
  isupport(tokens: readonly string[]) {
    for (const token of tokens) {
      const split = token.indexOf("=");
      const name = split < 0 ? token : token.slice(0, split);
      const value = split < 0 ? "" : token.slice(split + 1);
      if (name === "CLIENTTAGDENY") {
        const entries = value ? value.split(",") : [];
        const names = entries.map((entry) => entry.replace(/^-/, ""));
        const valid =
          new Set(names).size === names.length &&
          entries.every((entry, index) =>
            entry === "*"
              ? index === 0
              : /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+$/.test(entry.replace(/^-/, "")) &&
                (!entry.startsWith("-") || entries[0] === "*"),
          );
        this.tagDeny = valid ? entries : ["*"];
      }
      if (name === "-CLIENTTAGDENY") this.tagDeny = [];
      if (name === "CHATHISTORY" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
        this.historyMaximum =
          Number(value) === 0
            ? this.deps.policy.maxHistoryMessages
            : Math.min(Number(value), this.deps.policy.maxHistoryMessages);
      if (name === "MSGREFTYPES")
        this.referenceTypes = value
          .split(",")
          .filter((type) => type === "timestamp" || type === "msgid");
    }
  }
  private batchFor(input: IrcFrame): Batch | undefined {
    return input.tags.batch ? this.batches.get(input.tags.batch) : undefined;
  }
  label(input: IrcFrame) {
    return input.tags.label ?? this.batchFor(input)?.label;
  }
  playback(input: IrcFrame) {
    return this.batchFor(input)?.playback ?? false;
  }
  private chain(input: IrcFrame): Batch[] {
    const result: Batch[] = [];
    let batch = this.batchFor(input);
    while (batch) {
      result.push(batch);
      batch = batch.parent ? this.batches.get(batch.parent) : undefined;
    }
    return result;
  }
  private overflow(message: string) {
    this.deps.fatal(problem("network", message));
    return true;
  }
  /** Returns true when the frame is fully handled here (or deliberately quarantined playback). */
  handle(input: IrcFrame, sender: string): boolean {
    if (input.tags.batch && !this.batches.has(input.tags.batch))
      return this.overflow("Unknown IRC batch reference.");
    const chain = this.chain(input);
    if (this.charge(chain, input)) return true;
    if (input.command === "BATCH") {
      this.batch(input);
      return true;
    }
    if (this.ownsFailure(input)) {
      this.serverFailure(input);
      return true;
    }
    if (input.command === "ACK") {
      this.completeLabel(input);
      return true;
    }
    const playback = chain.some((batch) => batch.playback);
    this.countHistory(chain, input);
    if (playback && !PLAYBACK_COMMANDS.has(input.command)) return true;
    switch (input.command) {
      case "TAGMSG":
        this.tagMessage(input, sender, playback);
        return true;
      case "MARKREAD":
        this.markRead(input);
        return true;
      case "REDACT":
        this.redact(input);
        return true;
      default:
        return false;
    }
  }
  /** Charges a frame to every enclosing batch; true once any exceeds its bounds. */
  private charge(chain: readonly Batch[], input: IrcFrame): boolean {
    const cost = byteLength(JSON.stringify(input));
    for (const batch of chain) {
      batch.count++;
      batch.bytes += cost;
      if (
        batch.count > this.deps.policy.maxBatchMessages ||
        batch.bytes > this.deps.policy.maxBatchBytes
      )
        return this.overflow("IRC batch exceeded its configured bounds.");
    }
    return false;
  }
  /** FAIL always, and error numerics only when labeled for one of our modern operations. */
  private ownsFailure(input: IrcFrame): boolean {
    if (input.command === "FAIL") return true;
    const label = this.label(input);
    return /^[45][0-9]{2}$/.test(input.command) && !!label && this.pending.has(label);
  }
  private countHistory(chain: readonly Batch[], input: IrcFrame) {
    const query = chain.find((batch) => batch.history)?.history;
    if (
      query &&
      (input.command === "PRIVMSG" || input.command === "NOTICE") &&
      !("draft/chathistory-context" in input.tags)
    )
      query.count++;
  }
  private tagMessage(input: IrcFrame, sender: string, playback: boolean) {
    if (!this.has("message-tags")) return;
    if (!playback) this.typingFrame(input, sender);
    this.reaction(input, sender);
  }
  /** Read markers only move forwards; a malformed or unavailable marker still completes its label. */
  private markRead(input: IrcFrame) {
    const [target, value] = input.params;
    const time = value?.startsWith("timestamp=") ? timestamp(value.slice(10)) : undefined;
    if (this.features().readMarkers && target && atom(target) && time !== undefined) {
      const key = this.deps.fold(target);
      const previous = this.markers.get(key);
      if (previous === undefined && this.markers.size >= this.deps.policy.maxModernOperations) {
        this.overflow("IRC read-marker limit exceeded.");
        return;
      }
      if (previous === undefined || time > previous) {
        this.markers.set(key, time);
        this.deps.emit({ type: "read-marker", target: plain(target), serverTime: time });
      }
    }
    this.completeLabel(input);
  }
  private redact(input: IrcFrame) {
    const [target, id] = input.params;
    if (this.features().redaction && target && atom(target) && id && validServerId(id))
      this.deps.emit({ type: "redaction", target: plain(target), serverId: id });
    this.completeLabel(input);
  }
  private batch(input: IrcFrame) {
    if (!this.has("batch")) {
      this.overflow("Received an unnegotiated IRC batch.");
      return;
    }
    const id = input.params[0];
    if (!id || !/^[+-][A-Za-z0-9_-]{1,128}$/.test(id)) {
      this.overflow("Malformed IRC batch identifier.");
      return;
    }
    if (id.startsWith("+")) this.openBatch(input, id.slice(1));
    else this.closeBatch(id.slice(1));
  }
  private openBatch(input: IrcFrame, reference: string) {
    const type = input.params[1];
    if (!type || this.batches.has(reference) || this.batches.size >= this.deps.policy.maxBatches) {
      this.overflow("Invalid or excessive IRC batches.");
      return;
    }
    const parent = this.batchFor(input);
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.deps.policy.maxBatchDepth) {
      this.overflow("IRC batch nesting limit exceeded.");
      return;
    }
    const label = input.tags.label ?? parent?.label;
    const batch: Batch = {
      type,
      ...(input.tags.batch ? { parent: input.tags.batch } : {}),
      ...(label ? { label } : {}),
      playback: type === "chathistory" || (parent?.playback ?? false),
      started: this.deps.now(),
      count: 0,
      bytes: 0,
      depth,
    };
    if (type === "chathistory" && !this.claimHistory(input, reference, batch)) return;
    this.batches.set(reference, batch);
  }
  /** Binds the pending history query this batch answers; false after a malformed target. */
  private claimHistory(input: IrcFrame, reference: string, batch: Batch): boolean {
    const target = input.params[2];
    if (!target || !atom(target)) {
      this.overflow("Malformed chat history batch target.");
      return false;
    }
    const query = this.history;
    if (
      query &&
      !query.batch &&
      this.deps.fold(query.target) === this.deps.fold(target) &&
      (!query.label || batch.label === query.label)
    ) {
      query.batch = reference;
      query.exhausted = "draft/chathistory-end" in input.tags;
      batch.history = query;
    }
    return true;
  }
  private closeBatch(reference: string) {
    const batch = this.batches.get(reference);
    if (!batch || [...this.batches.values()].some((child) => child.parent === reference)) {
      this.overflow("Malformed IRC batch ending.");
      return;
    }
    this.batches.delete(reference);
    if (batch.history) this.finishHistory(batch.history);
    if (batch.label && batch.type === "labeled-response") this.pending.delete(batch.label);
  }
  private finishHistory(query: History) {
    if (!query.expired)
      this.deps.emit({
        type: "history-complete",
        operationId: query.operationId,
        target: plain(query.target),
        hasMore: !query.exhausted && query.count > 0,
      });
    if (query.label) this.pending.delete(query.label);
    if (this.history === query) this.history = undefined;
  }
  observeChat(input: IrcFrame, sender: string, target: string) {
    const id = input.tags.msgid;
    if (this.has("message-tags") && id && validServerId(id) && !this.seenMessageId) {
      this.seenMessageId = true;
      this.deps.changed();
    }
    if (!this.playback(input)) this.clearTyping(sender, target);
    if (this.has("message-tags")) this.reaction(input, sender);
  }
  private typingKey(target: string, nick: string) {
    return `${this.deps.fold(target)}\0${this.deps.fold(nick)}`;
  }
  private typingFrame(input: IrcFrame, nick: string) {
    const target = input.params[0];
    const value = input.tags[modernProtocol.typing];
    if (
      !target ||
      !atom(target) ||
      !atom(nick) ||
      this.deps.self(nick) ||
      !["active", "paused", "done"].includes(value ?? "")
    )
      return;
    const key = this.typingKey(target, nick);
    if (value === "done") {
      this.clearTyping(nick, target);
      return;
    }
    if (!this.typing.has(key) && this.typing.size >= this.deps.policy.maxTypingEntries) {
      this.overflow("IRC typing state limit exceeded.");
      return;
    }
    this.typing.set(key, {
      target,
      nick,
      expires: this.deps.now() + (value === "paused" ? 30_000 : 6000),
    });
    this.deps.emit({ type: "typing", target: plain(target), nick: plain(nick), active: true });
  }
  clearTyping(nick: string, target?: string) {
    for (const [key, entry] of this.typing)
      if (
        this.deps.fold(entry.nick) === this.deps.fold(nick) &&
        (target === undefined || this.deps.fold(entry.target) === this.deps.fold(target))
      ) {
        this.typing.delete(key);
        this.deps.emit({
          type: "typing",
          target: plain(entry.target),
          nick: plain(entry.nick),
          active: false,
        });
      }
  }
  private reaction(input: IrcFrame, nick: string) {
    const target = input.params[0];
    const id = input.tags[modernProtocol.reply];
    const react = input.tags[modernProtocol.react];
    const unreact = input.tags[modernProtocol.unreact];
    if (
      !target ||
      !atom(target) ||
      !atom(nick) ||
      !id ||
      !validServerId(id) ||
      (react !== undefined && unreact !== undefined)
    )
      return;
    const value = react ?? unreact;
    if (!value || byteLength(value) > 128 || !plain(value)) return;
    this.deps.emit({
      type: "reaction",
      target: plain(target),
      serverId: id,
      nick: plain(nick),
      value: plain(value),
      remove: unreact !== undefined,
    });
  }
  admit(command: SessionCommand, operationId: OperationId): Result<void> {
    const features = this.features();
    switch (command.type) {
      case "history":
        if (!features.history) return failure("unsupported", "Server chat history is unavailable.");
        return this.admitHistory(command, operationId);
      case "typing":
        if (!features.typing) return failure("unsupported", "Typing indicators are unavailable.");
        return this.admitTyping(command.target);
      case "reaction":
        if (!features.reactions)
          return failure("unsupported", "Reactions require message IDs and permitted client tags.");
        if (
          !atom(command.target) ||
          !validServerId(command.serverId) ||
          !command.value ||
          byteLength(command.value) > 128 ||
          plain(command.value) !== command.value
        )
          return failure("invalid-input", "Invalid reaction.");
        return ok();
      case "redact":
        if (!features.redaction) return failure("unsupported", "Message redaction is unavailable.");
        if (!atom(command.target) || !validServerId(command.serverId))
          return failure("invalid-input", "Invalid redaction target.");
        return ok();
      case "mark-read":
        if (!features.readMarkers)
          return failure("unsupported", "Synchronized read markers are unavailable.");
        return this.admitReadMarker(command.target, command.serverTime);
      default:
        return ok();
    }
  }
  private admitHistory(command: HistoryCommand, operationId: OperationId): Result<void> {
    if (
      !atom(command.target) ||
      !Number.isInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > this.historyMaximum
    )
      return failure(
        "invalid-input",
        `History requests must have a valid target and a limit between 1 and ${this.historyMaximum}.`,
      );
    if (this.history) return failure("conflict", "Another history request is still active.");
    if (command.before) {
      const reference = this.admitReference(command.before);
      if (!reference.ok) return reference;
    }
    this.history = {
      operationId,
      target: command.target,
      limit: command.limit,
      started: Infinity,
      expired: false,
      count: 0,
      exhausted: false,
    };
    return ok();
  }
  /** History anchors must use a reference type the server advertised in MSGREFTYPES. */
  private admitReference(before: NonNullable<HistoryCommand["before"]>): Result<void> {
    if ("serverId" in before)
      return validServerId(before.serverId) && this.referenceTypes.includes("msgid")
        ? ok()
        : failure("invalid-input", "A supported history message reference is required.");
    return validTimestamp(before.serverTime) && this.referenceTypes.includes("timestamp")
      ? ok()
      : failure("invalid-input", "A supported history timestamp reference is required.");
  }
  private admitTyping(target: string): Result<void> {
    if (!atom(target)) return failure("invalid-input", "Invalid typing target.");
    const key = this.deps.fold(target);
    if (this.deps.now() - (this.outgoingTyping.get(key) ?? -Infinity) < 3000)
      return failure(
        "rate-limited",
        "Typing updates are limited to one every three seconds per target.",
      );
    if (
      !this.outgoingTyping.has(key) &&
      this.outgoingTyping.size >= this.deps.policy.maxTypingEntries
    )
      return failure("rate-limited", "Too many typing targets.");
    this.outgoingTyping.set(key, this.deps.now());
    return ok();
  }
  private admitReadMarker(target: string, serverTime: number): Result<void> {
    if (!atom(target) || !validTimestamp(serverTime))
      return failure("invalid-input", "Invalid read marker.");
    if (serverTime < (this.markers.get(this.deps.fold(target)) ?? -Infinity))
      return failure("conflict", "Read markers cannot move backwards.");
    return ok();
  }
  validateFrame(output: IrcFrame): Result<void> {
    const features = this.features();
    const unavailable =
      (output.command === "CHATHISTORY" && !features.history) ||
      (output.command === "REDACT" && !features.redaction) ||
      (output.command === "MARKREAD" && !features.readMarkers) ||
      (output.tags[modernProtocol.reply] !== undefined && !features.replies) ||
      (output.tags[modernProtocol.typing] !== undefined && !features.typing) ||
      ((output.tags[modernProtocol.react] !== undefined ||
        output.tags[modernProtocol.unreact] !== undefined) &&
        !features.reactions);
    if (unavailable)
      return failure("unsupported", "The negotiated IRC feature is no longer available.");
    if (
      output.tags[modernProtocol.typing] !== undefined &&
      output.params[0] &&
      this.typingTooSoon(output.params[0])
    )
      return failure(
        "rate-limited",
        "Typing updates cannot be written within three seconds of one another.",
      );
    return ok();
  }
  private typingTooSoon(target: string) {
    return this.deps.now() - (this.typingWritten.get(this.deps.fold(target)) ?? -Infinity) < 3000;
  }
  private output(
    command: string,
    params: readonly string[],
    tags: Readonly<Record<string, string | null>> = {},
  ): IrcFrame {
    return { command, params, tags };
  }
  async perform(
    command: SessionCommand,
    operationId: OperationId,
    write: (frame: IrcFrame) => Promise<Result<void>>,
  ): Promise<Result<void>> {
    if (!this.stillAvailable(command)) {
      this.failedAdmission(command, operationId);
      return failure("unsupported", "This IRC feature is no longer available.");
    }
    if (command.type === "typing" && this.typingTooSoon(command.target))
      return failure(
        "rate-limited",
        "Typing updates cannot be written within three seconds of one another.",
      );
    let output = this.request(command);
    if (!output) return failure("unsupported", "This IRC command is unavailable.");
    let label: string | undefined;
    if (this.has("labeled-response")) {
      if (this.pending.size >= this.deps.policy.maxModernOperations) {
        this.failedAdmission(command, operationId);
        return failure("rate-limited", "Too many active modern IRC operations.");
      }
      label = this.labelOperation(command, operationId);
      output = { ...output, tags: { ...output.tags, label } };
    }
    if (command.type === "history" && this.history) this.history.started = this.deps.now();
    const result = await write(output);
    if (result.ok && command.type === "typing")
      this.typingWritten.set(this.deps.fold(command.target), this.deps.now());
    if (!result.ok) {
      if (label) this.pending.delete(label);
      this.failedAdmission(command, operationId);
    }
    return result;
  }
  /** Capabilities can be withdrawn (CAP DEL) between admission and the paced write. */
  private stillAvailable(command: SessionCommand): boolean {
    const features = this.features();
    const required: Partial<Record<SessionCommand["type"], boolean>> = {
      history: features.history,
      typing: features.typing,
      reaction: features.reactions,
      redact: features.redaction,
      "mark-read": features.readMarkers,
    };
    return required[command.type] !== false;
  }
  private request(command: SessionCommand): IrcFrame | undefined {
    switch (command.type) {
      case "history":
        return this.historyRequest(command);
      case "typing":
        return this.output("TAGMSG", [command.target], {
          [modernProtocol.typing]: command.active ? "active" : command.paused ? "paused" : "done",
        });
      case "reaction":
        return this.output("TAGMSG", [command.target], {
          [modernProtocol.reply]: command.serverId,
          [command.remove ? modernProtocol.unreact : modernProtocol.react]: command.value,
        });
      case "redact":
        return this.output("REDACT", [command.target, command.serverId]);
      case "mark-read":
        return this.output("MARKREAD", [
          command.target,
          `timestamp=${new Date(command.serverTime).toISOString()}`,
        ]);
      default:
        return undefined;
    }
  }
  private historyRequest(command: HistoryCommand): IrcFrame {
    const reference = command.before
      ? "serverId" in command.before
        ? `msgid=${command.before.serverId}`
        : `timestamp=${new Date(command.before.serverTime).toISOString()}`
      : "*";
    return this.output("CHATHISTORY", [
      command.before ? "BEFORE" : "LATEST",
      command.target,
      reference,
      String(command.limit),
    ]);
  }
  /** Tracks a labeled-response operation so its reply, FAIL or timeout can be correlated. */
  private labelOperation(command: SessionCommand, operationId: OperationId): string {
    const label = `oi-modern-${++this.labelSequence}`;
    this.pending.set(label, { operationId, command: command.type, started: this.deps.now() });
    if (command.type === "history" && this.history?.operationId === operationId)
      this.history.label = label;
    return label;
  }
  private failedAdmission(command: SessionCommand, operationId: OperationId) {
    if (command.type === "history" && this.history?.operationId === operationId)
      this.history = undefined;
  }
  private completeLabel(input: IrcFrame) {
    const label = this.label(input);
    if (label) this.pending.delete(label);
  }
  private serverFailure(input: IrcFrame) {
    const label = this.label(input);
    const pending = label ? this.pending.get(label) : undefined;
    if (pending) {
      this.deps.emit({
        type: "error",
        operationId: pending.operationId,
        error: problem("unavailable", "Server rejected a modern IRC operation."),
      });
      this.pending.delete(label!);
    }
    if (
      (input.params[0] === "CHATHISTORY" || pending?.command === "history") &&
      this.history &&
      (!this.history.label || label === this.history.label)
    ) {
      if (!pending)
        this.deps.emit({
          type: "error",
          operationId: this.history.operationId,
          error: problem("unavailable", "Server rejected the history request."),
        });
      if (this.history.batch) this.history.expired = true;
      else this.history = undefined;
    } else if (!pending)
      this.deps.emit({
        type: "error",
        error: problem("unavailable", "Server rejected an IRC operation."),
      });
  }
  tick(now: number) {
    for (const batch of this.batches.values())
      if (now - batch.started >= this.deps.policy.queryTimeoutMs) {
        this.overflow("IRC batch timed out.");
        return;
      }
    if (
      this.history &&
      !this.history.expired &&
      now - this.history.started >= this.deps.policy.queryTimeoutMs
    ) {
      this.history.expired = true;
      this.deps.emit({
        type: "error",
        operationId: this.history.operationId,
        error: problem(
          "unavailable",
          "History request timed out; waiting for its batch terminator.",
        ),
      });
    }
    for (const [key, entry] of this.typing)
      if (now >= entry.expires) {
        this.typing.delete(key);
        this.deps.emit({
          type: "typing",
          target: plain(entry.target),
          nick: plain(entry.nick),
          active: false,
        });
      }
    for (const [key, time] of this.outgoingTyping)
      if (now - time >= 3000) this.outgoingTyping.delete(key);
    for (const [key, time] of this.typingWritten)
      if (now - time >= 3000) this.typingWritten.delete(key);
    for (const [label, operation] of this.pending)
      if (now - operation.started >= this.deps.policy.queryTimeoutMs) {
        this.pending.delete(label);
        if (operation.command === "redact" || operation.command === "mark-read")
          this.deps.emit({
            type: "error",
            operationId: operation.operationId,
            error: problem("unavailable", "Modern IRC operation outcome was not observed."),
          });
      }
  }
  hasOperation(operationId: OperationId) {
    return (
      this.history?.operationId === operationId ||
      [...this.pending.values()].some((entry) => entry.operationId === operationId)
    );
  }
  close(emitFailures: boolean) {
    if (emitFailures && this.history && !this.history.expired)
      this.deps.emit({
        type: "error",
        operationId: this.history.operationId,
        error: problem("network", "Connection closed during history request."),
      });
    if (emitFailures) {
      const notified = new Set<OperationId>(this.history ? [this.history.operationId] : []);
      for (const entry of this.pending.values())
        if (!notified.has(entry.operationId)) {
          notified.add(entry.operationId);
          this.deps.emit({
            type: "error",
            operationId: entry.operationId,
            error: problem(
              "network",
              "Connection closed before the modern IRC operation outcome was observed.",
            ),
          });
        }
    }
    this.batches.clear();
    this.typing.clear();
    this.typingWritten.clear();
    this.outgoingTyping.clear();
    this.pending.clear();
    this.markers.clear();
    this.history = undefined;
  }
}
