// Server-to-client behavior cases, using WeeChat's IRC protocol suite as a checklist of
// situations to cover (docs/IRC_TEST_MATRIX.md). Cases and assertions are our own.
import { afterEach, describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionEvent } from "../../../src/contracts/session";
import type { SecretProvider } from "../../../src/contracts/settings";
import {
  closeSessions,
  harness,
  hasReady,
  of,
  op,
  ready,
  receive,
  secrets,
  until,
} from "./harness";

afterEach(closeSessions);

const stopped = (events: SessionEvent[]) =>
  events.some((event) => event.payload.type === "state" && event.payload.phase === "disconnected");

describe("registration edge cases", () => {
  /** A server that answers CAP and registers only once `accept` approves a nickname. */
  function registrar(reply: (nick: string) => string | undefined) {
    return (frame: IrcFrame, send: (line: string) => void) => {
      if (frame.command === "CAP" && frame.params[0] === "LS") send(":s CAP * LS :");
      if (frame.command === "NICK") {
        const nick = frame.params[0]!;
        send(reply(nick) ?? `:s 001 ${nick} :welcome`);
      }
      return { ok: true as const, value: undefined };
    };
  }
  test.each([
    ["432", "Erroneous nickname"],
    ["433", "Nickname is already in use"],
    ["437", "Nick/channel is temporarily unavailable"],
  ])("%s before registration moves on to the alternate nickname", async (code, text) => {
    const fixture = await ready({
      onWrite: registrar((nick) => (nick === "me" ? `:s ${code} * me :${text}` : undefined)),
    });
    expect(
      fixture.written.filter((frame) => frame.command === "NICK").map((f) => f.params[0]),
    ).toEqual(["me", "me_"]);
    expect(
      fixture.events.findLast((event) => event.payload.type === "state")?.payload,
    ).toMatchObject({
      phase: "ready",
      nick: "me_",
    });
  });
  test("running out of nicknames stops with an explicit conflict instead of hanging", async () => {
    const fixture = await harness({
      onWrite: registrar((nick) => `:s 433 * ${nick} :Nickname is already in use`),
    });
    await fixture.consumption;
    expect(hasReady(fixture.events)).toBe(false);
    expect(fixture.events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
    expect(JSON.stringify(fixture.events)).toContain('"code":"conflict"');
  });
  test("433 after registration keeps the current nickname and reports the conflict", async () => {
    const fixture = await ready();
    const payloads = await receive(fixture, ":s 433 me taken :Nickname is already in use");
    expect(fixture.written.filter((frame) => frame.command === "NICK")).toHaveLength(1);
    expect(of(payloads, "error")[0]?.error.code).toBe("conflict");
  });
  test("the server may register us under a different nickname than requested", async () => {
    const fixture = await ready({
      onWrite(frame, send) {
        if (frame.command === "CAP" && frame.params[0] === "LS") send(":s CAP * LS :");
        if (frame.command === "CAP" && frame.params[0] === "END")
          send(":s 001 me-renamed :welcome");
        return { ok: true, value: undefined };
      },
    });
    expect(
      fixture.events.findLast((event) => event.payload.type === "state")?.payload,
    ).toMatchObject({
      nick: "me-renamed",
    });
  });
  test("prefixless and server-sourced notices are status text, not conversations", async () => {
    const fixture = await harness({
      onWrite(frame, send) {
        if (frame.command === "USER") {
          send("NOTICE * :*** Looking up your hostname...");
          send(":irc.example.net NOTICE * :*** Found your hostname");
        }
      },
    });
    await until(() => hasReady(fixture.events));
    const payloads = fixture.events.map((event) => event.payload);
    expect(of(payloads, "chat")).toEqual([]);
    expect(of(payloads, "notice").map((notice) => notice.text)).toEqual(
      expect.arrayContaining(["*** Looking up your hostname...", "*** Found your hostname"]),
    );
  });
});

describe("ISUPPORT", () => {
  test("values accumulate across several 005 lines and drive NAMES parsing", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":s 005 me CHANTYPES=#& :are supported by this server",
      ":s 005 me PREFIX=(qaohv)~&@%+ CASEMAPPING=ascii :are supported by this server",
      ":me!u@h JOIN &local",
      ":s 353 me = &local :~owner &admin @op %half +voice plain",
      ":s 366 me &local :End of /NAMES list.",
    );
    const joined = of(payloads, "membership").map((event) => event.change);
    expect(joined).toEqual(
      expect.arrayContaining([
        { kind: "join", nick: "owner", prefixes: ["~"] },
        { kind: "join", nick: "admin", prefixes: ["&"] },
        { kind: "join", nick: "half", prefixes: ["%"] },
        { kind: "join", nick: "plain", prefixes: [] },
      ]),
    );
    expect(of(payloads, "support").at(-1)?.support).toMatchObject({
      channelTypes: "#&",
      prefixModes: "qaohv",
      casemapping: "ascii",
    });
  });
  test("an empty PREFIX means the network has no member prefixes", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":s 005 me PREFIX= :are supported by this server",
      ":me!u@h JOIN #a",
      ":s 353 me = #a :@literal",
      ":s 366 me #a :End of /NAMES list.",
    );
    expect(of(payloads, "support").at(-1)?.support).toMatchObject({
      prefixModes: "",
      prefixSymbols: "",
    });
    expect(of(payloads, "membership").map((event) => event.change)).toContainEqual({
      kind: "join",
      nick: "@literal",
      prefixes: [],
    });
  });
  test("NAMES for a channel we are not in creates no membership", async () => {
    const fixture = await ready({ policy: { maxChannels: 1 } });
    const elsewhere = await receive(
      fixture,
      ":s 353 me = #elsewhere :alice bob",
      ":s 366 me #elsewhere :End of /NAMES list.",
    );
    expect(of(elsewhere, "membership")).toEqual([]);
    // It did not use up the only channel slot either.
    const joined = await receive(fixture, ":me!u@h JOIN #mine");
    expect(of(joined, "membership")).toHaveLength(1);
    expect(stopped(fixture.events)).toBe(false);
  });
  test("multi-prefix NAMES keeps every prefix in rank order", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":me!u@h JOIN #a",
      ":s 353 me = #a :@+both +voice",
      ":s 366 me #a :End of /NAMES list.",
    );
    expect(of(payloads, "membership").map((event) => event.change)).toContainEqual({
      kind: "join",
      nick: "both",
      prefixes: ["@", "+"],
    });
  });
});

