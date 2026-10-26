// Connection lifecycle and server-state handling: registration/CAP edge cases, casemapping,
// state bounds, keepalive, stream failures and informational numerics.
import { afterEach, describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionEvent } from "../../../src/contracts/session";
import { closeSessions, harness, hasReady, of, ready, receive, secrets, until } from "./harness";
import type { Fixture } from "./harness";

afterEach(closeSessions);

const payloads = (fixture: Fixture) => fixture.events.map((event) => event.payload);
const lastState = (events: SessionEvent[]) =>
  events.findLast((event) => event.payload.type === "state")?.payload;
const errorCodes = (fixture: Fixture) =>
  of(payloads(fixture), "error").map((event) => event.error.code);
const secret = entityId<"secret-ref">("env:SECRET");
const unavailable = {
  ok: false as const,
  error: { code: "unavailable" as const, message: "no", retryable: false },
};
type Respond = (frame: IrcFrame, send: (line: string) => void) => void;
/** A server whose CAP/registration replies are fully scripted by `respond`. */
const scripted = (respond: Respond) => (frame: IrcFrame, send: (line: string) => void) => {
  respond(frame, send);
  return { ok: true as const, value: undefined };
};
const lastFeatures = (fixture: Fixture) => of(payloads(fixture), "support").at(-1)?.features;

describe("server password", () => {
  test("is resolved privately and sent first, before CAP", async () => {
    const fixture = await ready({
      serverPassword: secret,
      secretProvider: { ...secrets, resolve: async () => ({ ok: true, value: "pw-value" }) },
    });
    expect(fixture.written.slice(0, 2).map((frame) => [frame.command, ...frame.params])).toEqual([
      ["PASS", "pw-value"],
      ["CAP", "LS", "302"],
    ]);
    expect(JSON.stringify(fixture.events)).not.toContain("pw-value");
  });

  test.each([
    ["is unavailable", unavailable],
    ["contains a line break", { ok: true as const, value: "a\nb" }],
  ])("that %s stops the attempt before any IRC traffic", async (_name, outcome) => {
    const fixture = await harness({
      serverPassword: secret,
      secretProvider: { ...secrets, resolve: async () => outcome },
    });
    await fixture.consumption;
    expect(fixture.written).toEqual([]);
    expect(errorCodes(fixture)).toEqual(["authentication"]);
  });
});

