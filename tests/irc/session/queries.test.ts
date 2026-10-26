// Request/response flows (WHOIS, LIST, message sends), channel-state reconciliation details
// and transport-level failure handling that need a scripted server.
import { afterEach, describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { Result } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionEvent } from "../../../src/contracts/session";
import type { ByteConnection } from "../../../src/contracts/transport";
import { createSessionFactory } from "../../../src/irc/session";
import {
  clock,
  closeSessions,
  harness,
  networkId,
  of,
  op,
  profile,
  ready,
  receive,
  secrets,
  signal,
  until,
} from "./harness";
import type { Fixture } from "./harness";

afterEach(closeSessions);

const payloads = (fixture: Fixture) => fixture.events.map((event) => event.payload);
const errors = (fixture: Fixture) => of(payloads(fixture), "error");
const errorCodes = (fixture: Fixture) => errors(fixture).map((event) => event.error.code);
const whois = (fixture: Fixture, nick: string, id: string) =>
  fixture.session.execute({ type: "whois", nick }, op(id), signal());
const list = (fixture: Fixture, id: string) =>
  fixture.session.execute({ type: "list" }, op(id), signal());
const codeOf = (result: Result<void>) => (result.ok ? "ok" : result.error.code);

describe("WHOIS", () => {
  test("collects details across several replies and ignores replies about other nicknames", async () => {
    const fixture = await ready();
    await whois(fixture, "Alice", "who");
    await until(() => fixture.written.some((frame) => frame.command === "WHOIS"));
    const received = await receive(
      fixture,
      ":s 311 me alice user host * :Alice Person",
      ":s 311 me mallory evil host * :Someone Else",
      ":s 319 me alice :@#one +#two",
      ":s 319 me alice :#three",
      ":s 301 me alice :out to lunch",
      ":s 330 me alice acct :is logged in as",
      ":s 318 me mallory :End of /WHOIS list.",
      ":s 318 me ALICE :End of /WHOIS list.",
    );
    expect(of(received, "user-details")).toEqual([
      {
        type: "user-details",
        operationId: op("who"),
        details: {
          nick: "Alice",
          username: "user",
          hostname: "host",
          realname: "Alice Person",
          channels: ["@#one", "+#two", "#three"],
          awayReason: "out to lunch",
          account: "acct",
        },
      },
    ]);
    expect(of(received, "error")).toEqual([]);
    expect(codeOf(await whois(fixture, "bob", "next"))).toBe("ok");
  });

  test("a no-such-nick answer fails the request once and swallows the terminator", async () => {
    const fixture = await ready();
    await whois(fixture, "ghost", "who");
    const received = await receive(
      fixture,
      ":s 401 me ghost :No such nick/channel",
      ":s 318 me ghost :End of /WHOIS list.",
    );
    expect(of(received, "user-details")).toEqual([]);
    expect(of(received, "error")).toMatchObject([
      { operationId: op("who"), error: { message: "IRC user was not found." } },
    ]);
    expect(codeOf(await whois(fixture, "again", "next"))).toBe("ok");
  });

  test("a 401 about someone else is an ordinary rejection, not the WHOIS result", async () => {
    const fixture = await ready();
    await whois(fixture, "alice", "who");
    const received = await receive(fixture, ":s 401 me bob :No such nick/channel");
    expect(of(received, "error")).toMatchObject([
      { error: { message: "No such nickname or channel." } },
    ]);
    expect(of(received, "error")[0]).not.toHaveProperty("operationId");
  });

  test("more channels than the bound fails the request instead of truncating", async () => {
    const fixture = await ready({ policy: { maxChannels: 2 } });
    await whois(fixture, "alice", "who");
    const received = await receive(
      fixture,
      ":s 319 me alice :#a #b #c",
      ":s 318 me alice :End of /WHOIS list.",
    );
    expect(of(received, "user-details")).toEqual([]);
    expect(of(received, "error")).toMatchObject([
      { operationId: op("who"), error: { message: "WHOIS channel limit exceeded." } },
    ]);
  });

  test("a silent server times out; the slot stays quarantined until the late terminator", async () => {
    const fixture = await ready({ policy: { queryTimeoutMs: 30 } });
    await whois(fixture, "alice", "who");
    await until(() => errors(fixture).length === 1);
    expect(errors(fixture)[0]).toMatchObject({ operationId: op("who") });
    expect(codeOf(await whois(fixture, "bob", "blocked"))).toBe("conflict");
    const received = await receive(fixture, ":s 311 me alice u h * :late", ":s 318 me alice :end");
    expect(of(received, "user-details")).toEqual([]);
    expect(codeOf(await whois(fixture, "bob", "free"))).toBe("ok");
  });
});