describe("channel membership", () => {
  async function joined(...members: string[]) {
    const fixture = await ready();
    await receive(
      fixture,
      ":me!u@h JOIN #a",
      `:s 353 me = #a :me ${members.join(" ")}`,
      ":s 366 me #a :End of /NAMES list.",
    );
    return fixture;
  }
  test("KICK removes the target with the kicker's reason", async () => {
    const fixture = await joined("alice", "@bob");
    const payloads = await receive(fixture, ":bob!u@h KICK #a alice :behave");
    expect(of(payloads, "membership")).toEqual([
      {
        type: "membership",
        channel: "#a",
        change: { kind: "remove", nick: "alice", reason: "behave" },
      },
    ]);
  });
  test("being kicked forgets the channel until we rejoin", async () => {
    const fixture = await joined("@bob");
    await receive(fixture, ":bob!u@h KICK #a me :out");
    // Membership updates for a channel we are no longer in are ignored.
    expect(of(await receive(fixture, ":bob!u@h MODE #a +o bob"), "membership")).toEqual([]);
    const rejoined = await receive(fixture, ":me!u@h JOIN #a", ":bob!u@h MODE #a +v me");
    expect(of(rejoined, "membership").map((event) => event.change)).toEqual([
      { kind: "join", nick: "me", prefixes: [] },
      { kind: "prefixes", nick: "me", prefixes: ["+"] },
    ]);
  });
  test("PART and QUIT carry their reasons; QUIT is network-wide", async () => {
    const fixture = await joined("alice", "bob");
    const payloads = await receive(
      fixture,
      ":alice!u@h PART #a :later",
      ":bob!u@h QUIT :Quit: bye",
    );
    expect(of(payloads, "membership")[0]?.change).toEqual({
      kind: "remove",
      nick: "alice",
      reason: "later",
    });
    expect(of(payloads, "quit")).toEqual([{ type: "quit", nick: "bob", reason: "Quit: bye" }]);
  });
  test("our own NICK change updates the session nickname and self detection", async () => {
    const fixture = await joined("alice");
    const payloads = await receive(fixture, ":me!u@h NICK :renamed");
    expect(of(payloads, "nick")).toEqual([{ type: "nick", previous: "me", next: "renamed" }]);
    expect(of(payloads, "state").at(-1)).toMatchObject({ nick: "renamed" });
    await receive(fixture, ":renamed!u@h PART #a");
    expect(of(await receive(fixture, ":alice!u@h MODE #a +o alice"), "membership")).toEqual([]);
  });
  test("MODE skips arguments of list, key and limit modes before prefix modes", async () => {
    const fixture = await joined("alice", "bob", "carol");
    const payloads = await receive(
      fixture,
      ":s 005 me CHANMODES=beI,k,l,imnpst :are supported by this server",
      ":op!u@h MODE #a +bo *!*@spam alice",
      ":op!u@h MODE #a +klv secret 10 bob",
      ":op!u@h MODE #a -lk+o secret carol",
      ":op!u@h MODE #a +mnt-v bob",
    );
    expect(of(payloads, "membership").map((event) => event.change)).toEqual([
      { kind: "prefixes", nick: "alice", prefixes: ["@"] },
      { kind: "prefixes", nick: "bob", prefixes: ["+"] },
      { kind: "prefixes", nick: "carol", prefixes: ["@"] },
      { kind: "prefixes", nick: "bob", prefixes: [] },
    ]);
  });
  test("user modes and modes for unknown channels change nothing", async () => {
    const fixture = await joined("alice");
    const payloads = await receive(fixture, ":me MODE me :+iw", ":s MODE #elsewhere +o alice");
    expect(of(payloads, "membership")).toEqual([]);
    expect(stopped(fixture.events)).toBe(false);
  });
  test("topics: set, cleared, reply on join and no-topic reply", async () => {
    const fixture = await joined();
    const payloads = await receive(
      fixture,
      ":alice!u@h TOPIC #a :new topic",
      ":alice!u@h TOPIC #a :",
      ":s 332 me #a :joined topic",
      ":s 331 me #a :No topic is set",
    );
    expect(of(payloads, "topic").map((topic) => topic.text)).toEqual([
      "new topic",
      "",
      "joined topic",
      "",
    ]);
  });
});