describe("capability negotiation", () => {
  test("a multi-line CAP LS is combined into one request", async () => {
    const fixture = await ready({
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS") {
          send(":s CAP * LS * :message-tags server-time");
          send(":s CAP * LS * :multi-prefix");
          send(":s CAP * LS :away-notify sasl=PLAIN");
        }
        if (frame.command === "CAP" && frame.params[0] === "REQ")
          send(`:s CAP * ACK :${frame.params[1]}`);
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }),
    });
    const request = fixture.written.find(
      (frame) => frame.command === "CAP" && frame.params[0] === "REQ",
    );
    // Only advertised capabilities are requested, and nothing is requested before the list ends.
    expect(request?.params[1]?.split(" ").sort()).toEqual([
      "away-notify",
      "message-tags",
      "multi-prefix",
      "server-time",
    ]);
    expect(
      fixture.written.filter((frame) => frame.command === "CAP" && frame.params[0] === "REQ"),
    ).toHaveLength(1);
  });

  test("more advertised capabilities than the bound is a visible failure", async () => {
    const many = Array.from({ length: 129 }, (_, index) => `vendor/cap${index}`).join(" ");
    const fixture = await harness({
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS") {
          // Split to stay inside the per-line byte limit.
          const names = many.split(" ");
          for (let i = 0; i < names.length; i += 20)
            send(`:s CAP * LS * :${names.slice(i, i + 20).join(" ")}`);
        }
      }),
    });
    await fixture.consumption;
    expect(hasReady(fixture.events)).toBe(false);
    expect(errorCodes(fixture)).toContain("network");
  });

  test("a server without CAP (421) falls back to plain registration", async () => {
    const fixture = await ready({
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS")
          send(":s 421 * CAP :Unknown command");
        if (frame.command === "USER") send(":s 001 me :welcome");
      }),
    });
    expect(lastState(fixture.events)).toMatchObject({ phase: "ready" });
  });

  test("a 421 for another command after registration is only an informational notice", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":s 421 me WHO :Unknown command");
    expect(of(received, "notice").map((notice) => notice.text)).toEqual([
      "Server does not support this IRC command.",
    ]);
    expect(of(received, "error")).toEqual([]);
  });

  test("a server that registers us without waiting for CAP END still works with optional SASL", async () => {
    // Some servers ignore CAP entirely; optional authentication must not turn that into a failure.
    const fixture = await ready({
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: false },
      onWrite: scripted((frame, send) => {
        if (frame.command === "USER") send(":s 001 me :welcome");
      }),
    });
    expect(lastState(fixture.events)).toMatchObject({ phase: "ready", authenticated: false });
  });

  test("a server that registers us before required SASL completes is rejected", async () => {
    const fixture = await harness({
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: true },
      onWrite: scripted((frame, send) => {
        if (frame.command === "USER") send(":s 001 me :welcome");
      }),
    });
    await fixture.consumption;
    expect(hasReady(fixture.events)).toBe(false);
    expect(errorCodes(fixture)).toEqual(["authentication"]);
  });

  test("CAP NAK leaves a capability disabled and publishes only what was ACKed", async () => {
    const fixture = await ready({
      capabilities: "message-tags server-time multi-prefix",
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS")
          send(":s CAP * LS :message-tags server-time multi-prefix");
        if (frame.command === "CAP" && frame.params[0] === "REQ")
          send(`:s CAP * NAK :${frame.params[1]}`);
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }),
    });
    expect(of(payloads(fixture), "support").at(-1)?.support.capabilities).toEqual({});
  });

  test("CAP DEL withdraws a capability and its dependent features", async () => {
    const fixture = await ready({
      capabilities:
        "message-tags server-time batch labeled-response echo-message draft/chathistory",
    });
    expect(lastFeatures(fixture)?.history).toBe(true);
    const received = await receive(fixture, ":s CAP me DEL :draft/chathistory");
    expect(of(received, "support").at(-1)?.features.history).toBe(false);
    expect(of(received, "support").at(-1)?.support.capabilities).not.toHaveProperty(
      "draft/chathistory",
    );
  });

  test("losing a dependency of echo-message also gives up echo-message", async () => {
    const fixture = await ready({
      capabilities: "message-tags batch labeled-response echo-message",
    });
    const received = await receive(fixture, ":s CAP me DEL :labeled-response");
    expect(of(received, "support").at(-1)?.support.capabilities).not.toHaveProperty("echo-message");
    expect(
      fixture.written.some(
        (frame) =>
          frame.command === "CAP" &&
          frame.params[0] === "REQ" &&
          frame.params[1] === "-echo-message",
      ),
    ).toBe(true);
  });

  test("echo-message is withdrawn when the server ACKs it but NAKs its dependencies", async () => {
    const fixture = await ready({
      capabilities: "message-tags batch labeled-response echo-message",
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS")
          send(":s CAP * LS :message-tags batch labeled-response echo-message");
        if (
          frame.command === "CAP" &&
          frame.params[0] === "REQ" &&
          !frame.params[1]?.startsWith("-")
        ) {
          send(":s CAP * ACK :echo-message");
          send(":s CAP * NAK :message-tags batch labeled-response");
        }
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }),
    });
    expect(of(payloads(fixture), "support").at(-1)?.support.capabilities).not.toHaveProperty(
      "echo-message",
    );
    expect(
      fixture.written.some(
        (frame) => frame.command === "CAP" && frame.params[1] === "-echo-message",
      ),
    ).toBe(true);
  });

  test.each([
    ["with a plain value list lacking PLAIN", "sasl=EXTERNAL"],
    ["not at all", ""],
  ])("required SASL fails clearly when the server offers it %s", async (_name, sasl) => {
    const fixture = await harness({
      capabilities: `message-tags ${sasl}`,
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: true },
    });
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["authentication"]);
  });

  test("a SASL challenge when none was started, or a stray 903, ends the attempt", async () => {
    for (const line of ["AUTHENTICATE +", ":s 903 me :SASL authentication successful"]) {
      const fixture = await ready();
      fixture.send(line);
      await fixture.consumption;
      expect(errorCodes(fixture)).toEqual(["authentication"]);
    }
  });

  test("unresolvable SASL credentials stop the attempt without leaking them", async () => {
    const fixture = await harness({
      capabilities: "sasl",
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: false },
      secretProvider: { ...secrets, resolve: async () => unavailable },
    });
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["authentication"]);
  });

  test("oversized SASL credentials stop the attempt instead of being truncated", async () => {
    const fixture = await harness({
      capabilities: "sasl",
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: false },
      secretProvider: {
        ...secrets,
        resolve: async () => ({ ok: true, value: "x".repeat(17_000) }),
      },
    });
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["authentication"]);
  });

  test("optional SASL that fails continues as an unauthenticated session", async () => {
    const fixture = await ready({
      capabilities: "sasl",
      sasl: { mechanism: "PLAIN", account: "acct", password: secret, required: false },
      onWrite: scripted((frame, send) => {
        if (frame.command === "CAP" && frame.params[0] === "LS") send(":s CAP * LS :sasl");
        if (frame.command === "CAP" && frame.params[0] === "REQ") send(":s CAP * ACK :sasl");
        if (frame.command === "AUTHENTICATE" && frame.params[0] === "PLAIN") send("AUTHENTICATE +");
        else if (frame.command === "AUTHENTICATE") send(":s 904 me :SASL authentication failed");
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }),
    });
    expect(lastState(fixture.events)).toMatchObject({ phase: "ready", authenticated: false });
    expect(errorCodes(fixture)).toContain("authentication");
  });

  test.each(["464", "465"])(
    "%s during registration is an authentication failure",
    async (numeric) => {
      const fixture = await harness({
        onWrite: scripted((frame, send) => {
          if (frame.command === "CAP" && frame.params[0] === "LS") send(":s CAP * LS :");
          if (frame.command === "NICK") send(`:s ${numeric} * :Rejected`);
        }),
      });
      await fixture.consumption;
      expect(errorCodes(fixture)).toEqual(["authentication"]);
    },
  );
});