describe("LIST", () => {
  test("streams typed items, skips malformed counts and unsolicited rows, then completes", async () => {
    const fixture = await ready();
    const stray = await receive(fixture, ":s 322 me #stray 3 :nobody asked");
    expect(of(stray, "directory-item")).toEqual([]);
    await list(fixture, "list");
    const received = await receive(
      fixture,
      ":s 321 me Channel :Users Name",
      ":s 322 me #a 5 :[+nt] Topic A",
      ":s 322 me #b many :bad count",
      ":s 322 me #c -1 :negative",
      ":s 322 me #d 0",
      ":s 323 me :End of /LIST",
    );
    expect(of(received, "directory-item")).toEqual([
      {
        type: "directory-item",
        operationId: op("list"),
        item: { channel: "#a", userCount: 5, topic: "[+nt] Topic A" },
      },
      {
        type: "directory-item",
        operationId: op("list"),
        item: { channel: "#d", userCount: 0, topic: "" },
      },
    ]);
    expect(of(received, "directory-complete")).toEqual([
      { type: "directory-complete", operationId: op("list") },
    ]);
    expect(codeOf(await list(fixture, "again"))).toBe("ok");
  });

  test("exceeding the item bound fails explicitly and ignores the rest of the listing", async () => {
    const fixture = await ready({ policy: { maxDirectoryItems: 2 } });
    await list(fixture, "list");
    const received = await receive(
      fixture,
      ":s 322 me #a 1 :a",
      ":s 322 me #b 1 :b",
      ":s 322 me #c 1 :c",
      ":s 322 me #d 1 :d",
      ":s 323 me :End of /LIST",
    );
    expect(of(received, "directory-item")).toHaveLength(2);
    expect(of(received, "error")).toMatchObject([
      { operationId: op("list"), error: { code: "rate-limited" } },
    ]);
    // The terminator frees the slot without claiming completion of a truncated listing.
    expect(of(received, "directory-complete")).toEqual([]);
    expect(codeOf(await list(fixture, "again"))).toBe("ok");
  });
});

