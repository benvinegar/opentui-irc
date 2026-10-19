import { afterEach, describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { Clock, Result } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionEvent } from "../../../src/contracts/session";
import type { NetworkProfile, SecretProvider } from "../../../src/contracts/settings";
import type { ByteConnection } from "../../../src/contracts/transport";
import { createIrcCodec } from "../../../src/irc/codec";
import { createSessionFactory, defaultProtocolLimits } from "../../../src/irc/session";
import type { SessionPolicy } from "../../../src/irc/session";

const networkId = entityId<"network">("network-1");
const op = (name: string) => entityId<"operation">(name);
const signal = () => new AbortController().signal;
const clock: Clock = {
  now: () => Date.now(),
  sleep(ms, abort) {
    return new Promise((resolve, reject) => {
      if (abort.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const cancel = () => {
        clearTimeout(timer);
        abort.removeEventListener("abort", cancel);
        reject(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        abort.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      abort.addEventListener("abort", cancel, { once: true });
    });
  },
};
const profile: NetworkProfile = {
  id: networkId,
  name: "Fixture",
  endpoints: [{ host: "fixture.invalid", port: 6697, tls: true }],
  identity: { nick: "me", alternateNicks: ["me_"], username: "user", realname: "Fixture user" },
  autoConnect: false,
  autoJoin: [],
};
const secrets: SecretProvider = {
  async resolve() {
    return { ok: true, value: "fixture-password" };
  },
  async store() {
    return { ok: false, error: { code: "unsupported", message: "Fixture", retryable: false } };
  },
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
async function harness(
  options: {
    capabilities?: string;
    sasl?: NetworkProfile["sasl"];
    tls?: boolean;
    secretProvider?: SecretProvider;
    policy?: Partial<SessionPolicy>;
    autoConsume?: boolean;
    onWrite?: (
      frame: IrcFrame,
      send: (line: string) => void,
    ) => Promise<Result<void> | void> | Result<void> | void;
  } = {},
) {
  let wake: (() => void) | undefined;
  const input: Uint8Array[] = [];
  let ended = false;
  const written: IrcFrame[] = [];
  const events: SessionEvent[] = [];
  const codec = createIrcCodec(defaultProtocolLimits);
  const send = (line: string) => {
    input.push(new TextEncoder().encode(line + "\r\n"));
    wake?.();
    wake = undefined;
  };
  const parent = new AbortController();
  const connection: ByteConnection = {
    incoming: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (input.length) yield input.shift()!;
          else if (ended) return;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      },
    },
    async write(bytes) {
      const result = codec.push(bytes);
      if (!result.ok) return result;
      for (const frame of result.value) {
        written.push(frame);
        const custom = await options.onWrite?.(frame, send);
        if (custom) return custom;
        if (frame.command === "CAP" && frame.params[0] === "LS")
          send(`:s CAP me LS :${options.capabilities ?? ""}`);
        if (frame.command === "CAP" && frame.params[0] === "REQ")
          send(`:s CAP me ACK :${frame.params[1]}`);
        if (frame.command === "AUTHENTICATE") {
          if (frame.params[0] === "PLAIN") send("AUTHENTICATE +");
          else send(":s 903 me :SASL succeeded");
        }
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }
      return { ok: true, value: undefined };
    },
    async close() {
      ended = true;
      wake?.();
      wake = undefined;
      return { ok: true, value: undefined };
    },
  };
  const factory = createSessionFactory({
    transport: {
      async connect() {
        return { ok: true, value: connection };
      },
    },
    secrets: options.secretProvider ?? secrets,
    clock,
    policy: { floodIntervalMs: 0, ...options.policy },
  });
  const opened = await factory.open(
    {
      ...profile,
      endpoints: profile.endpoints.map((endpoint) => ({
        ...endpoint,
        tls: options.tls ?? endpoint.tls,
      })),
      ...(options.sasl ? { sasl: options.sasl } : {}),
    },
    { networkId, generation: 7 },
    parent.signal,
  );
  if (!opened.ok) throw new Error("Fixture open failed");
  const session = opened.value;
  const consumption =
    options.autoConsume === false
      ? undefined
      : (async () => {
          for await (const event of session.events) events.push(event);
        })();
  cleanups.push(async () => {
    await session.close();
    await consumption;
  });
  return { session, written, events, send, parent, consumption, end: () => connection.close() };
}
const hasReady = (events: SessionEvent[]) =>
  events.some((event) => event.payload.type === "state" && event.payload.phase === "ready");

describe("one-attempt session", () => {
  test("returns before connect; reports safe asynchronous failure and contiguous generation", async () => {
    const factory = createSessionFactory({
      transport: {
        async connect() {
          return {
            ok: false,
            error: { code: "network", message: "Unable to connect.", retryable: true },
          };
        },
      },
      secrets,
      clock,
    });
    const opened = await factory.open(profile, { networkId, generation: 1 }, signal());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const events: SessionEvent[] = [];
    for await (const event of opened.value.events) events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.networkId === networkId && event.generation === 1)).toBe(
      true,
    );
    expect(events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
  });
  test("CAP registration, PING during registration, SASL PLAIN and authenticated ready gate", async () => {
    const fixture = await harness({
      capabilities: "sasl=PLAIN server-time message-tags multi-prefix account-notify",
      sasl: {
        mechanism: "PLAIN",
        account: "fixture-account",
        password: entityId<"secret-ref">("env:FIXTURE"),
        required: true,
      },
      onWrite(frame, send) {
        if (frame.command === "USER") send("PING :register-token");
      },
    });
    await until(() => hasReady(fixture.events));
    expect(
      fixture.written.some(
        (frame) => frame.command === "PONG" && frame.params[0] === "register-token",
      ),
    ).toBe(true);
    const auth = fixture.written.find(
      (frame) => frame.command === "AUTHENTICATE" && frame.params[0] !== "PLAIN",
    );
    expect(atob(auth!.params[0]!)).toBe("fixture-account\0fixture-account\0fixture-password");
    expect(
      fixture.events.find(
        (event) => event.payload.type === "state" && event.payload.phase === "ready",
      )?.payload,
    ).toMatchObject({ authenticated: true, secure: true });
    expect(JSON.stringify(fixture.events)).not.toContain("fixture-password");
    expect(fixture.events.find((event) => event.payload.type === "support")?.payload).toMatchObject(
      { features: { history: false, typing: true, reactions: false } },
    );
  });
  test("rejects plaintext credentials and never becomes ready when required SASL unavailable", async () => {
    const factory = createSessionFactory({
      transport: {
        async connect() {
          throw new Error("must not connect");
        },
      },
      secrets,
      clock,
    });
    const result = await factory.open(
      {
        ...profile,
        endpoints: [{ host: "x", port: 6667, tls: false }],
        sasl: {
          mechanism: "PLAIN",
          account: "fixture",
          password: entityId<"secret-ref">("env:FIXTURE"),
          required: true,
        },
      },
      { networkId, generation: 1 },
      signal(),
    );
    expect(!result.ok && result.error.code).toBe("authentication");
    const fixture = await harness({
      sasl: {
        mechanism: "PLAIN",
        account: "fixture",
        password: entityId<"secret-ref">("env:FIXTURE"),
        required: true,
      },
    });
    await fixture.consumption;
    expect(hasReady(fixture.events)).toBe(false);
    expect(fixture.written.some((frame) => frame.command === "JOIN")).toBe(false);
  });
  test("plaintext keyed JOIN fails before resolving or transmitting the secret", async () => {
    let resolutions = 0;
    const fixture = await harness({
      tls: false,
      secretProvider: {
        ...secrets,
        async resolve() {
          resolutions++;
          return { ok: true, value: "must-never-resolve" };
        },
      },
    });
    await until(() => hasReady(fixture.events));
    const result = await fixture.session.execute(
      { type: "join", channel: "#room", key: entityId<"secret-ref">("env:CHANNEL_KEY") },
      op("keyed-join"),
      signal(),
    );
    expect(!result.ok && result.error.code).toBe("authentication");
    expect(resolutions).toBe(0);
    expect(fixture.written.some((frame) => frame.command === "JOIN")).toBe(false);
    expect(JSON.stringify(fixture.events)).not.toContain("must-never-resolve");
  });
  test("SASL rejection terminates required auth with no credentials in events", async () => {
    const fixture = await harness({
      capabilities: "sasl",
      sasl: {
        mechanism: "PLAIN",
        account: "fixture",
        password: entityId<"secret-ref">("env:FIXTURE"),
        required: true,
      },
      onWrite(frame, send) {
        if (frame.command === "AUTHENTICATE" && frame.params[0] !== "PLAIN") {
          send(":s 904 me :fixture-password");
          return { ok: true, value: undefined };
        }
      },
    });
    await fixture.consumption;
    expect(hasReady(fixture.events)).toBe(false);
    expect(JSON.stringify(fixture.events)).not.toContain("fixture-password");
  });
  test("NAMES races preserve newer removals, joins, nicks and prefix mode changes", async () => {
    const fixture = await harness();
    await until(() => hasReady(fixture.events));
    fixture.send(":me!u@h JOIN #room");
    fixture.send(":s 353 me = #room :@old +bob me");
    fixture.send(":old!u@h PART #room :gone");
    fixture.send(":new!u@h JOIN #room");
    fixture.send(":bob!u@h NICK robert");
    fixture.send(":s MODE #room +o robert");
    fixture.send(":s 353 me = #room :@old +bob");
    fixture.send(":s 366 me #room :done");
    await until(() =>
      fixture.events.some(
        (event) => event.payload.type === "membership" && event.payload.change.nick === "robert",
      ),
    );
    const members = fixture.events.flatMap((event) =>
      event.payload.type === "membership" ? [event.payload.change] : [],
    );
    expect(members.some((change) => change.kind === "join" && change.nick === "old")).toBe(false);
    expect(members.some((change) => change.kind === "join" && change.nick === "bob")).toBe(false);
    expect(members.some((change) => change.kind === "join" && change.nick === "new")).toBe(true);
    expect(
      members.some(
        (change) =>
          change.kind === "prefixes" && change.nick === "robert" && change.prefixes.includes("@"),
      ),
    ).toBe(true);
  });
  test("chat/actions/notices, topics, away/account and server-time are sanitized", async () => {
    const fixture = await harness();
    await until(() => hasReady(fixture.events));
    fixture.send(
      "@time=2026-01-01T00:00:00.000Z;msgid=abc;account=alice :alice!u@h PRIVMSG #room :hello \x1b[31mred\x1b[0m",
    );
    fixture.send(":alice!u@h PRIVMSG me :\x01ACTION waves\x01");
    fixture.send(":s NOTICE me :notice");
    fixture.send(":s 332 me #room :topic\x1b]0;evil\x07");
    fixture.send(":alice!u@h AWAY :away");
    fixture.send(":alice!u@h ACCOUNT alice-account");
    await until(() => fixture.events.some((event) => event.payload.type === "account"));
    const chats = fixture.events.flatMap((event) =>
      event.payload.type === "chat" ? [event.payload.message] : [],
    );
    expect(chats).toHaveLength(3);
    expect(chats[0]).toMatchObject({
      text: "hello red",
      serverId: "abc",
      serverTime: Date.parse("2026-01-01T00:00:00.000Z"),
      sender: { account: "alice" },
    });
    expect(chats[1]).toMatchObject({ kind: "action", text: "waves" });
    expect(JSON.stringify(fixture.events)).not.toContain("evil");
  });
  test("UTF-8 splitting and reliably labeled aggregate echo, no text deduplication", async () => {
    const fixture = await harness({
      capabilities: "message-tags batch labeled-response echo-message",
      onWrite(frame, send) {
        if (frame.command === "PRIVMSG")
          send(`@label=${frame.tags.label} :me!u@h PRIVMSG ${frame.params[0]} :${frame.params[1]}`);
      },
    });
    await until(() => hasReady(fixture.events));
    const text = "🐈".repeat(400);
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text, kind: "text" },
          op("send-1"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await until(() =>
      fixture.events.some(
        (event) => event.payload.type === "send-state" && event.payload.state === "echo-observed",
      ),
    );
    expect(fixture.written.filter((frame) => frame.command === "PRIVMSG").length).toBeGreaterThan(
      1,
    );
    const own = fixture.events.flatMap((event) =>
      event.payload.type === "chat" && event.payload.message.operationId
        ? [event.payload.message]
        : [],
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.text).toBe(text);
    expect(own[0]?.serverId).toBeUndefined();
    fixture.send(":alice!u@h PRIVMSG #room :repeat");
    fixture.send(":alice!u@h PRIVMSG #room :repeat");
    await until(() => fixture.events.filter((event) => event.payload.type === "chat").length === 3);
  });
  test.each(["text", "notice", "action"] as const)(
    "deliberate LF %s fallback preserves paste lines and aggregates a reliable echo",
    async (kind) => {
      const times: number[] = [];
      const fixture = await harness({
        capabilities: "message-tags batch labeled-response echo-message",
        policy: { floodIntervalMs: 2 },
        onWrite(frame, send) {
          if (frame.command === "PRIVMSG" || frame.command === "NOTICE") {
            times.push(Date.now());
            send(
              `@label=${frame.tags.label} :me!u@h ${frame.command} ${frame.params[0]} :${frame.params[1]}`,
            );
          }
        },
      });
      await until(() => hasReady(fixture.events));
      const text = "hello 🐈\n/join #not-a-command\n\nlast line\n";
      expect(
        (
          await fixture.session.execute(
            { type: "send", target: "#room", text, kind },
            op("multiline"),
            signal(),
          )
        ).ok,
      ).toBe(true);
      await until(() =>
        fixture.events.some(
          (event) => event.payload.type === "send-state" && event.payload.state === "echo-observed",
        ),
      );
      const lines = fixture.written.filter(
        (frame) => frame.command === "PRIVMSG" || frame.command === "NOTICE",
      );
      const expected = ["hello 🐈", "/join #not-a-command", " ", "last line", " "];
      expect(lines.map((frame) => frame.params[1])).toEqual(
        kind === "action" ? expected.map((line) => `\x01ACTION ${line}\x01`) : expected,
      );
      expect(fixture.written.some((frame) => frame.command === "JOIN")).toBe(false);
      expect(times.slice(1).every((time, index) => time - times[index]! >= 2)).toBe(true);
      const echoes = fixture.events.flatMap((event) =>
        event.payload.type === "chat" && event.payload.message.operationId === op("multiline")
          ? [event.payload.message]
          : [],
      );
      expect(echoes).toHaveLength(1);
      expect(echoes[0]).toMatchObject({ text, kind });
      expect(echoes[0]?.serverId).toBeUndefined();
      expect(
        fixture.events.some(
          (event) => event.payload.type === "notice" && event.payload.text.includes("single space"),
        ),
      ).toBe(true);
    },
  );
  test("multiline bounds and CR/NUL reject before admission without partial transmission", async () => {
    const fixture = await harness({
      policy: {
        maxSendBytes: 12,
        maxSendFragments: 2,
        maxQueueFragments: 3,
        floodIntervalMs: 1000,
      },
    });
    await until(() => hasReady(fixture.events));
    for (const [index, text] of ["a\rb", "a\0b", "a\nb\nc", "🐈".repeat(4)].entries()) {
      expect(
        (
          await fixture.session.execute(
            { type: "send", target: "#room", text, kind: "text" },
            op(`bad-${index}`),
            signal(),
          )
        ).ok,
      ).toBe(false);
    }
    expect(fixture.written.some((frame) => frame.command === "PRIVMSG")).toBe(false);
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text: "a\nb", kind: "text" },
          op("accepted"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text: "c\nd", kind: "text" },
          op("queue-fragments"),
          signal(),
        )
      ).ok,
    ).toBe(false);
  });
  test("LIST and WHOIS serialize overlapping requests and correlate typed results", async () => {
    const fixture = await harness();
    await until(() => hasReady(fixture.events));
    expect(
      (await fixture.session.execute({ type: "whois", nick: "alice" }, op("who-1"), signal())).ok,
    ).toBe(true);
    expect(
      (await fixture.session.execute({ type: "whois", nick: "bob" }, op("who-2"), signal())).ok,
    ).toBe(false);
    fixture.send(":s 311 me alice user host * :Alice Person");
    fixture.send(":s 319 me alice :@#room +#other");
    fixture.send(":s 330 me alice account :logged in");
    fixture.send(":s 318 me alice :done");
    expect((await fixture.session.execute({ type: "list" }, op("list-1"), signal())).ok).toBe(true);
    expect((await fixture.session.execute({ type: "list" }, op("list-2"), signal())).ok).toBe(
      false,
    );
    fixture.send(":s 322 me #room 12 :Room topic");
    fixture.send(":s 323 me :done");
    await until(() => fixture.events.some((event) => event.payload.type === "directory-complete"));
    expect(
      fixture.events.find((event) => event.payload.type === "user-details")?.payload,
    ).toMatchObject({
      operationId: op("who-1"),
      details: {
        nick: "alice",
        username: "user",
        hostname: "host",
        account: "account",
        channels: ["@#room", "+#other"],
      },
    });
    expect(
      fixture.events.find((event) => event.payload.type === "directory-item")?.payload,
    ).toMatchObject({ operationId: op("list-1"), item: { channel: "#room", userCount: 12 } });
  });
  test("bounded event overflow preserves terminal outcome and sequence", async () => {
    const fixture = await harness({ autoConsume: false, policy: { maxEvents: 8 } });
    await until(() => fixture.written.some((frame) => frame.params[0] === "END"));
    for (let index = 0; index < 20; index++) fixture.send(`:alice!u@h PRIVMSG #room :${index}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events: SessionEvent[] = [];
    for await (const event of fixture.session.events) events.push(event);
    expect(events.length).toBeLessThanOrEqual(10);
    expect(events.at(-2)?.payload).toMatchObject({ type: "error", error: { code: "unavailable" } });
    expect(events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });
  test("admission cancellation, unsupported features, bounded queues, and abort cleanup", async () => {
    const fixture = await harness({ policy: { floodIntervalMs: 1000, maxQueueCommands: 1 } });
    await until(() => hasReady(fixture.events));
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text: "not written", kind: "text" },
          op("cancel"),
          cancelled.signal,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await fixture.session.execute(
          { type: "typing", target: "#room", active: true },
          op("typing"),
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text: "x".repeat(1000), kind: "text" },
          op("slow"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await fixture.session.execute(
          { type: "send", target: "#room", text: "rejected", kind: "text" },
          op("overflow"),
          signal(),
        )
      ).ok,
    ).toBe(false);
    fixture.parent.abort();
    await fixture.consumption;
    expect(
      fixture.events.some(
        (event) =>
          event.payload.type === "send-state" &&
          event.payload.operationId === op("slow") &&
          event.payload.state === "uncertain",
      ),
    ).toBe(true);
    expect((await fixture.session.close()).ok).toBe(true);
  });
  test("modern history, replies, typing, reactions and draft state updates are real semantic events", async () => {
    const fixture = await harness({
      capabilities:
        "message-tags server-time batch labeled-response echo-message draft/chathistory draft/read-marker draft/message-redaction",
    });
    await until(() => hasReady(fixture.events));
    fixture.send(
      "@msgid=original;time=2026-01-01T00:00:00.000Z :alice!u@h PRIVMSG #room :original",
    );
    await until(() =>
      fixture.events.some(
        (event) => event.payload.type === "support" && event.payload.features.replies,
      ),
    );
    expect(
      (
        await fixture.session.execute(
          {
            type: "send",
            target: "#room",
            text: "reply",
            kind: "text",
            replyToServerId: "original",
          },
          op("reply"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await until(() => fixture.written.some((frame) => frame.command === "PRIVMSG"));
    expect(fixture.written.find((frame) => frame.command === "PRIVMSG")?.tags["+reply"]).toBe(
      "original",
    );
    expect(
      (
        await fixture.session.execute(
          { type: "history", target: "#room", limit: 2 },
          op("history"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await until(() => fixture.written.some((frame) => frame.command === "CHATHISTORY"));
    const history = fixture.written.find((frame) => frame.command === "CHATHISTORY")!;
    fixture.send(
      `@label=${history.tags.label};draft/chathistory-end :s BATCH +past chathistory #room`,
    );
    fixture.send(
      "@batch=past;msgid=old;time=2025-12-31T00:00:00.000Z;+reply=missing-original :alice!u@h PRIVMSG #room :old reply",
    );
    fixture.send("@msgid=new :bob!u@h PRIVMSG #room :interleaved live");
    fixture.send("@batch=past :ghost!u@h JOIN #room");
    fixture.send(":s BATCH -past");
    fixture.send("@+typing=active :alice!u@h TAGMSG #room");
    fixture.send("@+reply=original;+draft/react=🐈 :bob!u@h TAGMSG #room");
    fixture.send(":s MARKREAD #room timestamp=2026-01-01T00:00:00.000Z");
    fixture.send(":alice!u@h REDACT #room original");
    await until(() => fixture.events.some((event) => event.payload.type === "redaction"));
    expect(
      fixture.events.find((event) => event.payload.type === "history-complete")?.payload,
    ).toMatchObject({ operationId: op("history"), target: "#room", hasMore: false });
    expect(
      fixture.events.find(
        (event) => event.payload.type === "chat" && event.payload.message.serverId === "old",
      )?.payload,
    ).toMatchObject({ message: { source: "playback", replyToServerId: "missing-original" } });
    expect(
      fixture.events.find(
        (event) => event.payload.type === "chat" && event.payload.message.serverId === "new",
      )?.payload,
    ).toMatchObject({ message: { source: "live" } });
    expect(
      fixture.events.some(
        (event) => event.payload.type === "membership" && event.payload.change.nick === "ghost",
      ),
    ).toBe(false);
    expect(
      fixture.events.some((event) => event.payload.type === "typing" && event.payload.active),
    ).toBe(true);
    expect(
      fixture.events.some(
        (event) => event.payload.type === "reaction" && event.payload.value === "🐈",
      ),
    ).toBe(true);
    expect(fixture.events.some((event) => event.payload.type === "read-marker")).toBe(true);
  });
  test("CAP timeout falls back only when authentication is not required", async () => {
    const fixture = await harness({
      policy: { capTimeoutMs: 10 },
      onWrite(frame) {
        if (frame.command === "CAP" && frame.params[0] === "LS")
          return { ok: true, value: undefined };
      },
    });
    await until(() => hasReady(fixture.events));
    expect(
      fixture.events.some(
        (event) => event.payload.type === "notice" && event.payload.text.includes("timed out"),
      ),
    ).toBe(true);
    const required = await harness({
      capabilities: "sasl",
      sasl: {
        mechanism: "PLAIN",
        account: "fixture",
        password: entityId<"secret-ref">("env:FIXTURE"),
        required: true,
      },
      policy: { capTimeoutMs: 10 },
      onWrite(frame) {
        if (frame.command === "CAP" && frame.params[0] === "LS")
          return { ok: true, value: undefined };
      },
    });
    await required.consumption;
    expect(hasReady(required.events)).toBe(false);
    expect(
      required.events.some(
        (event) => event.payload.type === "error" && event.payload.error.code === "authentication",
      ),
    ).toBe(true);
  });
  test("partial capability rejection disables unsafe echo correlation and publishes ACKs only", async () => {
    const fixture = await harness({
      capabilities: "message-tags batch labeled-response echo-message draft/future",
      onWrite(frame, send) {
        if (frame.command === "CAP" && frame.params[0] === "REQ") {
          if (frame.params[1]?.startsWith("-")) send(":s CAP me ACK :-echo-message");
          else {
            send(":s CAP me ACK :message-tags echo-message");
            send(":s CAP me NAK :batch labeled-response");
          }
          return { ok: true, value: undefined };
        }
      },
    });
    await until(() => hasReady(fixture.events));
    const support = fixture.events.find((event) => event.payload.type === "support")?.payload;
    expect(support?.type === "support" && support.support.capabilities).toEqual({
      "message-tags": null,
    });
    expect(
      fixture.written.some(
        (frame) => frame.command === "CAP" && frame.params[1] === "-echo-message",
      ),
    ).toBe(true);
  });
  test("registration timeout and missing keepalive PONG terminate attempts", async () => {
    const registration = await harness({
      policy: { registrationTimeoutMs: 10, capTimeoutMs: 5 },
      onWrite(frame) {
        if (frame.command === "CAP" && frame.params[0] === "END")
          return { ok: true, value: undefined };
      },
    });
    await registration.consumption;
    expect(hasReady(registration.events)).toBe(false);
    expect(
      registration.events.some(
        (event) =>
          event.payload.type === "error" &&
          event.payload.error.message.includes("registration timed out"),
      ),
    ).toBe(true);
    const stale = await harness({ policy: { keepaliveMs: 10, staleTimeoutMs: 30 } });
    await stale.consumption;
    expect(stale.written.some((frame) => frame.command === "PING")).toBe(true);
    expect(
      stale.events.some(
        (event) =>
          event.payload.type === "error" &&
          event.payload.error.message.includes("keepalive timed out"),
      ),
    ).toBe(true);
  });
  test("a missing MOTD after registration is informational, not a connection error", async () => {
    const fixture = await harness();
    await until(() => hasReady(fixture.events));
    fixture.send(":s 422 me :untrusted raw MOTD failure");
    await until(() =>
      fixture.events.some(
        (event) =>
          event.payload.type === "notice" &&
          event.payload.text === "The server has no message of the day.",
      ),
    );
    expect(fixture.events.some((event) => event.payload.type === "error")).toBe(false);
    expect(JSON.stringify(fixture.events)).not.toContain("untrusted raw MOTD failure");
    fixture.send(":s 404 me #room :still a real request rejection");
    await until(() => fixture.events.some((event) => event.payload.type === "error"));
    expect(fixture.events.at(-1)?.payload).toMatchObject({
      type: "error",
      error: { code: "unavailable", message: "You cannot send to this channel." },
    });
  });
  test("query timeouts quarantine late replies; limits fail explicitly; unknown numerics stay safe", async () => {
    const fixture = await harness({
      policy: { queryTimeoutMs: 5, keepaliveMs: 10, staleTimeoutMs: 1000, maxDirectoryItems: 1 },
    });
    await until(() => hasReady(fixture.events));
    await fixture.session.execute({ type: "whois", nick: "alice" }, op("who-timeout"), signal());
    await until(() =>
      fixture.events.some(
        (event) =>
          event.payload.type === "error" && event.payload.operationId === op("who-timeout"),
      ),
    );
    expect(
      (await fixture.session.execute({ type: "whois", nick: "bob" }, op("late-whois"), signal()))
        .ok,
    ).toBe(false);
    fixture.send(":s 311 me alice user host * :late");
    fixture.send(":s 318 me alice :done");
    fixture.send(":s 799 me :secret-ish raw reply");
    await fixture.session.execute({ type: "list" }, op("limit-list"), signal());
    fixture.send(":s 322 me #a 1 :A");
    fixture.send(":s 322 me #b 2 :B");
    fixture.send(":s 323 me :done");
    await until(() =>
      fixture.events.some(
        (event) => event.payload.type === "error" && event.payload.operationId === op("limit-list"),
      ),
    );
    expect(fixture.events.some((event) => event.payload.type === "user-details")).toBe(false);
    expect(fixture.events.filter((event) => event.payload.type === "directory-item")).toHaveLength(
      1,
    );
    expect(JSON.stringify(fixture.events)).not.toContain("secret-ish");
  });
  test("close is idempotent, emits best-effort QUIT and ends pending iterator", async () => {
    const fixture = await harness();
    await until(() => hasReady(fixture.events));
    const first = fixture.session.close("bye");
    const second = fixture.session.close("ignored");
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    await fixture.consumption;
    expect(fixture.written.filter((frame) => frame.command === "QUIT")).toHaveLength(1);
    expect(fixture.events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
  });
  test("disconnect during write is uncertain, never auto-replayed", async () => {
    let count = 0;
    const fixture = await harness({
      onWrite(frame) {
        if (frame.command === "PRIVMSG") {
          count++;
          return {
            ok: false,
            error: { code: "network", message: "Fixture write failed.", retryable: true },
          };
        }
      },
    });
    await until(() => hasReady(fixture.events));
    await fixture.session.execute(
      { type: "send", target: "#room", text: "message", kind: "text" },
      op("failed"),
      signal(),
    );
    await fixture.consumption;
    expect(count).toBe(1);
    expect(
      fixture.events.find((event) => event.payload.type === "send-state")?.payload,
    ).toMatchObject({ state: "uncertain" });
  });
});
