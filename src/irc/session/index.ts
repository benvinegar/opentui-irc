/* eslint-disable no-control-regex -- Validate wire identifiers before publishing sanitized semantic events. */
import type { AppError, Clock, OperationId, Result } from "../../contracts/common";
import type { UserDetails } from "../../contracts/discovery";
import type { ConnectionPhase } from "../../contracts/model";
import type { IrcCodec, IrcFrame, ProtocolLimits, ProtocolSupport } from "../../contracts/protocol";
import type {
  IrcSession,
  SessionCommand,
  SessionFactory,
  SessionIdentity,
  SessionPayload,
  ChatEnvelope,
} from "../../contracts/session";
import type { NetworkProfile, SecretProvider } from "../../contracts/settings";
import type { ByteConnection, TransportFactory } from "../../contracts/transport";
import { foldIdentifier } from "../../domain/irc-identifiers";
import { createIrcCodec } from "../codec";
import {
  atom,
  content,
  eventStream,
  failure,
  ok,
  plain,
  plainMultiline,
  problem,
} from "./primitives";
import { splitMessage } from "./split-message";
import {
  ModernSession,
  modernCapabilities,
  modernPolicyDefaults,
  modernProtocol,
  validServerId,
} from "./modern";
import type { ModernPolicy } from "./modern";

/** Informational replies whose text is written for humans; other numerics stay opaque. */
const READABLE_NUMERICS = new Set([
  "001",
  "002",
  "003",
  "251",
  "252",
  "253",
  "254",
  "255",
  "265",
  "266",
  "372",
  "375",
  "376",
  "396",
  "900",
  "901",
]);

// Reliable own-message echo needs every one of these; echo-message alone is never used.
const ECHO_DEPENDENCIES = ["message-tags", "batch", "labeled-response", "echo-message"];
// Machine-oriented replies (server info, channel modes/creation, topic setter/URL) with no prose for people.
const QUIET_NUMERICS = new Set(["004", "042", "324", "328", "329", "333"]);
// Prose whose leading parameters only repeat our own identity.
const TRAILING_NUMERICS = new Set(["900", "901"]);
/** Friendly text for common rejection numerics; others report their code. */
const REJECTIONS: Readonly<Record<string, string>> = {
  "401": "No such nickname or channel.",
  "402": "No such server.",
  "403": "The channel does not exist.",
  "404": "You cannot send to this channel.",
  "405": "You have joined too many channels.",
  "406": "There was no such nickname.",
  "411": "No recipient was given.",
  "412": "No text to send.",
  "432": "The nickname is invalid.",
  "437": "The channel is temporarily unavailable.",
  "442": "You are not joined to this channel.",
  "471": "The channel is full.",
  "473": "The channel requires an invitation.",
  "474": "You are banned from this channel.",
  "475": "A valid channel key is required.",
  "476": "The channel name is invalid.",
  "477": "The channel requires an authenticated account.",
  "481": "You need IRC operator privileges.",
  "482": "You do not have permission to change this channel.",
};

export interface SessionPolicy extends ModernPolicy {
  readonly connectTimeoutMs: number;
  readonly registrationTimeoutMs: number;
  readonly capTimeoutMs: number;
  readonly floodIntervalMs: number;
  readonly keepaliveMs: number;
  readonly staleTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly quitTimeoutMs: number;
  readonly maxEvents: number;
  readonly maxQueueCommands: number;
  readonly maxQueueBytes: number;
  readonly maxQueueFragments: number;
  readonly maxSendBytes: number;
  readonly maxSendFragments: number;
  readonly maxPendingSends: number;
  readonly maxChannels: number;
  readonly maxMembers: number;
  readonly maxDirectoryItems: number;
}
export interface SessionFactoryOptions {
  readonly transport: TransportFactory;
  readonly secrets: SecretProvider;
  readonly clock: Clock;
  readonly codecFactory?: (limits: ProtocolLimits) => IrcCodec;
  readonly limits?: ProtocolLimits;
  readonly policy?: Partial<SessionPolicy>;
}
export const defaultProtocolLimits: ProtocolLimits = {
  maxCommandBytes: 512,
  maxTagBytes: 8192,
  maxBufferedBytes: 16_384,
};
export const defaultSessionPolicy: SessionPolicy = {
  ...modernPolicyDefaults,
  connectTimeoutMs: 15_000,
  registrationTimeoutMs: 30_000,
  capTimeoutMs: 5_000,
  floodIntervalMs: 750,
  keepaliveMs: 60_000,
  staleTimeoutMs: 120_000,
  queryTimeoutMs: 30_000,
  quitTimeoutMs: 250,
  maxEvents: 2048,
  maxQueueCommands: 128,
  maxQueueBytes: 262_144,
  maxQueueFragments: 512,
  maxSendBytes: 131_072,
  maxSendFragments: 256,
  maxPendingSends: 256,
  maxChannels: 128,
  maxMembers: 20_000,
  maxDirectoryItems: 5000,
};
const frame = (
  command: string,
  params: readonly string[],
  tags: Readonly<Record<string, string | null>> = {},
): IrcFrame => ({ command, params, tags });
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const isCasemapping = (value: string): value is ProtocolSupport["casemapping"] =>
  value === "ascii" || value === "rfc1459" || value === "strict-rfc1459";
/** Applies one validated ISUPPORT token; malformed or unrelated tokens leave support unchanged. */
function withSupportToken(
  support: ProtocolSupport,
  name: string | undefined,
  value: string,
): ProtocolSupport {
  switch (name) {
    case "CASEMAPPING":
      return isCasemapping(value) ? { ...support, casemapping: value } : support;
    case "CHANTYPES":
      return value && /^[^\s\x00-\x1f,]+$/.test(value)
        ? { ...support, channelTypes: plain(value) }
        : support;
    case "PREFIX": {
      // An explicitly empty PREFIX means the network has no member prefixes at all.
      const match = /^(?:\(([a-zA-Z]+)\)([^\s]+))?$/.exec(value);
      if (!match || (match[1] ?? "").length !== (match[2] ?? "").length) return support;
      return { ...support, prefixModes: match[1] ?? "", prefixSymbols: plain(match[2] ?? "") };
    }
    case "CHANMODES": {
      const groups = value.split(",");
      if (groups.length !== 4 || !groups.every((group) => /^[a-zA-Z]*$/.test(group)))
        return support;
      return { ...support, channelModeGroups: [groups[0]!, groups[1]!, groups[2]!, groups[3]!] };
    }
    default:
      return support;
  }
}
type Member = { nick: string; prefixes: string[] };
type Channel = {
  name: string;
  members: Map<string, Member>;
  names?: Map<string, Member>;
  touched: Set<string>;
};
type Send = {
  operationId: OperationId;
  target: string;
  kind: "text" | "action" | "notice";
  text: string;
  fragments: number;
  written: number;
  started: boolean;
  echoes: Map<string, ChatEnvelope>;
  labels: Set<string>;
  updatedAt: number;
  expectsEcho: boolean;
  replyToServerId?: string;
};
type Queued = {
  command: SessionCommand;
  operationId: OperationId;
  bytes: number;
  fragments: number;
};
type Whois = {
  operationId: OperationId;
  nick: string;
  details: UserDetails;
  started: number;
  expired: boolean;
};
type Directory = { operationId: OperationId; count: number; started: number; expired: boolean };
type SendCommand = Extract<SessionCommand, { type: "send" }>;
/** Estimated outgoing queue footprint of an admitted command. */
type Cost = { bytes: number; fragments: number; emptyLines: number };
const queueCost = (bytes: number, fragments = 1, emptyLines = 0): Result<Cost> => ({
  ok: true,
  value: { bytes: 32 + bytes, fragments, emptyLines },
});
/** Handles one inbound command; a returned promise is awaited before the next frame. */
type Handler = (input: IrcFrame, sender: string) => Promise<unknown> | void;