describe("message sends", () => {
  const echoCaps = "message-tags batch labeled-response echo-message";
  const sendText = (fixture: Fixture, id: string, extra: object = {}) =>
    fixture.session.execute(
      { type: "send", target: "#room", text: "hello", kind: "text", ...extra },
      op(id),
      signal(),
    );
  const states = (fixture: Fixture) => of(payloads(fixture), "send-state").map((e) => e.state);

  test("a missing echo becomes uncertain, never delivered or failed", async () => {
    const fixture = await ready({ capabilities: echoCaps, policy: { queryTimeoutMs: 30 } });
    await sendText(fixture, "s");
    await until(() => states(fixture).includes("uncertain"));
    expect(states(fixture)).toEqual(["written", "uncertain"]);
    expect(of(payloads(fixture), "send-state").at(-1)?.error?.message).toBe(
      "Server echo was not observed.",
    );
  });

  test("without echo support nothing is claimed after the write", async () => {
    const fixture = await ready({ policy: { queryTimeoutMs: 30 } });
    await sendText(fixture, "s");
    await until(() => states(fixture).includes("written"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(states(fixture)).toEqual(["written"]);
  });

  test.each([
    ["numeric", (label: string) => `@label=${label} :s 404 me #room :Cannot send to channel`],
    ["FAIL", (label: string) => `@label=${label} :s FAIL PRIVMSG CANNOT_SEND #room :Denied`],
  ])("a labeled %s rejection fails the send without a chat event", async (_name, reply) => {
    const fixture = await ready({
      capabilities: echoCaps,
      onWrite(frame, send) {
        if (frame.command === "PRIVMSG") send(reply(frame.tags.label!));
      },
    });
    await sendText(fixture, "s");
    await until(() => states(fixture).includes("failed"));
    expect(of(payloads(fixture), "chat")).toEqual([]);
    expect(of(payloads(fixture), "send-state").at(-1)?.error?.message).toMatch(
      /rejected a message fragment/,
    );
    // Rejection is reported once and does not poison later sends.
    expect(codeOf(await sendText(fixture, "again"))).toBe("ok");
  });

  test("a reply to a malformed message id is refused after replies became available", async () => {
    const fixture = await ready({ capabilities: "message-tags" });
    await receive(fixture, "@msgid=abc :alice!u@h PRIVMSG #room :hi");
    expect(codeOf(await sendText(fixture, "bad", { replyToServerId: "a b" }))).toBe(
      "invalid-input",
    );
    expect(codeOf(await sendText(fixture, "good", { replyToServerId: "abc" }))).toBe("ok");
    await until(() => fixture.written.some((frame) => frame.tags["+reply"] === "abc"));
  });

  test("a frame that cannot be encoded fails only its own operation", async () => {
    const fixture = await ready();
    const huge = "x".repeat(600);
    expect(
      codeOf(
        await fixture.session.execute(
          { type: "topic", channel: "#a", text: huge },
          op("t"),
          signal(),
        ),
      ),
    ).toBe("ok");
    await until(() => errors(fixture).length === 1);
    expect(errors(fixture)[0]).toMatchObject({ operationId: op("t") });
    expect(fixture.written.some((frame) => frame.command === "TOPIC")).toBe(false);
    expect(
      codeOf(await fixture.session.execute({ type: "away", reason: "x" }, op("a"), signal())),
    ).toBe("ok");
  });

  test("a throwing socket write ends the session and leaves the send uncertain or failed", async () => {
    const fixture = await ready({
      onWrite(frame) {
        if (frame.command === "PRIVMSG") throw new Error("reset by peer");
      },
    });
    await sendText(fixture, "s");
    await fixture.consumption;
    expect(errorCodes(fixture)).toContain("network");
    expect(states(fixture).at(-1)).toMatch(/failed|uncertain/);
  });
});

describe("channel state", () => {
  test("extended-join announces the account, with * meaning logged out", async () => {
    const fixture = await ready({ capabilities: "extended-join" });
    const received = await receive(
      fixture,
      ":alice!u@h JOIN #c acct :Alice Real",
      ":bob!u@h JOIN #c * :Bob Real",
    );
    expect(of(received, "account")).toEqual([
      { type: "account", nick: "alice", account: "acct" },
      { type: "account", nick: "bob", account: null },
    ]);
  });

  test("without extended-join the extra JOIN parameter is not trusted as an account", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":alice!u@h JOIN #c acct :Alice Real");
    expect(of(received, "account")).toEqual([]);
  });

  test("JOIN/PART/NAMES for names that are not channels, or channels we are not in, do nothing", async () => {
    const fixture = await ready();
    const received = await receive(
      fixture,
      ":alice!u@h JOIN notachannel",
      ":alice!u@h PART #never",
      ":s 353 me = notachannel :a b",
      ":s 353 me = #c :",
    );
    expect(of(received, "membership").map((event) => event.change.kind)).toEqual([]);
  });

  test("NAMES entries that cannot be nicknames are skipped, not fatal", async () => {
    const fixture = await ready();
    const received = await receive(
      fixture,
      ":me!u@h JOIN #c",
      ":s 353 me = #c :@ ok,bad @+good",
      ":s 366 me #c :End of /NAMES list.",
    );
    const joined = of(received, "membership").flatMap((event) =>
      event.change.kind === "join" ? [event.change.nick] : [],
    );
    expect(joined).toEqual(expect.arrayContaining(["me", "good"]));
    expect(joined).not.toContain("ok,bad");
    expect(errors(fixture)).toEqual([]);
  });

  test("a later NAMES reply removes members that are no longer present", async () => {
    const fixture = await ready();
    await receive(
      fixture,
      ":me!u@h JOIN #c",
      ":s 353 me = #c :me alice",
      ":s 366 me #c :End of /NAMES list.",
    );
    const received = await receive(
      fixture,
      ":s 353 me = #c :me",
      ":s 366 me #c :End of /NAMES list.",
    );
    expect(of(received, "membership").map((event) => event.change)).toEqual([
      { kind: "remove", nick: "alice", reason: "" },
    ]);
  });

  test("a mode change that names no target is ignored", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":me!u@h JOIN #c", ":s MODE #c +o");
    expect(of(received, "membership").map((event) => event.change.kind)).toEqual(["join"]);
  });

  test.each([
    ["432", ":s 432 me bad!nick :Erroneous nickname", "The nickname is invalid."],
    [
      "437 for a channel",
      ":s 437 me #c :Nick/channel is temporarily unavailable",
      "The channel is temporarily unavailable.",
    ],
  ])("%s after registration is a readable rejection", async (_name, line, message) => {
    const fixture = await ready();
    expect(of(await receive(fixture, line), "error")).toMatchObject([{ error: { message } }]);
  });

  test("437 about a nickname after registration is reported as a conflict", async () => {
    const fixture = await ready();
    const received = await receive(
      fixture,
      ":s 437 me wanted :Nick/channel is temporarily unavailable",
    );
    expect(of(received, "error")).toMatchObject([{ error: { code: "conflict" } }]);
  });

  test("an unnegotiated or unknown batch reference ends the session", async () => {
    for (const line of ["@batch=nope :a!u@h PRIVMSG #c :x", "BATCH +one custom"]) {
      const fixture = await ready();
      fixture.send(line);
      await fixture.consumption;
      expect(errorCodes(fixture)).toEqual(["network"]);
    }
  });

  test("ACK for a capability we never requested is ignored", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":s CAP me ACK :unrequested");
    expect(of(received, "support")).toEqual([]);
  });
});