describe("casemapping", () => {
  /** Joins `#c` as `a<first>`, then ops `a<second>`; the MODE only lands when both fold to one nick. */
  async function sameIdentity(mapping: string | undefined, first: string, second: string) {
    const fixture = await ready();
    if (mapping) await receive(fixture, `:s 005 me CASEMAPPING=${mapping} :are supported`);
    const received = await receive(fixture, `:a${first}!u@h JOIN #c`, `:s MODE #c +o a${second}`);
    return of(received, "membership").some((event) => event.change.kind === "prefixes");
  }
  test.each<[string | undefined, string, string, boolean]>([
    // The documented default before ISUPPORT is rfc1459, where []\^ pair with {}|~.
    [undefined, "[", "{", true],
    [undefined, "]", "}", true],
    [undefined, "\\", "|", true],
    [undefined, "^", "~", true],
    ["rfc1459", "[", "{", true],
    ["strict-rfc1459", "[", "{", true],
    ["strict-rfc1459", "^", "~", false],
    ["ascii", "[", "{", false],
    ["ascii", "^", "~", false],
    ["ascii", "X", "x", true],
  ])("%s: a%s vs a%s share an identity: %s", async (mapping, first, second, expected) => {
    expect(await sameIdentity(mapping, first, second)).toBe(expected);
  });

  test("our own nickname is recognized under the active casemapping", async () => {
    const fixture = await ready();
    // Registered as "me"; the server later addresses us with different bracket spelling rules.
    await receive(fixture, ":me!u@h NICK nick[1]");
    const received = await receive(fixture, ":NICK{1}!u@h NICK renamed");
    expect(lastState(fixture.events)).toMatchObject({ nick: "renamed" });
    expect(of(received, "nick")).toEqual([{ type: "nick", previous: "NICK{1}", next: "renamed" }]);
  });

  test("a casemapping change while channels are active ends the session visibly", async () => {
    const fixture = await ready();
    await receive(fixture, ":me!u@h JOIN #c");
    fixture.send(":s 005 me CASEMAPPING=ascii :are supported");
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["conflict"]);
  });

  test("restating the current casemapping with active channels is harmless", async () => {
    const fixture = await ready();
    await receive(fixture, ":me!u@h JOIN #c", ":s 005 me CASEMAPPING=rfc1459 :are supported");
    expect(errorCodes(fixture)).toEqual([]);
  });

  test("unknown casemapping names and malformed tokens are ignored", async () => {
    const fixture = await ready();
    const received = await receive(
      fixture,
      ":s 005 me CASEMAPPING=klingon CHANTYPES= PREFIX=(ov)@ CHANMODES=a,b,c STATUSMSG=#@ :are supported",
    );
    const support = of(received, "support").at(-1)?.support;
    expect(support).toMatchObject({
      casemapping: "rfc1459",
      channelTypes: "#&",
      prefixModes: "ov",
      prefixSymbols: "@+",
      channelModeGroups: ["b", "k", "l", "imnpst"],
    });
  });

  test("PREFIX and CHANMODES updates take effect for later MODE parsing", async () => {
    const fixture = await ready();
    await receive(
      fixture,
      ":s 005 me PREFIX= CHANMODES=beI,k,l,imnpstR :are supported",
      ":me!u@h JOIN #c",
      ":s 353 me = #c :@alice bob",
      ":s 366 me #c :End of /NAMES list.",
    );
    const members = of(payloads(fixture), "membership").flatMap((event) =>
      event.change.kind === "join" || event.change.kind === "prefixes"
        ? [[event.change.nick, event.change.prefixes]]
        : [],
    );
    // With no member prefix symbols, "@alice" is a nickname that cannot be parsed, so it is skipped.
    expect(members.map(([nick]) => nick)).toEqual(expect.arrayContaining(["me", "bob"]));
    expect(members.map(([nick]) => nick)).not.toContain("alice");
  });
});