export function createSessionFactory(options: SessionFactoryOptions): SessionFactory {
  const policy = { ...defaultSessionPolicy, ...options.policy };
  for (const [key, value] of Object.entries(policy)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "floodIntervalMs" ? 0 : 1) ||
      value > 100_000_000
    )
      throw new TypeError("Invalid IRC session policy");
  }
  if (policy.staleTimeoutMs <= policy.keepaliveMs)
    throw new TypeError("Invalid IRC keepalive policy");
  const limits = { ...(options.limits ?? defaultProtocolLimits) };
  const codecFactory = options.codecFactory ?? createIrcCodec;
  return {
    async open(profile, identity, signal) {
      if (signal.aborted) return failure("cancelled", "Connection cancelled.");
      if (
        identity.networkId !== profile.id ||
        !Number.isSafeInteger(identity.generation) ||
        identity.generation < 1 ||
        !profile.endpoints.length ||
        !atom(profile.identity.nick) ||
        !atom(profile.identity.username) ||
        !profile.identity.alternateNicks.every(atom) ||
        !content(profile.identity.realname) ||
        (profile.sasl &&
          (profile.sasl.mechanism !== "PLAIN" ||
            !content(profile.sasl.account) ||
            !profile.sasl.account))
      )
        return failure("invalid-input", "Invalid IRC profile or attempt identity.");
      const endpoint = profile.endpoints[0]!;
      if ((profile.sasl || profile.serverPassword) && !endpoint.tls)
        return failure("authentication", "Credentials require a verified TLS connection.");
      const codec = codecFactory(limits);
      const ownedProfile: NetworkProfile = {
        ...profile,
        endpoints: profile.endpoints.map((entry) => ({ ...entry })),
        identity: { ...profile.identity, alternateNicks: [...profile.identity.alternateNicks] },
        autoJoin: profile.autoJoin.map((entry) => ({ ...entry })),
        ...(profile.sasl ? { sasl: { ...profile.sasl } } : {}),
      };
      const attempt = new Attempt(
        options,
        policy,
        codec,
        limits,
        ownedProfile,
        { ...identity },
        signal,
      );
      queueMicrotask(() => {
        void attempt.start();
      });
      return { ok: true, value: attempt.session };
    },
  };
}