describe("registration write failures and transport faults", () => {
  const failure = (command: string) => (frame: IrcFrame) =>
    frame.command === command
      ? { ok: false as const, error: { code: "network" as const, message: "x", retryable: true } }
      : undefined;
  test.each(["PASS", "CAP", "NICK", "USER"])(
    "a failed %s write ends the attempt",
    async (command) => {
      const fixture = await harness({
        serverPassword: entityId<"secret-ref">("env:PW"),
        onWrite: failure(command),
      });
      await fixture.consumption;
      expect(errorCodes(fixture)).toEqual(["network"]);
      expect(fixture.events.at(-1)?.payload).toMatchObject({ phase: "disconnected" });
    },
  );

  const factoryFor = (connect: () => Promise<Result<ByteConnection>>) =>
    createSessionFactory({ transport: { connect }, secrets, clock });
  const drain = async (events: AsyncIterable<SessionEvent>) => {
    const seen: SessionEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  };

  test("a connection that completes after cancellation is closed, not used", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = 0;
    let wrote = 0;
    const abort = new AbortController();
    const opened = await factoryFor(async () => {
      await gate;
      return {
        ok: true,
        value: {
          incoming: (async function* () {})(),
          async write() {
            wrote++;
            return { ok: true, value: undefined };
          },
          async close() {
            closed++;
            return { ok: true, value: undefined };
          },
        },
      };
    }).open(profile, { networkId, generation: 1 }, abort.signal);
    if (!opened.ok) throw new Error("open failed");
    const events = drain(opened.value.events);
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    release();
    const seen = await events;
    expect(seen.at(-1)?.payload).toMatchObject({ phase: "disconnected" });
    expect(wrote).toBe(0);
    expect(closed).toBeGreaterThan(0);
  });

  test("a read failure from the socket is a network error", async () => {
    const opened = await factoryFor(async () => ({
      ok: true,
      value: {
        incoming: (async function* () {
          yield new TextEncoder().encode(":s NOTICE * :hi\r\n");
          throw new Error("ECONNRESET");
        })(),
        async write() {
          return { ok: true, value: undefined };
        },
        async close() {
          return { ok: true, value: undefined };
        },
      },
    })).open(profile, { networkId, generation: 1 }, signal());
    if (!opened.ok) throw new Error("open failed");
    const seen = await drain(opened.value.events);
    expect(
      of(
        seen.map((event) => event.payload),
        "error",
      ),
    ).toMatchObject([{ error: { code: "network" } }]);
  });
});
