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
    secrets,
    clock,
    policy: { floodIntervalMs: 0, ...options.policy },
  });
  const opened = await factory.open(
    { ...profile, ...(options.sasl ? { sasl: options.sasl } : {}) },
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
      { features: { history: false, typing: false, reactions: false } },
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