class Attempt {
  readonly session: IrcSession;
  private readonly controller = new AbortController();
  private readonly stream;
  private connection: ByteConnection | undefined;
  private stopped = false;
  private shuttingDown = false;
  private closing: Promise<Result<void>> | undefined;
  private ready = false;
  private secure: boolean;
  private authenticated = false;
  private nick: string;
  private alternate = 0;
  private phase: ConnectionPhase = "connecting";
  private readonly queue: Queued[] = [];
  private queueBytes = 0;
  private queueFragments = 0;
  private draining = false;
  private nextWriteAt = 0;
  private readonly sends = new Map<OperationId, Send>();
  private readonly labels = new Map<string, Send>();
  private labelSequence = 0;
  // Conservative until the server reveals our complete nick!ident@host prefix.
  private ownPrefixBytes = 128;
  private readonly modern: ModernSession;
  private readonly channels = new Map<string, Channel>();
  private readonly advertised = new Map<string, string | null>();
  private readonly capabilities = new Map<string, string | null>();
  private readonly requested = new Set<string>();
  private capEnded = false;
  private capLsComplete = false;
  private capStartedAt: number | undefined;
  private saslStarted = false;
  private saslSent = false;
  private support: ProtocolSupport = {
    casemapping: "rfc1459",
    channelTypes: "#&",
    prefixModes: "ov",
    prefixSymbols: "@+",
    channelModeGroups: ["b", "k", "l", "imnpst"],
    capabilities: {},
  };
  /** ISUPPORT STATUSMSG: member prefixes that may address part of a channel (`@#room`). */
  private statusPrefixes = "";
  private whois: Whois | undefined;
  private directory: Directory | undefined;
  private readonly handlers = this.routes();
  private lastReceived: number;
  private pingSentAt: number | undefined;
  private readonly startedAt: number;
  private readonly abortParent: () => void;
  constructor(
    private readonly options: SessionFactoryOptions,
    private readonly policy: SessionPolicy,
    private readonly codec: IrcCodec,
    private readonly limits: ProtocolLimits,
    private readonly profile: NetworkProfile,
    identity: SessionIdentity,
    private readonly parent: AbortSignal,
  ) {
    this.nick = profile.identity.nick;
    this.secure = profile.endpoints[0]!.tls;
    this.lastReceived = this.startedAt = options.clock.now();
    this.stream = eventStream(identity, policy.maxEvents, () =>
      this.stop(problem("unavailable", "Session event buffer overflow."), true),
    );
    this.modern = new ModernSession({
      policy,
      capabilities: () => this.capabilities,
      now: () => options.clock.now(),
      fold: (value) => this.fold(value),
      self: (value) => this.self(value),
      emit: (payload) => {
        if (this.stopped) this.stream.emit(payload, true);
        else this.emit(payload);
      },
      changed: () => this.publishSupport(),
      fatal: (error) => this.stop(error),
    });
    this.abortParent = () => this.stop(problem("cancelled", "Connection cancelled."));
    parent.addEventListener("abort", this.abortParent, { once: true });
    this.session = {
      identity,
      events: this.stream.events,
      execute: (command, operationId, signal) => this.execute(command, operationId, signal),
      close: (reason) => this.close(reason),
    };
  }
  private emit(payload: SessionPayload) {
    if (!this.stopped) this.stream.emit(payload);
  }
  private state(phase: ConnectionPhase) {
    this.phase = phase;
    this.emit({
      type: "state",
      phase,
      nick: plain(this.nick),
      secure: this.secure,
      authenticated: this.authenticated,
    });
  }
  private publishSupport() {
    this.support = { ...this.support, capabilities: Object.fromEntries(this.capabilities) };
    this.emit({ type: "support", support: { ...this.support }, features: this.modern.features() });
  }
  private close(reason?: string): Promise<Result<void>> {
    if (this.closing) return this.closing;
    if (this.stopped) return Promise.resolve(ok());
    this.shuttingDown = true;
    this.ready = false;
    this.closing = (async () => {
      const timeout = new AbortController();
      try {
        if (this.connection && this.phase === "ready") {
          const quit = this.codec.encode(
            frame("QUIT", [
              reason && content(reason) && byteLength(reason) <= 200 ? reason : "opentui-irc",
            ]),
          );
          if (quit.ok)
            await Promise.race([
              this.connection.write(quit.value, this.controller.signal).catch(() => {}),
              this.options.clock.sleep(this.policy.quitTimeoutMs, timeout.signal).catch(() => {}),
            ]);
        }
      } catch {
        /* QUIT is best effort and must not prevent cleanup. */
      } finally {
        timeout.abort();
        this.stop();
      }
      return ok();
    })();
    return this.closing;
  }
  private stop(error?: AppError, overflow = false) {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.controller.abort();
    this.parent.removeEventListener("abort", this.abortParent);
    if (error) this.stream.emit({ type: "error", error }, true);
    // Overflow reserves terminal outcomes only; otherwise preserve individual operation outcomes.
    if (!overflow) {
      for (const send of this.sends.values())
        this.stream.emit(
          {
            type: "send-state",
            operationId: send.operationId,
            state: send.started ? "uncertain" : "failed",
            error:
              error ?? problem("network", "Connection closed before send outcome was established."),
          },
          true,
        );
      for (const item of this.queue)
        if (item.command.type !== "send")
          this.stream.emit(
            {
              type: "error",
              operationId: item.operationId,
              error: problem("network", "Connection closed before operation completed."),
            },
            true,
          );
      for (const query of [this.whois, this.directory])
        if (query && !query.expired)
          this.stream.emit(
            {
              type: "error",
              operationId: query.operationId,
              error: problem("network", "Connection closed during query."),
            },
            true,
          );
    }
    this.sends.clear();
    this.labels.clear();
    this.modern.close(!overflow);
    this.queue.length = 0;
    this.queueBytes = 0;
    this.queueFragments = 0;
    this.channels.clear();
    this.whois = undefined;
    this.directory = undefined;
    this.stream.emit(
      {
        type: "state",
        phase: "disconnected",
        nick: plain(this.nick),
        secure: this.secure,
        authenticated: this.authenticated,
      },
      true,
    );
    this.stream.finish();
    void this.connection?.close().catch(() => {});
  }
  private async write(output: IrcFrame): Promise<Result<void>> {
    if (this.stopped || !this.connection) return failure("network", "Connection is closed.");
    const encoded = this.codec.encode(output);
    if (!encoded.ok) return encoded;
    try {
      return await this.connection.write(encoded.value, this.controller.signal);
    } catch {
      return failure("network", "Socket write failed.");
    }
  }
  private async control(command: string, params: readonly string[]): Promise<boolean> {
    const result = await this.write(frame(command, params));
    if (!result.ok && !this.stopped)
      this.stop(problem(result.error.code, "IRC control write failed."));
    return result.ok;
  }
  async start() {
    if (this.stopped) return;
    try {
      this.state("connecting");
      void this.monitor();
      const endpoint = this.profile.endpoints[0]!;
      const result = await this.options.transport.connect(
        { ...endpoint, timeoutMs: this.policy.connectTimeoutMs },
        this.controller.signal,
      );
      if (!result.ok) {
        this.stop(result.error);
        return;
      }
      this.connection = result.value;
      if (this.stopped) {
        await this.connection.close();
        return;
      }
      this.state("registering");
      if (this.profile.serverPassword) {
        const password = await this.options.secrets.resolve(
          this.profile.serverPassword,
          this.controller.signal,
        );
        if (!password.ok || !content(password.value)) {
          this.stop(problem("authentication", "Server password is unavailable or invalid."));
          return;
        }
        if (!(await this.control("PASS", [password.value]))) return;
      }
      this.capStartedAt = this.options.clock.now();
      if (!(await this.control("CAP", ["LS", "302"]))) return;
      if (!(await this.control("NICK", [this.nick]))) return;
      if (
        !(await this.control("USER", [
          this.profile.identity.username,
          "0",
          "*",
          this.profile.identity.realname,
        ]))
      )
        return;
      for await (const bytes of this.connection.incoming) {
        if (this.stopped) break;
        this.lastReceived = this.options.clock.now();
        const decoded = this.codec.push(bytes);
        if (!decoded.ok) {
          this.stop(decoded.error);
          return;
        }
        for (const incoming of decoded.value) {
          await this.handle(incoming);
          if (this.stopped) return;
        }
      }
      if (!this.stopped) {
        const ended = this.codec.finish();
        this.stop(ended.ok ? problem("network", "Server closed the connection.") : ended.error);
      }
    } catch {
      if (!this.stopped) this.stop(problem("network", "IRC connection failed."));
    }
  }
  private async monitor() {
    const signal = this.controller.signal;
    try {
      while (!signal.aborted) {
        await this.options.clock.sleep(
          Math.min(
            1000,
            this.policy.keepaliveMs,
            this.policy.registrationTimeoutMs,
            this.policy.capTimeoutMs,
          ),
          signal,
        );
        if (signal.aborted || this.shuttingDown) return;
        if (!(await this.watch(this.options.clock.now()))) return;
      }
    } catch {
      if (!signal.aborted) this.stop(problem("internal", "IRC clock failed."));
    }
  }
  /** One monitor pass over every deadline; false once the attempt has stopped. */
  private async watch(now: number): Promise<boolean> {
    if (!this.ready && now - this.startedAt >= this.policy.registrationTimeoutMs) {
      this.stop(problem("network", "IRC registration timed out."));
      return false;
    }
    if (
      !this.capEnded &&
      !this.saslStarted &&
      this.capStartedAt !== undefined &&
      now - this.capStartedAt >= this.policy.capTimeoutMs
    ) {
      this.emit({
        type: "notice",
        text: "Capability negotiation timed out; trying basic IRC registration.",
      });
      await this.endCap();
      if (this.stopped) return false;
    }
    if (
      this.pingSentAt !== undefined &&
      now - this.pingSentAt >= this.policy.staleTimeoutMs - this.policy.keepaliveMs
    ) {
      this.stop(problem("network", "IRC keepalive timed out."));
      return false;
    }
    if (
      this.connection &&
      now - this.lastReceived >= this.policy.keepaliveMs &&
      this.pingSentAt === undefined
    ) {
      this.pingSentAt = now;
      await this.control("PING", [`openirc-${now}`]);
    }
    this.expireQueries(now);
    this.expireSends(now);
    this.modern.tick(now);
    return true;
  }
  private expireQueries(now: number) {
    for (const query of [this.whois, this.directory])
      if (query && !query.expired && now - query.started >= this.policy.queryTimeoutMs) {
        query.expired = true;
        this.emit({
          type: "error",
          operationId: query.operationId,
          error: problem(
            "unavailable",
            "IRC query timed out; waiting for its terminator before another query.",
          ),
        });
      }
  }
  /** Fully written sends whose echo never arrived are released as uncertain. */
  private expireSends(now: number) {
    for (const send of this.sends.values())
      if (
        send.fragments > 0 &&
        send.written === send.fragments &&
        now - send.updatedAt >= this.policy.queryTimeoutMs
      ) {
        if (send.expectsEcho)
          this.emit({
            type: "send-state",
            operationId: send.operationId,
            state: "uncertain",
            error: problem("unavailable", "Server echo was not observed."),
          });
        this.forgetSend(send);
      }
  }
  private fold(value: string) {
    return foldIdentifier(value, this.support.casemapping);
  }
  private self(value: string) {
    return this.fold(value) === this.fold(this.nick);
  }
  private async endCap() {
    if (this.capEnded) return;
    if (this.profile.sasl?.required && !this.authenticated) {
      this.stop(problem("authentication", "Required SASL authentication was not completed."));
      return;
    }
    this.capEnded = true;
    await this.control("CAP", ["END"]);
    this.publishSupport();
  }
  private async saslFailed() {
    this.emit({ type: "error", error: problem("authentication", "SASL authentication failed.") });
    if (this.profile.sasl?.required)
      this.stop(problem("authentication", "Required SASL authentication failed."));
    else await this.endCap();
  }
  /** Capabilities worth requesting from what the server currently advertises. */
  private wantedCapabilities(): string[] {
    const wanted = [
      "message-tags",
      "server-time",
      "multi-prefix",
      "account-tag",
      "account-notify",
      "extended-join",
      "away-notify",
      "cap-notify",
    ];
    if (ECHO_DEPENDENCIES.every((name) => this.advertised.has(name)))
      wanted.push(...ECHO_DEPENDENCIES);
    // SASL is only part of registration; re-authenticating a live session is unsupported.
    if (
      !this.capEnded &&
      this.profile.sasl &&
      this.advertised.has("sasl") &&
      (this.advertised.get("sasl") === null ||
        this.advertised.get("sasl")?.split(",").includes("PLAIN"))
    )
      wanted.push("sasl");
    wanted.push(...modernCapabilities(this.advertised));
    return [...new Set(wanted)].filter((name) => this.advertised.has(name));
  }
  /** Records advertised tokens; returns the names, or undefined after stopping on overflow. */
  private advertise(list: string): string[] | undefined {
    const names: string[] = [];
    for (const token of list.split(" ").filter(Boolean)) {
      const [name, ...value] = token.split("=");
      if (!name) continue;
      if (!this.advertised.has(name) && this.advertised.size >= 128) {
        this.stop(problem("network", "Too many IRC capabilities."));
        return undefined;
      }
      this.advertised.set(name, value.length ? value.join("=") : null);
      names.push(name);
    }
    return names;
  }
  private async cap(input: IrcFrame) {
    const sub = input.params[1];
    const list = input.params.at(-1) ?? "";
    // After registration only cap-notify updates (NEW/DEL) and answers to our requests matter.
    if (this.capEnded && !["NEW", "DEL", "ACK", "NAK"].includes(sub ?? "")) return;
    if (sub === "LS") await this.capList(list, input.params[2] === "*");
    else if (sub === "ACK" || sub === "NAK") await this.capAnswer(sub === "ACK", list);
    else if (sub === "NEW") await this.capNew(list);
    else if (sub === "DEL") await this.capDel(list);
  }
  private async capList(list: string, more: boolean) {
    if (!this.advertise(list) || more) return;
    this.capLsComplete = true;
    for (const name of this.wantedCapabilities()) this.requested.add(name);
    if (this.profile.sasl?.required && !this.requested.has("sasl")) {
      this.stop(
        problem("authentication", "Server does not offer required SASL PLAIN authentication."),
      );
      return;
    }
    if (this.requested.size) await this.control("CAP", ["REQ", [...this.requested].join(" ")]);
    else await this.endCap();
  }
  private async capAnswer(ack: boolean, list: string) {
    let answered = false;
    for (const token of list.split(" ")) {
      const name = token.replace(/^-/, "").split("=")[0]!;
      if (!this.requested.has(name)) continue;
      answered = true;
      this.requested.delete(name);
      if (ack && !token.startsWith("-"))
        this.capabilities.set(name, this.advertised.get(name) ?? null);
      else this.capabilities.delete(name);
    }
    if (answered && !this.requested.size && this.capLsComplete) await this.capsSettled();
  }
  /** Every outstanding request is answered: continue to SASL, end CAP, or publish live changes. */
  private async capsSettled() {
    await this.dropUnreliableEcho();
    if (this.capEnded) this.publishSupport();
    else if (this.profile.sasl && this.capabilities.has("sasl") && !this.saslStarted) {
      this.saslStarted = true;
      this.state("authenticating");
      await this.control("AUTHENTICATE", ["PLAIN"]);
    } else if (!this.saslStarted || this.authenticated) await this.endCap();
  }
  private async capNew(list: string) {
    const added = this.advertise(list);
    if (!added || !this.capLsComplete) return;
    // A newly offered dependency can make the whole reliable-echo set worth requesting.
    const echoUnlocked = added.some((name) => ECHO_DEPENDENCIES.includes(name));
    const request = this.wantedCapabilities().filter(
      (name) =>
        !this.capabilities.has(name) &&
        !this.requested.has(name) &&
        (added.includes(name) || (echoUnlocked && ECHO_DEPENDENCIES.includes(name))),
    );
    if (!request.length) return;
    for (const name of request) this.requested.add(name);
    await this.control("CAP", ["REQ", request.join(" ")]);
  }
  private async capDel(list: string) {
    for (const name of list.split(" ")) {
      this.capabilities.delete(name);
      this.advertised.delete(name);
    }
    await this.dropUnreliableEcho();
    this.publishSupport();
  }
  /** Do not expose/use echo until reliable correlation dependencies are ACKed. */
  private async dropUnreliableEcho() {
    if (
      !this.capabilities.has("echo-message") ||
      ECHO_DEPENDENCIES.every((name) => this.capabilities.has(name))
    )
      return;
    this.capabilities.delete("echo-message");
    await this.control("CAP", ["REQ", "-echo-message"]);
  }
  private async authenticate(input: IrcFrame) {
    if (!this.saslStarted || this.saslSent || input.params[0] !== "+" || !this.profile.sasl) {
      this.stop(problem("authentication", "Unexpected SASL challenge."));
      return;
    }
    this.saslSent = true;
    const password = await this.options.secrets.resolve(
      this.profile.sasl.password,
      this.controller.signal,
    );
    if (!password.ok || !content(password.value)) {
      this.stop(problem("authentication", "SASL credentials are unavailable or invalid."));
      return;
    }
    const account = this.profile.sasl.account;
    const bytes = new TextEncoder().encode(`${account}\0${account}\0${password.value}`);
    if (bytes.length > 16_384) {
      this.stop(problem("authentication", "SASL credentials exceed the supported size."));
      return;
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    for (let offset = 0; offset < encoded.length; offset += 400)
      if (!(await this.control("AUTHENTICATE", [encoded.slice(offset, offset + 400)]))) return;
    if (encoded.length % 400 === 0) await this.control("AUTHENTICATE", ["+"]);
  }
  private async handle(input: IrcFrame) {
    const sender = input.prefix?.split("!")[0] ?? "";
    if (input.prefix?.includes("!") && this.self(sender))
      this.ownPrefixBytes = byteLength(input.prefix) + 2;
    if (this.rejectedFragment(input)) return;
    if (this.modern.handle(input, sender) || this.stopped) return;
    const handler = this.handlers.get(input.command);
    if (!handler) {
      this.reply(input);
      return;
    }
    const pending = handler(input, sender);
    if (pending) await pending;
  }
  /** Command and numeric handlers; anything absent falls back to generic numeric replies. */
  private routes(): Map<string, Handler> {
    const routes = new Map<string, Handler>();
    const on = (commands: string, handler: Handler) => {
      for (const command of commands.split(" ")) routes.set(command, handler);
    };
    on("PING", ({ params }) => this.control("PONG", params));
    on("PONG", ({ params }) => {
      if (params.at(-1) === `openirc-${this.pingSentAt}`) this.pingSentAt = undefined;
    });
    on("CAP", (input) => this.cap(input));
    on("AUTHENTICATE", (input) => this.authenticate(input));
    on("903", () => this.saslSucceeded());
    on("904 905 906 907", () => this.saslFailed());
    on("001", ({ params }) => this.registered(params[0]));
    on("005", ({ params }) => this.isupport(params.slice(1, -1)));
    on("432 433 436 437", (input) => this.nickRejected(input));
    on("421", ({ params }) => {
      if (!this.ready && params[1]?.toUpperCase() === "CAP") return this.endCap();
      this.emit({ type: "notice", text: "Server does not support this IRC command." });
    });
    on("464 465", () =>
      this.stop(problem("authentication", "Server rejected registration credentials or access.")),
    );
    on("ERROR", () => this.stop(problem("network", "Server terminated the IRC connection.")));
    on("NOTICE", (input, sender) => this.notice(input, sender));
    on("PRIVMSG", (input, sender) => this.chat(input, sender));
    // IRCv3 standard replies; FAIL is handled with labeled requests.
    on("WARN NOTE", ({ params }) => {
      const text = params.length >= 3 ? plain(params.at(-1)!).trim() : "";
      if (text) this.emit({ type: "notice", text });
    });
    on("JOIN", ({ params }, sender) => this.joined(sender, params[0], params[1]));
    on("PART", ({ params: p }, sender) => {
      if (p[0]) this.remove(p[0], sender, p[1] ?? "");
    });
    on("KICK", ({ params: p }) => {
      if (p[0] && p[1]) this.remove(p[0], p[1], p[2] ?? "");
    });
    on("QUIT", ({ params }, sender) => this.quit(sender, params[0] ?? ""));
    on("NICK", ({ params: p }, sender) => {
      if (p[0] && atom(p[0])) this.rename(sender, p[0]);
    });
    on("353", ({ params: p }) => {
      if (p[2] && p[3] !== undefined) this.names(p[2], p[3]);
    });
    on("366", ({ params: p }) => {
      if (p[1]) this.namesEnd(p[1]);
    });
    on("MODE", ({ params: p }) => {
      if (p[0] && p[1]) this.modes(p[0], p[1], p.slice(2));
    });
    on("TOPIC", ({ params: p }) => {
      if (p[0]) this.emit({ type: "topic", channel: plain(p[0]), text: plain(p[1] ?? "") });
    });
    on("332", ({ params: p }) => {
      if (p[1]) this.emit({ type: "topic", channel: plain(p[1]), text: plain(p[2] ?? "") });
    });
    on("331", ({ params: p }) => {
      if (p[1]) this.emit({ type: "topic", channel: plain(p[1]), text: "" });
    });
    on("AWAY", ({ params }, sender) =>
      this.emit({ type: "away", nick: plain(sender), away: params.length > 0 }),
    );
    // Successful registration may end with ERR_NOMOTD instead of the MOTD numerics.
    on("422", () => this.emit({ type: "notice", text: "The server has no message of the day." }));
    on("305 306", ({ command }) =>
      this.emit({ type: "away", nick: plain(this.nick), away: command === "306" }),
    );
    on("INVITE", ({ params: p }, sender) => {
      if (p[1])
        this.emit({ type: "notice", text: `${plain(sender)} invited you to ${plain(p[1])}.` });
    });
    on("ACCOUNT", ({ params: p }, sender) => {
      if (p[0]) this.account(sender, p[0]);
    });
    on("322", ({ params }) => this.directoryItem(params));
    on("323", () => this.directoryEnd());
    on("311 319 301 330 318 401", (input) => {
      // 401 also answers messages to absent nicknames; report those as ordinary rejections.
      if (!this.whoisReply(input.command, input.params) && input.command === "401")
        this.reply(input);
    });
    return routes;
  }
  /** A labeled error for one of our message fragments fails that whole logical send. */
  private rejectedFragment(input: IrcFrame): boolean {
    if (input.command !== "FAIL" && !/^[45][0-9]{2}$/.test(input.command)) return false;
    const label = this.modern.label(input);
    const rejected = label ? this.labels.get(label) : undefined;
    if (!rejected) return false;
    this.emit({
      type: "send-state",
      operationId: rejected.operationId,
      state: "failed",
      error: problem(
        "unavailable",
        `Server rejected a message fragment (${input.command}); other fragments may already have been written.`,
      ),
    });
    this.forgetSend(rejected);
    return true;
  }
  /** Generic numerics: rejections become errors, prose becomes notices, the rest stays opaque. */
  private reply(input: IrcFrame) {
    const { command, params } = input;
    if (/^[45][0-9]{2}$/.test(command)) {
      const message = REJECTIONS[command] ?? `IRC server rejected a request (${command}).`;
      this.emit({ type: "error", error: problem("unavailable", message) });
    } else if (READABLE_NUMERICS.has(command)) {
      // Welcome, user counts and MOTD are prose meant for people; show it instead of a code.
      const prose = TRAILING_NUMERICS.has(command)
        ? (params.at(-1) ?? "")
        : params.slice(1).join(" ");
      const text = plain(prose).replace(/^- ?/u, "").trimEnd();
      if (text.trim()) this.emit({ type: "notice", text });
    } else if (/^[0-9]{3}$/.test(command) && !QUIET_NUMERICS.has(command))
      this.emit({ type: "notice", text: `IRC server response ${command}.` });
  }
  private async saslSucceeded() {
    if (!this.saslStarted || !this.saslSent) {
      this.stop(problem("authentication", "Unexpected SASL success."));
      return;
    }
    this.authenticated = true;
    await this.endCap();
  }
  private async registered(nick: string | undefined) {
    // Optional SASL must not turn a server that registers us without CAP into a failure.
    if (!this.capEnded && !this.profile.sasl?.required && !this.saslStarted) await this.endCap();
    if (!this.capEnded || (this.profile.sasl?.required && !this.authenticated)) {
      this.stop(
        problem("authentication", "Server registered before required authentication completed."),
      );
      return;
    }
    if (nick && atom(nick)) this.nick = nick;
    this.ready = true;
    this.state("ready");
  }
  private nickRejected(input: IrcFrame): Promise<void> | void {
    if (!this.ready) return this.nextNick();
    // 437 also covers temporarily unavailable channels; only nickname replies are conflicts.
    if (
      input.command === "432" ||
      (input.command === "437" && this.isChannel(input.params[1] ?? ""))
    ) {
      this.reply(input);
      return;
    }
    this.emit({ type: "error", error: problem("conflict", "Nickname is unavailable.") });
  }
  /** During registration, fall back through the configured alternate nicknames. */
  private async nextNick() {
    if (this.alternate >= this.profile.identity.alternateNicks.length) {
      this.stop(
        problem(
          "conflict",
          "Every configured nickname was rejected or is in use; add an alternate nickname.",
        ),
      );
      return;
    }
    this.nick = this.profile.identity.alternateNicks[this.alternate++]!;
    await this.control("NICK", [this.nick]);
    this.state(this.phase);
  }
  private notice(input: IrcFrame, sender: string) {
    // No prefix means the server itself; nicknames cannot contain dots, server names do.
    if (input.prefix && (input.prefix.includes("!") || !sender.includes("."))) {
      this.chat(input, sender);
      return;
    }
    const text = plain(input.params[1] ?? "").trim();
    if (text) this.emit({ type: "notice", text });
  }
  private joined(sender: string, name: string | undefined, account: string | undefined) {
    if (!name || !atom(sender)) return;
    const channel = this.channel(name);
    if (channel) {
      if (this.self(sender) && !channel.names) channel.names = new Map();
      this.member(channel, sender, [], "join");
    }
    if (this.capabilities.has("extended-join") && account) this.account(sender, account);
  }
  private account(nick: string, account: string) {
    this.emit({
      type: "account",
      nick: plain(nick),
      account: account === "*" ? null : plain(account),
    });
  }
  private quit(sender: string, reason: string) {
    this.modern.clearTyping(sender);
    for (const channel of this.channels.values()) {
      channel.members.delete(this.fold(sender));
      this.touch(channel, this.fold(sender));
    }
    this.emit({ type: "quit", nick: plain(sender), reason: plain(reason) });
  }
  private directoryEnd() {
    if (this.directory && !this.directory.expired)
      this.emit({ type: "directory-complete", operationId: this.directory.operationId });
    this.directory = undefined;
  }
  private isupport(tokens: readonly string[]) {
    this.modern.isupport(tokens);
    let support = this.support;
    for (const token of tokens) {
      const [name, value = ""] = token.split("=");
      if (
        name === "CASEMAPPING" &&
        isCasemapping(value) &&
        value !== support.casemapping &&
        this.channels.size
      ) {
        this.stop(
          problem(
            "conflict",
            "Server changed IRC casemapping with active membership; reconnect required.",
          ),
        );
        return;
      }
      if (name === "STATUSMSG" && /^[^\s\x00-\x1f,#&]*$/.test(value)) this.statusPrefixes = value;
      support = withSupportToken(support, name, value);
    }
    this.support = support;
    this.publishSupport();
  }
  private isChannel(name: string) {
    return name.length > 0 && this.support.channelTypes.includes(name[0]!);
  }
  private chat(input: IrcFrame, sender: string) {
    let [target, body] = input.params;
    if (!target || body === undefined) return;
    if (!atom(target) || !atom(sender)) {
      // One bad line (e.g. a comma in a nickname) must not cost the whole connection.
      this.emit({ type: "notice", text: "Ignored a message with an invalid sender or target." });
      return;
    }
    // STATUSMSG (`@#room`) reaches a subset of the channel; it still belongs in the channel.
    if (this.statusPrefixes.includes(target[0]!) && this.isChannel(target.slice(1)))
      target = target.slice(1);
    const parsed = this.chatBody(input.command, sender, body);
    if (!parsed) return;
    this.modern.observeChat(input, sender, target);
    const label = this.modern.playback(input) ? undefined : this.modern.label(input);
    const send = label ? this.labels.get(label) : undefined;
    const message = this.envelope(input, sender, target, parsed);
    if (send && label && this.self(sender) && this.fold(target) === this.fold(send.target))
      this.echoed(send, label, message);
    else this.emit({ type: "chat", message });
  }
  /** Plain text or a CTCP ACTION; any other CTCP is reported, never answered, and yields nothing. */
  private chatBody(
    command: string,
    sender: string,
    body: string,
  ): { kind: ChatEnvelope["kind"]; text: string } | undefined {
    if (!body.startsWith("\x01"))
      return { kind: command === "NOTICE" ? "notice" : "text", text: body };
    // The closing \x01 is optional in practice. No CTCP is executed or answered: replies leak privacy.
    const [ctcp = "", ...rest] = body.slice(1).replace(/\x01$/u, "").split(" ");
    const name = plain(ctcp).toUpperCase().slice(0, 32);
    if (name === "ACTION") return { kind: "action", text: rest.join(" ") };
    if (name)
      this.emit({
        type: "notice",
        text:
          command === "NOTICE"
            ? `${plain(sender)} sent a CTCP ${name} reply.`
            : `${plain(sender)} sent a CTCP ${name} request; opentui-irc does not answer CTCP requests.`,
      });
    return undefined;
  }
  private envelope(
    input: IrcFrame,
    sender: string,
    target: string,
    { kind, text }: { kind: ChatEnvelope["kind"]; text: string },
  ): ChatEnvelope {
    const serverTime = input.tags.time ? Date.parse(input.tags.time) : NaN;
    const reply = input.tags[modernProtocol.reply];
    return {
      target: plain(target),
      sender: {
        nick: plain(sender),
        ...(input.tags.account && input.tags.account !== "*"
          ? { account: plain(input.tags.account) }
          : {}),
      },
      kind,
      text: plain(text),
      receivedAt: this.options.clock.now(),
      source: this.modern.playback(input) ? "playback" : "live",
      ...(Number.isFinite(serverTime) ? { serverTime } : {}),
      ...(input.tags.msgid && validServerId(input.tags.msgid)
        ? { serverId: input.tags.msgid }
        : {}),
      ...(reply && validServerId(reply) ? { replyToServerId: reply } : {}),
    };
  }
  /** Our labeled echo; the logical send completes once every fragment's echo is observed. */
  private echoed(send: Send, label: string, message: ChatEnvelope) {
    send.echoes.set(label, message);
    if (send.echoes.size !== send.fragments) return;
    // A split logical send cannot truthfully expose one fragment's server ID as its own.
    const logical: ChatEnvelope =
      send.fragments === 1
        ? { ...message, operationId: send.operationId }
        : {
            target: message.target,
            sender: message.sender,
            kind: send.kind,
            text: plainMultiline(send.text),
            receivedAt: message.receivedAt,
            source: "live",
            operationId: send.operationId,
            ...(send.replyToServerId ? { replyToServerId: send.replyToServerId } : {}),
          };
    this.emit({ type: "chat", message: logical });
    this.emit({ type: "send-state", operationId: send.operationId, state: "echo-observed" });
    this.forgetSend(send);
  }
  private forgetSend(send: Send) {
    this.sends.delete(send.operationId);
    for (const label of send.labels) this.labels.delete(label);
  }
  private channel(name: string): Channel | undefined {
    if (!atom(name) || !this.support.channelTypes.includes(name[0]!)) return undefined;
    const key = this.fold(name);
    let channel = this.channels.get(key);
    if (!channel) {
      if (this.channels.size >= this.policy.maxChannels) {
        this.stop(problem("unavailable", "IRC channel membership limit exceeded."));
        return;
      }
      channel = { name, members: new Map(), touched: new Set() };
      this.channels.set(key, channel);
    }
    return channel;
  }
  private member(
    channel: Channel,
    nick: string,
    prefixes: readonly string[],
    kind: "join" | "prefixes",
    touch = true,
  ) {
    const key = this.fold(nick);
    if (!channel.members.has(key) && channel.members.size >= this.policy.maxMembers) {
      this.stop(problem("unavailable", "IRC channel member limit exceeded."));
      return;
    }
    channel.members.set(key, { nick, prefixes: [...prefixes] });
    if (touch) this.touch(channel, key);
    this.emit({
      type: "membership",
      channel: plain(channel.name),
      change: { kind, nick: plain(nick), prefixes: prefixes.map(plain) },
    });
  }
  private remove(name: string, nick: string, reason: string) {
    const channel = this.channels.get(this.fold(name));
    if (!channel) return;
    this.modern.clearTyping(nick, name);
    channel.members.delete(this.fold(nick));
    this.touch(channel, this.fold(nick));
    this.emit({
      type: "membership",
      channel: plain(name),
      change: { kind: "remove", nick: plain(nick), reason: plain(reason) },
    });
    if (this.self(nick)) this.channels.delete(this.fold(name));
  }
  private touch(channel: Channel, key: string) {
    if (!channel.names) return;
    if (!channel.touched.has(key) && channel.touched.size >= this.policy.maxMembers * 2) {
      this.stop(problem("unavailable", "IRC NAMES reconciliation limit exceeded."));
      return;
    }
    channel.touched.add(key);
  }
  private rename(previous: string, next: string) {
    this.modern.clearTyping(previous);
    for (const channel of this.channels.values()) {
      const current = channel.members.get(this.fold(previous));
      const member = current ?? channel.names?.get(this.fold(previous));
      if (member) {
        channel.members.delete(this.fold(previous));
        if (current) channel.members.set(this.fold(next), { ...member, nick: next });
        else this.member(channel, next, member.prefixes, "join");
      }
      this.touch(channel, this.fold(previous));
      this.touch(channel, this.fold(next));
    }
    if (this.self(previous)) {
      this.nick = next;
      this.state(this.phase);
    }
    this.emit({ type: "nick", previous: plain(previous), next: plain(next) });
  }
  private names(name: string, list: string) {
    // `/names #elsewhere` answers for channels we are not in; that is not membership.
    const channel = this.channels.get(this.fold(name));
    if (!channel) return;
    if (!channel.names) {
      channel.names = new Map();
      channel.touched.clear();
    }
    for (const item of list.split(" ").filter(Boolean)) {
      let offset = 0;
      const prefixes: string[] = [];
      while (offset < item.length && this.support.prefixSymbols.includes(item[offset]!))
        prefixes.push(item[offset++]!);
      const nick = item.slice(offset).split("!")[0]!;
      if (!atom(nick)) continue;
      if (channel.names.size >= this.policy.maxMembers) {
        this.stop(problem("unavailable", "IRC NAMES limit exceeded."));
        return;
      }
      channel.names.set(this.fold(nick), { nick, prefixes });
    }
  }
  private namesEnd(name: string) {
    const channel = this.channels.get(this.fold(name));
    if (!channel?.names) return;
    for (const [key, member] of channel.names)
      if (!channel.touched.has(key)) {
        const current = channel.members.get(key);
        if (!current || current.prefixes.join("") !== member.prefixes.join(""))
          this.member(channel, member.nick, member.prefixes, current ? "prefixes" : "join", false);
      }
    for (const [key, member] of channel.members)
      if (!channel.names.has(key) && !channel.touched.has(key)) this.remove(name, member.nick, "");
    delete channel.names;
    channel.touched.clear();
  }
  private modes(name: string, modes: string, args: readonly string[]) {
    const channel = this.channels.get(this.fold(name));
    if (!channel) return;
    let adding = true;
    let index = 0;
    for (const mode of modes) {
      if (mode === "+" || mode === "-") {
        adding = mode === "+";
        continue;
      }
      const prefix = this.support.prefixModes.indexOf(mode);
      if (prefix >= 0) {
        const nick = args[index++];
        if (!nick) return;
        const key = this.fold(nick);
        const member = channel.members.get(key) ?? channel.names?.get(key);
        if (!member) continue;
        const symbol = this.support.prefixSymbols[prefix]!;
        const values = new Set(member.prefixes);
        if (adding) values.add(symbol);
        else values.delete(symbol);
        const prefixes = [...this.support.prefixSymbols].filter((value) => values.has(value));
        this.member(channel, member.nick, prefixes, "prefixes");
      } else if (
        this.support.channelModeGroups[0].includes(mode) ||
        this.support.channelModeGroups[1].includes(mode) ||
        (adding && this.support.channelModeGroups[2].includes(mode))
      )
        index++;
    }
  }
  private directoryItem(p: readonly string[]) {
    const query = this.directory;
    if (!query || query.expired || !p[1]) return;
    if (++query.count > this.policy.maxDirectoryItems) {
      query.expired = true;
      this.emit({
        type: "error",
        operationId: query.operationId,
        error: problem("rate-limited", "Channel directory exceeded the configured result limit."),
      });
      return;
    }
    const count = Number(p[2]);
    if (!Number.isSafeInteger(count) || count < 0) return;
    this.emit({
      type: "directory-item",
      operationId: query.operationId,
      item: { channel: plain(p[1]), userCount: count, topic: plain(p[3] ?? "") },
    });
  }
  /** Returns false when the reply does not belong to the pending WHOIS. */
  private whoisReply(command: string, p: readonly string[]): boolean {
    const query = this.whois;
    if (!query || !p[1] || this.fold(query.nick) !== this.fold(p[1])) return false;
    if (command === "318") {
      if (!query.expired)
        this.emit({ type: "user-details", operationId: query.operationId, details: query.details });
      this.whois = undefined;
      return true;
    }
    if (query.expired) return true;
    if (command === "401") {
      query.expired = true;
      this.emit({
        type: "error",
        operationId: query.operationId,
        error: problem("unavailable", "IRC user was not found."),
      });
      return true;
    }
    if (command === "311")
      query.details = {
        ...query.details,
        username: plain(p[2] ?? ""),
        hostname: plain(p[3] ?? ""),
        realname: plain(p[5] ?? ""),
      };
    if (command === "319") {
      const channels = [
        ...query.details.channels,
        ...(p[2] ?? "").split(" ").filter(Boolean).map(plain),
      ];
      if (channels.length > this.policy.maxChannels) {
        query.expired = true;
        this.emit({
          type: "error",
          operationId: query.operationId,
          error: problem("unavailable", "WHOIS channel limit exceeded."),
        });
      } else query.details = { ...query.details, channels };
    }
    if (command === "301") query.details = { ...query.details, awayReason: plain(p[2] ?? "") };
    if (command === "330") query.details = { ...query.details, account: plain(p[2] ?? "") };
    return true;
  }
  private async execute(
    command: SessionCommand,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<Result<void>> {
    if (signal.aborted) return failure("cancelled", "Operation cancelled.");
    if (!this.ready || this.stopped) return failure("unavailable", "IRC connection is not ready.");
    if (this.active(operationId)) return failure("conflict", "Operation is already active.");
    const cost = this.cost(command);
    if (!cost.ok) return cost;
    const { bytes, fragments, emptyLines } = cost.value;
    if (
      this.queue.length >= this.policy.maxQueueCommands ||
      bytes > this.policy.maxQueueBytes - this.queueBytes ||
      fragments > this.policy.maxQueueFragments - this.queueFragments
    )
      return failure("rate-limited", "IRC outgoing queue is full.");
    // Admission owns a detached immutable command. In particular, caller abort never unsends it.
    const modernAdmission = this.modern.admit(command, operationId);
    if (!modernAdmission.ok) return modernAdmission;
    const owned: SessionCommand =
      command.type === "history" && command.before
        ? { ...command, before: { ...command.before } }
        : { ...command };
    this.track(command, operationId);
    this.queue.push({ command: owned, operationId, bytes, fragments });
    this.queueBytes += bytes;
    this.queueFragments += fragments;
    if (emptyLines)
      this.emit({
        type: "notice",
        text: "Basic IRC represents each empty line as a single space; the original multiline text is preserved locally.",
      });
    void this.drain();
    return ok();
  }
  private active(operationId: OperationId) {
    return (
      this.sends.has(operationId) ||
      this.queue.some((item) => item.operationId === operationId) ||
      this.whois?.operationId === operationId ||
      this.directory?.operationId === operationId ||
      this.modern.hasOperation(operationId)
    );
  }
  /** Validates a command for admission and estimates its outgoing queue footprint. */
  private cost(command: SessionCommand): Result<Cost> {
    switch (command.type) {
      case "join":
      case "part":
      case "topic":
        return this.channelCost(command);
      case "send":
        return this.sendCost(command);
      case "nick":
        if (!atom(command.nick)) return failure("invalid-input", "Invalid nickname.");
        return queueCost(byteLength(command.nick));
      case "away":
        if (command.reason !== null && !content(command.reason))
          return failure("invalid-input", "Invalid away reason.");
        return queueCost(byteLength(command.reason ?? ""));
      case "whois":
        if (!atom(command.nick)) return failure("invalid-input", "Invalid WHOIS nickname.");
        if (this.whois) return failure("conflict", "Another WHOIS request is still active.");
        return queueCost(0);
      case "list":
        if (this.directory) return failure("conflict", "Another LIST request is still active.");
        return queueCost(0);
      default:
        return queueCost(byteLength(JSON.stringify(command)));
    }
  }
  private channelCost(
    command: Extract<SessionCommand, { type: "join" | "part" | "topic" }>,
  ): Result<Cost> {
    if (!atom(command.channel) || !this.support.channelTypes.includes(command.channel[0]!))
      return failure("invalid-input", "Invalid IRC channel.");
    switch (command.type) {
      case "join":
        if (command.key && !this.secure)
          return failure("authentication", "Channel keys require a verified TLS connection.");
        return queueCost(byteLength(command.channel));
      case "part":
        if (command.reason !== undefined && !content(command.reason))
          return failure("invalid-input", "Invalid part reason.");
        return queueCost(byteLength(command.channel) + byteLength(command.reason ?? ""));
      case "topic":
        if (command.text !== undefined && !content(command.text))
          return failure("invalid-input", "Invalid topic.");
        return queueCost(byteLength(command.channel) + byteLength(command.text ?? ""));
    }
  }
  private sendCost(command: SendCommand): Result<Cost> {
    if (
      !atom(command.target) ||
      command.target.includes("*") ||
      !command.text ||
      /[\r\0]/.test(command.text) ||
      command.text.includes("\x01")
    )
      return failure("invalid-input", "Invalid message target or content.");
    if (command.replyToServerId !== undefined) {
      if (!this.modern.features().replies)
        return failure(
          "unsupported",
          "Replies require permitted message tags and observed server message IDs.",
        );
      if (!validServerId(command.replyToServerId))
        return failure("invalid-input", "Invalid reply message reference.");
    }
    if (this.sends.size >= this.policy.maxPendingSends)
      return failure("rate-limited", "Too many unresolved message sends.");
    const plan = this.split(command);
    if (!plan.ok) return plan;
    const bytes = byteLength(command.target) + byteLength(command.text);
    return queueCost(bytes, plan.value.pieces.length, plan.value.emptyLines);
  }
  /** Registers the query or send state that later replies and echoes correlate against. */
  private track(command: SessionCommand, operationId: OperationId) {
    if (command.type === "whois")
      this.whois = {
        operationId,
        nick: command.nick,
        details: { nick: plain(command.nick), channels: [] },
        started: Infinity,
        expired: false,
      };
    if (command.type === "list")
      this.directory = { operationId, count: 0, started: Infinity, expired: false };
    if (command.type === "send")
      this.sends.set(operationId, {
        operationId,
        target: command.target,
        kind: command.kind,
        text: command.text,
        fragments: 0,
        written: 0,
        started: false,
        echoes: new Map(),
        labels: new Set(),
        updatedAt: this.options.clock.now(),
        expectsEcho: false,
        ...(command.replyToServerId ? { replyToServerId: command.replyToServerId } : {}),
      });
  }
  private async pacedWrite(output: IrcFrame, send?: Send) {
    while (this.nextWriteAt > this.options.clock.now()) {
      await this.options.clock.sleep(
        this.nextWriteAt - this.options.clock.now(),
        this.controller.signal,
      );
    }
    if (this.stopped || this.shuttingDown) return failure<void>("cancelled", "Connection closed.");
    const available = this.modern.validateFrame(output);
    if (!available.ok) return available;
    if (send) send.started = true;
    const result = await this.write(output);
    this.nextWriteAt = this.options.clock.now() + this.policy.floodIntervalMs;
    return result;
  }
  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped && !this.shuttingDown) {
        const item = this.queue[0]!;
        const result = await this.perform(item);
        if (this.stopped) return;
        this.queue.shift();
        this.queueBytes -= item.bytes;
        this.queueFragments -= item.fragments;
        if (!result.ok) {
          const send = this.sends.get(item.operationId);
          if (send) {
            this.emit({
              type: "send-state",
              operationId: item.operationId,
              state: send.started ? "uncertain" : "failed",
              error: result.error,
            });
            this.forgetSend(send);
          } else this.emit({ type: "error", operationId: item.operationId, error: result.error });
          if (item.command.type === "whois") this.whois = undefined;
          if (item.command.type === "list") this.directory = undefined;
          if (result.error.code === "network" || result.error.code === "cancelled") {
            this.stop(result.error);
            return;
          }
        }
      }
    } catch {
      if (!this.stopped) this.stop(problem("network", "Outgoing IRC operation failed."));
    } finally {
      this.draining = false;
    }
  }
  private async perform(item: Queued): Promise<Result<void>> {
    const command = item.command;
    switch (command.type) {
      case "join": {
        let key: string | undefined;
        if (command.key) {
          if (!this.secure)
            return failure("authentication", "Channel keys require a verified TLS connection.");
          const result = await this.options.secrets.resolve(command.key, this.controller.signal);
          if (!result.ok || !atom(result.value))
            return failure("authentication", "Channel key is unavailable or invalid.");
          key = result.value;
        }
        return this.pacedWrite(frame("JOIN", key ? [command.channel, key] : [command.channel]));
      }
      case "part":
        return this.pacedWrite(
          frame(
            "PART",
            command.reason === undefined ? [command.channel] : [command.channel, command.reason],
          ),
        );
      case "nick":
        return this.pacedWrite(frame("NICK", [command.nick]));
      case "away":
        return this.pacedWrite(frame("AWAY", command.reason === null ? [] : [command.reason]));
      case "topic":
        return this.pacedWrite(
          frame(
            "TOPIC",
            command.text === undefined ? [command.channel] : [command.channel, command.text],
          ),
        );
      case "whois":
        if (this.whois) this.whois.started = this.options.clock.now();
        return this.pacedWrite(frame("WHOIS", [command.nick]));
      case "list":
        if (this.directory) this.directory.started = this.options.clock.now();
        return this.pacedWrite(frame("LIST", []));
      case "send":
        return this.send(item.operationId, command, item);
      default:
        return this.modern.perform(command, item.operationId, (output) => this.pacedWrite(output));
    }
  }
  private split(command: SendCommand) {
    return splitMessage({
      text: command.text,
      target: command.target,
      kind: command.kind,
      maxCommandBytes: this.limits.maxCommandBytes,
      sourcePrefixBytes: this.ownPrefixBytes,
      maxBytes: this.policy.maxSendBytes,
      maxFragments: this.policy.maxSendFragments,
    });
  }
  private async send(
    operationId: OperationId,
    command: SendCommand,
    item: Queued,
  ): Promise<Result<void>> {
    const send = this.sends.get(operationId)!;
    const reliableEcho = ["echo-message", "message-tags", "labeled-response", "batch"].every(
      (cap) => this.capabilities.has(cap),
    );
    const ircCommand = command.kind === "notice" ? "NOTICE" : "PRIVMSG";
    const wrap = (text: string) => (command.kind === "action" ? `\x01ACTION ${text}\x01` : text);
    const plan = this.split(command);
    if (!plan.ok) return plan;
    const pieces = plan.value.pieces;
    const growth = pieces.length - item.fragments;
    if (growth > this.policy.maxQueueFragments - this.queueFragments)
      return failure(
        "rate-limited",
        "Updated IRC source prefix exceeds the outgoing fragment budget.",
      );
    this.queueFragments += growth;
    item.fragments = pieces.length;
    send.fragments = pieces.length;
    send.expectsEcho = reliableEcho;
    const outputs = pieces.map((text) => {
      const label = reliableEcho
        ? `oi-${this.session.identity.generation}-${++this.labelSequence}`
        : undefined;
      if (label) {
        send.labels.add(label);
        this.labels.set(label, send);
      }
      return frame(ircCommand, [command.target, wrap(text)], {
        ...(label ? { label } : {}),
        ...(command.replyToServerId ? { [modernProtocol.reply]: command.replyToServerId } : {}),
      });
    });
    for (const output of outputs) {
      // Prevalidate all fragments before writing any of a logical operation.
      const encoded = this.codec.encode(output);
      if (!encoded.ok) return encoded;
    }
    for (const output of outputs) {
      if (!this.sends.has(operationId)) return ok();
      const result = await this.pacedWrite(output, send);
      if (!result.ok) return result;
      send.written++;
    }
    send.updatedAt = this.options.clock.now();
    if (this.sends.has(operationId)) {
      this.emit({ type: "send-state", operationId, state: "written" });
      // Retain a bounded recent written window so disconnect can report uncertainty.
    }
    return ok();
  }
}