describe("messages", () => {
  test.each([
    [":bob!u@h PRIVMSG #a :\x01ACTION waves\x01", "action", "waves"],
    [":bob!u@h PRIVMSG #a :\x01ACTION waves", "action", "waves"],
    [":bob!u@h PRIVMSG #a :\x01ACTION\x01", "action", ""],
    [":bob!u@h PRIVMSG #a :tail\x01", "text", "tail"],
    [
      ":bob!u@h PRIVMSG #a :\x02bold\x02 \x0304,12red\x03 \x1ditalic\x1d \x0freset",
      "text",
      "bold red italic reset",
    ],
    [":bob!u@h PRIVMSG #a :\x0304,not a background", "text", ",not a background"],
    [":bob!u@h NOTICE #a :\x01ACTION notes\x01", "action", "notes"],
  ])("%j is shown as %s %j", async (line, kind, text) => {
    const fixture = await ready();
    const chat = of(await receive(fixture, line), "chat");
    expect(chat.map((event) => [event.message.kind, event.message.text])).toEqual([[kind, text]]);
  });
  test("CTCP requests are never answered but are visible", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":bob!u@h PRIVMSG me :\x01VERSION\x01",
      ":bob!u@h PRIVMSG me :\x01PING 12345\x01",
      ":bob!u@h PRIVMSG me :\x01DCC SEND file.txt 1 2 3\x01",
    );
    expect(of(payloads, "chat")).toEqual([]);
    expect(of(payloads, "notice").map((notice) => notice.text)).toEqual([
      "bob sent a CTCP VERSION request; opentui-irc does not answer CTCP requests.",
      "bob sent a CTCP PING request; opentui-irc does not answer CTCP requests.",
      "bob sent a CTCP DCC request; opentui-irc does not answer CTCP requests.",
    ]);
    expect(fixture.written.filter((frame) => frame.command === "NOTICE")).toEqual([]);
  });
  test("STATUSMSG lines (@#channel) are delivered to the channel", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":s 005 me STATUSMSG=@+ :are supported by this server",
      ":bob!u@h PRIVMSG @#a :ops only",
      ":bob!u@h NOTICE +#a :voiced only",
    );
    expect(of(payloads, "chat").map((event) => [event.message.target, event.message.text])).toEqual(
      [
        ["#a", "ops only"],
        ["#a", "voiced only"],
      ],
    );
  });
  test("malformed or empty chat lines are ignored without disconnecting", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":bob!u@h NOTICE",
      ":bob!u@h NOTICE me",
      ":bob!u@h PRIVMSG",
      ":bob!u@h PRIVMSG #a",
    );
    expect(of(payloads, "chat")).toEqual([]);
    expect(stopped(fixture.events)).toBe(false);
  });
  test("a message with an invalid sender or target is skipped, not fatal", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":a,b!u@h PRIVMSG #a :comma in the nickname",
      ":bob!u@h PRIVMSG #a,#b :comma in the target",
      ":bob!u@h PRIVMSG #a :still here",
    );
    expect(of(payloads, "notice").map((notice) => notice.text)).toEqual([
      "Ignored a message with an invalid sender or target.",
      "Ignored a message with an invalid sender or target.",
    ]);
    expect(of(payloads, "chat").map((event) => event.message.text)).toEqual(["still here"]);
    expect(stopped(fixture.events)).toBe(false);
  });
  test("services notices stay conversations; nick-only prefixes are people", async () => {
    const fixture = await ready();
    const chat = of(
      await receive(
        fixture,
        ":NickServ!NickServ@services.example NOTICE me :This nickname is registered.",
        ":bob NOTICE me :short prefix",
      ),
      "chat",
    );
    expect(chat.map((event) => event.message.sender.nick)).toEqual(["NickServ", "bob"]);
  });
  test("our own messages from another client are ordinary chat, not lost", async () => {
    const fixture = await ready();
    const chat = of(await receive(fixture, ":me!u@h PRIVMSG #a :from my phone"), "chat");
    expect(chat[0]?.message).toMatchObject({ sender: { nick: "me" }, text: "from my phone" });
  });
});

