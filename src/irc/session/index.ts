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

// Machine-oriented replies (server info, channel modes/creation, topic setter/URL) with no prose for people.
const QUIET_NUMERICS = new Set(["004", "042", "324", "328", "329", "333"]);
// Prose whose leading parameters only repeat our own identity.
const TRAILING_NUMERICS = new Set(["900", "901"]);

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
              reason && content(reason) && byteLength(reason) <= 200 ? reason : "OpenIRC",
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
        const now = this.options.clock.now();
        if (!this.ready && now - this.startedAt >= this.policy.registrationTimeoutMs) {
          this.stop(problem("network", "IRC registration timed out."));
          return;
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
          if (this.stopped) return;
        }
        if (
          this.pingSentAt !== undefined &&
          now - this.pingSentAt >= this.policy.staleTimeoutMs - this.policy.keepaliveMs
        ) {
          this.stop(problem("network", "IRC keepalive timed out."));
          return;
        }
        if (
          this.connection &&
          now - this.lastReceived >= this.policy.keepaliveMs &&
          this.pingSentAt === undefined
        ) {
          this.pingSentAt = now;
          await this.control("PING", [`openirc-${now}`]);
        }
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
        this.modern.tick(now);
      }
    } catch {
      if (!signal.aborted) this.stop(problem("internal", "IRC clock failed."));
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
  private async cap(input: IrcFrame) {
    const sub = input.params[1];
    const list = input.params.at(-1) ?? "";
    if (this.capEnded && sub !== "DEL") return;
    if (sub === "LS") {
      for (const token of list.split(" ").filter(Boolean)) {
        if (this.advertised.size >= 128) {
          this.stop(problem("network", "Too many IRC capabilities."));
          return;
        }
        const [name, ...value] = token.split("=");
        if (name) this.advertised.set(name, value.length ? value.join("=") : null);
      }
      if (input.params[2] === "*") return;
      this.capLsComplete = true;
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
      if (
        this.advertised.has("message-tags") &&
        this.advertised.has("batch") &&
        this.advertised.has("labeled-response") &&
        this.advertised.has("echo-message")
      )
        wanted.push("batch", "labeled-response", "echo-message");
      if (
        this.profile.sasl &&
        this.advertised.has("sasl") &&
        (this.advertised.get("sasl") === null ||
          this.advertised.get("sasl")?.split(",").includes("PLAIN"))
      )
        wanted.push("sasl");
      wanted.push(...modernCapabilities(this.advertised));
      for (const name of wanted) if (this.advertised.has(name)) this.requested.add(name);
      if (this.profile.sasl?.required && !this.requested.has("sasl")) {
        this.stop(
          problem("authentication", "Server does not offer required SASL PLAIN authentication."),
        );
        return;
      }
      if (this.requested.size) await this.control("CAP", ["REQ", [...this.requested].join(" ")]);
      else await this.endCap();
    } else if (sub === "ACK" || sub === "NAK") {
      for (const token of list.split(" ")) {
        const name = token.replace(/^-/, "").split("=")[0]!;
        if (!this.requested.has(name)) continue;
        this.requested.delete(name);
        if (sub === "ACK" && !token.startsWith("-"))
          this.capabilities.set(name, this.advertised.get(name) ?? null);
        else this.capabilities.delete(name);
      }
      if (!this.requested.size && this.capLsComplete) {
        if (
          this.capabilities.has("echo-message") &&
          !["message-tags", "batch", "labeled-response"].every((name) =>
            this.capabilities.has(name),
          )
        ) {
          // Do not expose/use echo until reliable correlation dependencies are ACKed.
          this.capabilities.delete("echo-message");
          await this.control("CAP", ["REQ", "-echo-message"]);
        }
        if (this.profile.sasl && this.capabilities.has("sasl") && !this.saslStarted) {
          this.saslStarted = true;
          this.state("authenticating");
          await this.control("AUTHENTICATE", ["PLAIN"]);
        } else if (!this.saslStarted || this.authenticated) await this.endCap();
      }
    } else if (sub === "DEL") {
      for (const name of list.split(" ")) this.capabilities.delete(name);
      if (
        this.capabilities.has("echo-message") &&
        !["message-tags", "batch", "labeled-response"].every((name) => this.capabilities.has(name))
      ) {
        this.capabilities.delete("echo-message");
        await this.control("CAP", ["REQ", "-echo-message"]);
      }
      this.publishSupport();
    }
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
    const p = input.params;
    const sender = input.prefix?.split("!")[0] ?? "";
    if (input.prefix?.includes("!") && this.self(sender))
      this.ownPrefixBytes = byteLength(input.prefix) + 2;
    if (input.command === "FAIL" || /^[45][0-9]{2}$/.test(input.command)) {
      const label = this.modern.label(input);
      const rejected = label ? this.labels.get(label) : undefined;
      if (rejected) {
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
        return;
      }
    }
    if (this.modern.handle(input, sender) || this.stopped) return;
    switch (input.command) {
      case "PING":
        await this.control("PONG", p);
        return;
      case "PONG":
        if (p.at(-1) === `openirc-${this.pingSentAt}`) this.pingSentAt = undefined;
        return;
      case "CAP":
        await this.cap(input);
        return;
      case "AUTHENTICATE":
        await this.authenticate(input);
        return;
      case "903":
        if (!this.saslStarted || !this.saslSent) {
          this.stop(problem("authentication", "Unexpected SASL success."));
          return;
        }
        this.authenticated = true;
        await this.endCap();
        return;
      case "904":
      case "905":
      case "906":
      case "907":
        await this.saslFailed();
        return;
      case "001":
        if (!this.capEnded && !this.profile.sasl && !this.saslStarted) await this.endCap();
        if (!this.capEnded || (this.profile.sasl?.required && !this.authenticated)) {
          this.stop(
            problem(
              "authentication",
              "Server registered before required authentication completed.",
            ),
          );
          return;
        }
        if (p[0] && atom(p[0])) this.nick = p[0];
        this.ready = true;
        this.state("ready");
        return;
      case "005":
        this.isupport(p.slice(1, -1));
        return;
      case "432":
      case "433":
      case "436":
      case "437":
        if (this.ready) {
          // 437 also covers temporarily unavailable channels; only nickname replies are conflicts.
          if (input.command === "432" || (input.command === "437" && !this.isChannel(p[1] ?? "")))
            break;
          this.emit({ type: "error", error: problem("conflict", "Nickname is unavailable.") });
        } else if (this.alternate < this.profile.identity.alternateNicks.length) {
          this.nick = this.profile.identity.alternateNicks[this.alternate++]!;
          await this.control("NICK", [this.nick]);
          this.state(this.phase);
        } else
          this.stop(
            problem(
              "conflict",
              "Every configured nickname was rejected or is in use; add an alternate nickname.",
            ),
          );
        return;
      case "421":
        if (!this.ready && p[1]?.toUpperCase() === "CAP") await this.endCap();
        else this.emit({ type: "notice", text: "Server does not support this IRC command." });
        return;
      case "464":
      case "465":
        this.stop(problem("authentication", "Server rejected registration credentials or access."));
        return;
      case "ERROR":
        this.stop(problem("network", "Server terminated the IRC connection."));
        return;
      case "NOTICE":
        // No prefix means the server itself; nicknames cannot contain dots, server names do.
        if (!input.prefix || (!input.prefix.includes("!") && sender.includes("."))) {
          const text = plain(p[1] ?? "").trim();
          if (text) this.emit({ type: "notice", text });
          return;
        }
        this.chat(input, sender);
        return;
      case "PRIVMSG":
        this.chat(input, sender);
        return;
      // IRCv3 standard replies; FAIL is handled with labeled requests.
      case "WARN":
      case "NOTE":
        if (p.length >= 3 && plain(p.at(-1)!).trim())
          this.emit({ type: "notice", text: plain(p.at(-1)!).trim() });
        return;
      case "JOIN":
        if (p[0] && atom(sender)) {
          const channel = this.channel(p[0]);
          if (channel) {
            if (this.self(sender) && !channel.names) channel.names = new Map();
            this.member(channel, sender, [], "join");
          }
          if (this.capabilities.has("extended-join") && p[1])
            this.emit({
              type: "account",
              nick: plain(sender),
              account: p[1] === "*" ? null : plain(p[1]),
            });
        }
        return;
      case "PART":
        if (p[0]) this.remove(p[0], sender, p[1] ?? "");
        return;
      case "KICK":
        if (p[0] && p[1]) this.remove(p[0], p[1], p[2] ?? "");
        return;
      case "QUIT":
        this.modern.clearTyping(sender);
        for (const channel of this.channels.values()) {
          channel.members.delete(this.fold(sender));
          this.touch(channel, this.fold(sender));
        }
        this.emit({ type: "quit", nick: plain(sender), reason: plain(p[0] ?? "") });
        return;
      case "NICK":
        if (p[0] && atom(p[0])) this.rename(sender, p[0]);
        return;
      case "353":
        if (p[2] && p[3] !== undefined) this.names(p[2], p[3]);
        return;
      case "366":
        if (p[1]) this.namesEnd(p[1]);
        return;
      case "MODE":
        if (p[0] && p[1]) this.modes(p[0], p[1], p.slice(2));
        return;
      case "TOPIC":
        if (p[0]) this.emit({ type: "topic", channel: plain(p[0]), text: plain(p[1] ?? "") });
        return;
      case "332":
        if (p[1]) this.emit({ type: "topic", channel: plain(p[1]), text: plain(p[2] ?? "") });
        return;
      case "331":
        if (p[1]) this.emit({ type: "topic", channel: plain(p[1]), text: "" });
        return;
      case "AWAY":
        this.emit({ type: "away", nick: plain(sender), away: p.length > 0 });
        return;
      // Successful registration may end with ERR_NOMOTD instead of the MOTD numerics.
      case "422":
        this.emit({ type: "notice", text: "The server has no message of the day." });
        return;
      case "305":
      case "306":
        this.emit({ type: "away", nick: plain(this.nick), away: input.command === "306" });
        return;
      case "INVITE":
        if (p[1])
          this.emit({ type: "notice", text: `${plain(sender)} invited you to ${plain(p[1])}.` });
        return;
      case "ACCOUNT":
        if (p[0])
          this.emit({
            type: "account",
            nick: plain(sender),
            account: p[0] === "*" ? null : plain(p[0]),
          });
        return;
      case "322":
        this.directoryItem(p);
        return;
      case "323":
        if (this.directory && !this.directory.expired)
          this.emit({ type: "directory-complete", operationId: this.directory.operationId });
        this.directory = undefined;
        return;
      case "311":
      case "319":
      case "301":
      case "330":
      case "318":
      case "401":
        // 401 also answers messages to absent nicknames; report those as ordinary rejections.
        if (this.whoisReply(input.command, p) || input.command !== "401") return;
        break;
    }
    const rejection: Readonly<Record<string, string>> = {
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
    if (/^[45][0-9]{2}$/.test(input.command))
      this.emit({
        type: "error",
        error: problem(
          "unavailable",
          rejection[input.command] ?? `IRC server rejected a request (${input.command}).`,
        ),
      });
    else if (READABLE_NUMERICS.has(input.command)) {
      // Welcome, user counts and MOTD are prose meant for people; show it instead of a code.
      const prose = TRAILING_NUMERICS.has(input.command) ? (p.at(-1) ?? "") : p.slice(1).join(" ");
      const text = plain(prose).replace(/^- ?/u, "").trimEnd();
      if (text.trim()) this.emit({ type: "notice", text });
    } else if (/^[0-9]{3}$/.test(input.command) && !QUIET_NUMERICS.has(input.command))
      this.emit({ type: "notice", text: `IRC server response ${input.command}.` });
  }
  private isupport(tokens: readonly string[]) {
    this.modern.isupport(tokens);
    let support = this.support;
    for (const token of tokens) {
      const [name, value = ""] = token.split("=");
      if (name === "CASEMAPPING" && ["ascii", "rfc1459", "strict-rfc1459"].includes(value)) {
        if (value !== support.casemapping && this.channels.size) {
          this.stop(
            problem(
              "conflict",
              "Server changed IRC casemapping with active membership; reconnect required.",
            ),
          );
          return;
        }
        if (value === "ascii" || value === "rfc1459" || value === "strict-rfc1459")
          support = { ...support, casemapping: value };
      } else if (name === "CHANTYPES" && value && /^[^\s\x00-\x1f,]+$/.test(value))
        support = { ...support, channelTypes: plain(value) };
      else if (name === "PREFIX") {
        // An explicitly empty PREFIX means the network has no member prefixes at all.
        const match = /^(?:\(([a-zA-Z]+)\)([^\s]+))?$/.exec(value);
        if (match && (match[1] ?? "").length === (match[2] ?? "").length)
          support = {
            ...support,
            prefixModes: match[1] ?? "",
            prefixSymbols: plain(match[2] ?? ""),
          };
      } else if (name === "STATUSMSG" && /^[^\s\x00-\x1f,#&]*$/.test(value))
        this.statusPrefixes = value;
      else if (name === "CHANMODES") {
        const groups = value.split(",");
        if (groups.length === 4 && groups.every((group) => /^[a-zA-Z]*$/.test(group)))
          support = {
            ...support,
            channelModeGroups: [groups[0]!, groups[1]!, groups[2]!, groups[3]!],
          };
      }
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
      this.stop(problem("network", "Malformed IRC chat envelope."));
      return;
    }
    // STATUSMSG (`@#room`) reaches a subset of the channel; it still belongs in the channel.
    if (this.statusPrefixes.includes(target[0]!) && this.isChannel(target.slice(1)))
      target = target.slice(1);
    let text = body;
    let kind: ChatEnvelope["kind"] = input.command === "NOTICE" ? "notice" : "text";
    if (body.startsWith("\x01")) {
      // The closing \x01 is optional in practice. No CTCP is executed or answered: replies leak privacy.
      const [command = "", ...rest] = body.slice(1).replace(/\x01$/u, "").split(" ");
      const name = plain(command).toUpperCase().slice(0, 32);
      if (name === "ACTION") {
        kind = "action";
        text = rest.join(" ");
      } else {
        if (name)
          this.emit({
            type: "notice",
            text:
              input.command === "NOTICE"
                ? `${plain(sender)} sent a CTCP ${name} reply.`
                : `${plain(sender)} sent a CTCP ${name} request; OpenIRC does not answer CTCP requests.`,
          });
        return;
      }
    }
    const serverTime = input.tags.time ? Date.parse(input.tags.time) : NaN;
    this.modern.observeChat(input, sender, target);
    const label = this.modern.playback(input) ? undefined : this.modern.label(input);
    const send = label ? this.labels.get(label) : undefined;
    const reply = input.tags[modernProtocol.reply];
    const message: ChatEnvelope = {
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
    if (send && label && this.self(sender) && this.fold(target) === this.fold(send.target)) {
      send.echoes.set(label, message);
      if (send.echoes.size === send.fragments) {
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
    } else this.emit({ type: "chat", message });
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
    const channel = this.channel(name);
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
    if (
      this.sends.has(operationId) ||
      this.queue.some((item) => item.operationId === operationId) ||
      this.whois?.operationId === operationId ||
      this.directory?.operationId === operationId ||
      this.modern.hasOperation(operationId)
    )
      return failure("conflict", "Operation is already active.");
    let bytes = 32;
    let fragments = 1;
    let emptyLines = 0;
    switch (command.type) {
      case "join":
      case "part":
      case "topic":
        if (!atom(command.channel) || !this.support.channelTypes.includes(command.channel[0]!))
          return failure("invalid-input", "Invalid IRC channel.");
        if (command.type === "join" && command.key && !this.secure)
          return failure("authentication", "Channel keys require a verified TLS connection.");
        if (command.type === "part" && command.reason !== undefined && !content(command.reason))
          return failure("invalid-input", "Invalid part reason.");
        if (command.type === "topic" && command.text !== undefined && !content(command.text))
          return failure("invalid-input", "Invalid topic.");
        bytes +=
          byteLength(command.channel) +
          (command.type === "part"
            ? byteLength(command.reason ?? "")
            : command.type === "topic"
              ? byteLength(command.text ?? "")
              : 0);
        break;
      case "send":
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
        {
          const plan = this.split(command);
          if (!plan.ok) return plan;
          fragments = plan.value.pieces.length;
          emptyLines = plan.value.emptyLines;
        }
        bytes += byteLength(command.target) + byteLength(command.text);
        break;
      case "nick":
        if (!atom(command.nick)) return failure("invalid-input", "Invalid nickname.");
        bytes += byteLength(command.nick);
        break;
      case "away":
        if (command.reason !== null && !content(command.reason))
          return failure("invalid-input", "Invalid away reason.");
        bytes += byteLength(command.reason ?? "");
        break;
      case "whois":
        if (!atom(command.nick)) return failure("invalid-input", "Invalid WHOIS nickname.");
        if (this.whois) return failure("conflict", "Another WHOIS request is still active.");
        break;
      case "list":
        if (this.directory) return failure("conflict", "Another LIST request is still active.");
        break;
      default:
        bytes += byteLength(JSON.stringify(command));
    }
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
  private split(command: Extract<SessionCommand, { type: "send" }>) {
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
    command: Extract<SessionCommand, { type: "send" }>,
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