describe("state bounds", () => {
  test("joining more channels than the limit stops the session explicitly", async () => {
    const fixture = await ready({ policy: { maxChannels: 2 } });
    fixture.send(":me!u@h JOIN #a");
    fixture.send(":me!u@h JOIN #b");
    fixture.send(":me!u@h JOIN #c");
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["unavailable"]);
  });

  test("more members than the limit stops the session instead of truncating", async () => {
    const fixture = await ready({ policy: { maxMembers: 3 } });
    fixture.send(":me!u@h JOIN #a");
    for (const nick of ["a", "b", "c"]) fixture.send(`:${nick}!u@h JOIN #a`);
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["unavailable"]);
  });

  test("an oversized NAMES reply is a visible failure", async () => {
    const fixture = await ready({ policy: { maxMembers: 3 } });
    fixture.send(":me!u@h JOIN #a");
    fixture.send(":s 353 me = #a :a b c d");
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["unavailable"]);
  });

  test("too many distinct nicknames changing during one NAMES reconciliation is a visible failure", async () => {
    const fixture = await ready({ policy: { maxMembers: 1 } });
    fixture.send(":me!u@h JOIN #a");
    for (const nick of ["a", "b", "c"]) fixture.send(`:${nick}!u@h QUIT :bye`);
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["unavailable"]);
  });

  test("NAMES for a channel we never joined does not require membership of it", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":s 366 me #unknown :End of /NAMES list.");
    expect(of(received, "membership")).toEqual([]);
  });
});