describe("server replies and errors", () => {
  test.each([
    ["403", "#nope", "The channel does not exist."],
    ["404", "#a", "You cannot send to this channel."],
    ["405", "#a", "You have joined too many channels."],
    ["442", "#a", "You are not joined to this channel."],
    ["471", "#a", "The channel is full."],
    ["473", "#a", "The channel requires an invitation."],
    ["474", "#a", "You are banned from this channel."],
    ["475", "#a", "A valid channel key is required."],
    ["477", "#a", "The channel requires an authenticated account."],
    ["482", "#a", "You do not have permission to change this channel."],
    ["401", "ghost", "No such nickname or channel."],
    ["406", "ghost", "There was no such nickname."],
    ["411", "", "No recipient was given."],
    ["412", "", "No text to send."],
  ])("%s is a readable error", async (code, target, message) => {
    const fixture = await ready();
    const errors = of(await receive(fixture, `:s ${code} me ${target} :server text`), "error");
    expect(errors.map((event) => event.error.message)).toEqual([message]);
  });
  test("401 for a pending WHOIS fails that lookup only", async () => {
    const fixture = await ready();
    const operationId = op("whois-ghost");
    expect(
      (
        await fixture.session.execute(
          { type: "whois", nick: "ghost" },
          operationId,
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    const errors = of(
      await receive(fixture, ":s 401 me ghost :No such nick", ":s 318 me ghost :End of WHOIS"),
      "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ operationId, error: { message: "IRC user was not found." } });
  });
  test("informational numerics do not flood the status view with codes", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":s 004 me irc.example.net ergo-2.19 BERTZios CEIMRUabefhiklmnoqstuv Iabefhkloqv",
      ":s 042 me 1ABCDEF :your unique ID",
      ":s 324 me #a +nt",
      ":s 329 me #a 1700000000",
      ":s 333 me #a alice!u@h 1700000000",
      ":s 328 me #a :https://example.net",
    );
    expect(of(payloads, "notice")).toEqual([]);
    expect(of(payloads, "error")).toEqual([]);
  });
  test("login and host-change numerics read as prose", async () => {
    const fixture = await ready();
    const notices = of(
      await receive(
        fixture,
        ":s 900 me me!u@h acct :You are now logged in as acct",
        ":s 396 me cloaked.example :is now your displayed host",
      ),
      "notice",
    );
    expect(notices.map((notice) => notice.text)).toEqual([
      "You are now logged in as acct",
      "cloaked.example is now your displayed host",
    ]);
  });
  test("INVITE, WARN and NOTE are visible notices", async () => {
    const fixture = await ready();
    const notices = of(
      await receive(
        fixture,
        ":bob!u@h INVITE me #secret",
        ":s WARN REHASH CERTS_EXPIRED :Certificate [xyz] has expired",
        ":s NOTE * OPER_MESSAGE :Server restarting soon",
      ),
      "notice",
    );
    expect(notices.map((notice) => notice.text)).toEqual([
      "bob invited you to #secret.",
      "Certificate [xyz] has expired",
      "Server restarting soon",
    ]);
  });
  test("CHGHOST, SETNAME, WALLOPS and unknown commands are harmless", async () => {
    const fixture = await ready();
    const payloads = await receive(
      fixture,
      ":bob!u@h CHGHOST newuser new.host",
      ":bob!u@h SETNAME :New Name",
      ":s WALLOPS :network news",
      ":s FROBNICATE a b c",
    );
    expect(of(payloads, "error")).toEqual([]);
    expect(stopped(fixture.events)).toBe(false);
  });
  test("ERROR ends the attempt without echoing server text", async () => {
    const fixture = await ready();
    fixture.send("ERROR :Closing Link: me (Killed (oper (secret reason)))");
    await fixture.consumption;
    expect(fixture.events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
    expect(JSON.stringify(fixture.events)).not.toContain("secret reason");
  });
});

describe("SASL PLAIN", () => {
  const sasl = (required: boolean) => ({
    mechanism: "PLAIN" as const,
    account: "acct",
    password: entityId<"secret-ref">("env:FIXTURE"),
    required,
  });
  const password = (value: string): SecretProvider => ({
    ...secrets,
    async resolve() {
      return { ok: true, value };
    },
  });
  // "acct\0acct\0" is 10 bytes, so 290 password bytes encode to exactly 400 base64 characters.
  test.each([
    [290, [400, 1]],
    [291, [400, 4]],
    [10, [28]],
  ])("a %i-byte password is sent in 400-byte chunks %j", async (length, chunks) => {
    const fixture = await ready({
      capabilities: "sasl=PLAIN",
      sasl: sasl(true),
      secretProvider: password("p".repeat(length)),
    });
    const sent = fixture.written
      .filter((frame) => frame.command === "AUTHENTICATE" && frame.params[0] !== "PLAIN")
      .map((frame) => frame.params[0]!);
    expect(sent.map((chunk) => chunk.length)).toEqual(chunks);
    if (length === 290) expect(sent.at(-1)).toBe("+");
    expect(atob(sent.filter((chunk) => chunk !== "+").join(""))).toBe(
      `acct\0acct\0${"p".repeat(length)}`,
    );
  });
  test("an optional SASL failure is reported and registration continues", async () => {
    const fixture = await ready({
      capabilities: "sasl=PLAIN",
      sasl: sasl(false),
      onWrite(frame, send) {
        if (frame.command === "AUTHENTICATE" && frame.params[0] !== "PLAIN") {
          send(":s 904 me :SASL authentication failed");
          return { ok: true, value: undefined };
        }
      },
    });
    expect(fixture.events.some((event) => event.payload.type === "error")).toBe(true);
    expect(
      fixture.events.findLast((event) => event.payload.type === "state")?.payload,
    ).toMatchObject({
      phase: "ready",
      authenticated: false,
    });
  });
  test("a server that only offers other mechanisms is not sent credentials", async () => {
    const fixture = await ready({ capabilities: "sasl=EXTERNAL,SCRAM-SHA-256", sasl: sasl(false) });
    expect(fixture.written.some((frame) => frame.command === "AUTHENTICATE")).toBe(false);
  });
});

describe("capabilities added after registration (cap-notify)", () => {
  const requests = (fixture: Awaited<ReturnType<typeof ready>>) =>
    fixture.written
      .filter((frame) => frame.command === "CAP" && frame.params[0] === "REQ")
      .map((frame) => frame.params[1]!.split(" ").sort());
  test("a newly offered feature is requested and enabled without reconnecting", async () => {
    const fixture = await ready({ capabilities: "message-tags server-time cap-notify" });
    const before = requests(fixture).length;
    const payloads = await receive(fixture, ":s CAP me NEW :batch draft/chathistory");
    expect(requests(fixture).slice(before)).toEqual([["batch", "draft/chathistory"]]);
    expect(of(payloads, "support").at(-1)?.features).toMatchObject({ history: true });
  });
  test("a newly offered dependency unlocks reliable echo as a set", async () => {
    const fixture = await ready({ capabilities: "message-tags batch echo-message cap-notify" });
    expect(requests(fixture).flat()).not.toContain("echo-message");
    const before = requests(fixture).length;
    await receive(fixture, ":s CAP me NEW :labeled-response");
    // batch was offered but unused until the whole set became available.
    expect(requests(fixture).slice(before)).toEqual([
      ["batch", "echo-message", "labeled-response"],
    ]);
  });
  test("unwanted capabilities and SASL after registration are not requested", async () => {
    const fixture = await ready({ capabilities: "cap-notify" });
    const before = requests(fixture).length;
    const payloads = await receive(fixture, ":s CAP me NEW :sasl=PLAIN vendor/frobnicate");
    expect(requests(fixture).slice(before)).toEqual([]);
    expect(of(payloads, "support")).toEqual([]);
  });
  test("a refused late request changes nothing; a later DEL disables the feature", async () => {
    const fixture = await ready({
      capabilities: "message-tags server-time cap-notify",
      onWrite(frame, send) {
        if (
          frame.command === "CAP" &&
          frame.params[0] === "REQ" &&
          frame.params[1]?.includes("draft/chathistory")
        ) {
          send(`:s CAP me NAK :${frame.params[1]}`);
          return { ok: true, value: undefined };
        }
      },
    });
    const refused = await receive(fixture, ":s CAP me NEW :batch draft/chathistory");
    expect(of(refused, "support").at(-1)?.features ?? { history: false }).toMatchObject({
      history: false,
    });
    const removed = await receive(fixture, ":s CAP me DEL :server-time");
    expect(of(removed, "support").at(-1)?.support.capabilities).not.toHaveProperty("server-time");
  });
});