describe("keepalive and stream failures", () => {
  test("an idle connection is pinged and a matching PONG keeps it alive", async () => {
    const pings: string[] = [];
    const fixture = await ready({
      policy: { keepaliveMs: 20, staleTimeoutMs: 300 },
      onWrite(frame, send) {
        if (frame.command === "PING") {
          pings.push(frame.params[0]!);
          send(`:s PONG s :${frame.params[0]}`);
        }
      },
    });
    await until(() => pings.length >= 3);
    expect(lastState(fixture.events)).toMatchObject({ phase: "ready" });
    expect(errorCodes(fixture)).toEqual([]);
  });

  test("a PONG for someone else's ping does not satisfy the keepalive", async () => {
    const fixture = await ready({
      policy: { keepaliveMs: 20, staleTimeoutMs: 200 },
      onWrite(frame, send) {
        if (frame.command === "PING") send(":s PONG s :not-ours");
      },
    });
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["network"]);
  });

  test("the server closing the stream is reported as a network error", async () => {
    const fixture = await ready();
    await fixture.end();
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual(["network"]);
    expect(lastState(fixture.events)).toMatchObject({ phase: "disconnected" });
  });

  test("an over-long server line is a protocol failure, not silently truncated", async () => {
    const fixture = await ready();
    fixture.send(`:s NOTICE me :${"x".repeat(20_000)}`);
    await fixture.consumption;
    expect(errorCodes(fixture)).toHaveLength(1);
    expect(lastState(fixture.events)).toMatchObject({ phase: "disconnected" });
  });

  test.each([
    ["ERROR :Closing Link", "network"],
    [":s 464 me :Password incorrect", "authentication"],
    [":s 465 me :You are banned", "authentication"],
    [":bad,nick!u@h PRIVMSG #c :hi", "network"],
  ])("%s ends the session with a %s error", async (line, code) => {
    const fixture = await ready();
    fixture.send(line);
    await fixture.consumption;
    expect(errorCodes(fixture)).toEqual([code]);
  });
});

describe("informational numerics and small events", () => {
  test.each<[string, object[]]>([
    [":s 306 me :You have been marked as being away", [{ type: "away", nick: "me", away: true }]],
    [
      ":s 305 me :You are no longer marked as being away",
      [{ type: "away", nick: "me", away: false }],
    ],
    [":alice!u@h AWAY :gone", [{ type: "away", nick: "alice", away: true }]],
    [":alice!u@h AWAY", [{ type: "away", nick: "alice", away: false }]],
    [":alice!u@h INVITE me #room", [{ type: "notice", text: "alice invited you to #room." }]],
    [":alice!u@h ACCOUNT acct", [{ type: "account", nick: "alice", account: "acct" }]],
    [":alice!u@h ACCOUNT *", [{ type: "account", nick: "alice", account: null }]],
    [
      ":s 422 me :MOTD File is missing",
      [{ type: "notice", text: "The server has no message of the day." }],
    ],
    [":s 999 me :mystery", [{ type: "notice", text: "IRC server response 999." }]],
    [":s 004 me irc.example 1.0 o o", []],
    [":s 331 me #room :No topic is set", [{ type: "topic", channel: "#room", text: "" }]],
    [":alice!u@h TOPIC #room :fresh", [{ type: "topic", channel: "#room", text: "fresh" }]],
    [":s 332 me #room :hello", [{ type: "topic", channel: "#room", text: "hello" }]],
  ])("%s", async (line, expected) => {
    const fixture = await ready();
    expect(await receive(fixture, line)).toEqual(expected);
  });

  test("403 and friends become readable rejections; unknown 4xx/5xx stay generic", async () => {
    const fixture = await ready();
    const received = await receive(fixture, ":s 403 me #x :No such channel", ":s 599 me :odd");
    expect(of(received, "error").map((event) => event.error.message)).toEqual([
      "The channel does not exist.",
      "IRC server rejected a request (599).",
    ]);
  });
});
