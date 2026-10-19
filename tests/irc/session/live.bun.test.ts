import { expect, test } from "bun:test";
import type { Clock } from "../../../src/contracts/common";
import { entityId } from "../../../src/contracts/common";
import type { SessionEvent } from "../../../src/contracts/session";
import type { SecretProvider } from "../../../src/contracts/settings";
import { createIrcCodec } from "../../../src/irc/codec";
import { createSessionFactory, defaultProtocolLimits } from "../../../src/irc/session";
import { createBunTransport } from "../../../src/transport/bun";

const clock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  },
};
const secrets: SecretProvider = {
  async resolve() {
    return {
      ok: false,
      error: { code: "unavailable", message: "No test secrets", retryable: false },
    };
  },
  async store() {
    return {
      ok: false,
      error: { code: "unsupported", message: "No test secrets", retryable: false },
    };
  },
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Local IRC fixture timed out");
    await Bun.sleep(2);
  }
}

test("real Bun TCP -> codec -> session: register, join, names race, labeled batch echo, LIST, WHOIS, abort", async () => {
  const accepted: string[] = [];
  let echoSequence = 0;
  const codecs = new WeakMap<Bun.Socket, ReturnType<typeof createIrcCodec>>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        codecs.set(socket, createIrcCodec(defaultProtocolLimits));
      },
      data(socket, bytes) {
        const parsed = codecs.get(socket)!.push(bytes);
        if (!parsed.ok) {
          socket.terminate();
          return;
        }
        const send = (line: string) => socket.write(line + "\r\n");
        for (const frame of parsed.value) {
          accepted.push(frame.command);
          const p = frame.params;
          if (frame.command === "CAP" && p[0] === "LS") {
            // Exercise CAP continuation across independently delivered frames.
            send(":fixture CAP me LS * :message-tags server-time multi-prefix");
            send(
              ":fixture CAP me LS :batch labeled-response echo-message draft/chathistory draft/read-marker draft/message-redaction",
            );
          }
          if (frame.command === "CAP" && p[0] === "REQ") send(`:fixture CAP me ACK :${p[1]}`);
          if (frame.command === "CAP" && p[0] === "END") {
            send("PING :initial");
            send(":fixture 001 me :Welcome");
            send(
              ":fixture 005 me CASEMAPPING=ascii PREFIX=(ov)@+ CHANTYPES=#& CHATHISTORY=20 MSGREFTYPES=timestamp,msgid :supported",
            );
          }
          if (frame.command === "JOIN") {
            send(":me!u@localhost JOIN #room");
            send(":fixture 353 me = #room :@alice me");
            send(":alice!u@localhost PART #room :left");
            send(":bob!u@localhost JOIN #room");
            send(":fixture 366 me #room :done");
            send(
              "@time=2026-01-01T00:00:00.000Z;msgid=remote-1 :bob!u@localhost PRIVMSG #room :hello from the local server",
            );
          }
          if (frame.command === "PRIVMSG") {
            send(`@label=${frame.tags.label} :fixture BATCH +reply labeled-response`);
            send(
              `@batch=reply;msgid=echo-${++echoSequence}${frame.tags["+reply"] ? `;+reply=${frame.tags["+reply"]}` : ""} :me!u@localhost PRIVMSG ${p[0]} :${p[1]}`,
            );
            send(":fixture BATCH -reply");
          }
          if (frame.command === "CHATHISTORY") {
            send(
              `@label=${frame.tags.label};draft/chathistory-end :fixture BATCH +past chathistory ${p[1]}`,
            );
            send(
              `@batch=past;msgid=past-1;time=2025-12-31T00:00:00.000Z :bob!u@localhost PRIVMSG ${p[1]} :earlier history`,
            );
            send(":fixture BATCH -past");
          }
          if (frame.command === "TAGMSG") {
            const tags = Object.entries(frame.tags)
              .map(([key, value]) => (value === null ? key : `${key}=${value}`))
              .join(";");
            send(`@${tags} :me!u@localhost TAGMSG ${p[0]}`);
            send(`@label=${frame.tags.label} :fixture ACK`);
          }
          if (frame.command === "MARKREAD")
            send(`@label=${frame.tags.label} :fixture MARKREAD ${p[0]} ${p[1]}`);
          if (frame.command === "REDACT")
            send(`@label=${frame.tags.label} :me!u@localhost REDACT ${p[0]} ${p[1]}`);
          if (frame.command === "WHOIS") {
            send(":fixture 311 me bob user localhost * :Bob User");
            send(":fixture 319 me bob :#room");
            send(":fixture 318 me bob :done");
          }
          if (frame.command === "LIST") {
            send(":fixture 322 me #room 2 :Local room");
            send(":fixture 323 me :done");
          }
        }
      },
    },
  });
  const controller = new AbortController();
  const networkId = entityId<"network">("local-network");
  const factory = createSessionFactory({
    transport: createBunTransport(),
    secrets,
    clock,
    policy: { floodIntervalMs: 0 },
  });
  const opened = await factory.open(
    {
      id: networkId,
      name: "Local IRC",
      endpoints: [{ host: "127.0.0.1", port: listener.port, tls: false }],
      identity: { nick: "me", alternateNicks: [], username: "user", realname: "Local fixture" },
      autoConnect: false,
      autoJoin: [],
    },
    { networkId, generation: 42 },
    controller.signal,
  );
  if (!opened.ok) {
    listener.stop(true);
    throw new Error("Local session failed to open");
  }
  const session = opened.value;
  const events: SessionEvent[] = [];
  const consume = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  try {
    await until(() =>
      events.some((event) => event.payload.type === "state" && event.payload.phase === "ready"),
    );
    expect(
      (
        await session.execute(
          { type: "join", channel: "#room" },
          entityId<"operation">("join"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    await until(() => events.some((event) => event.payload.type === "chat"));
    expect(
      (
        await session.execute(
          { type: "send", target: "#room", text: "hello back 🐈", kind: "text" },
          entityId<"operation">("send"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.execute(
          { type: "whois", nick: "bob" },
          entityId<"operation">("whois"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await session.execute({ type: "list" }, entityId<"operation">("list"), controller.signal))
        .ok,
    ).toBe(true);
    await until(
      () =>
        events.some((event) => event.payload.type === "directory-complete") &&
        events.some((event) => event.payload.type === "user-details") &&
        events.some(
          (event) => event.payload.type === "send-state" && event.payload.state === "echo-observed",
        ),
    );
    expect(
      events.find((event) => event.payload.type === "chat" && event.payload.message.operationId)
        ?.payload,
    ).toMatchObject({
      type: "chat",
      message: { operationId: "send", text: "hello back 🐈", serverId: "echo-1" },
    });
    expect(
      events.some(
        (event) =>
          event.payload.type === "membership" &&
          event.payload.change.kind === "join" &&
          event.payload.change.nick === "alice",
      ),
    ).toBe(false);
    expect(accepted).toContain("PONG");
    expect(
      (
        await session.execute(
          { type: "history", target: "#room", limit: 2 },
          entityId<"operation">("history"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    await until(() => events.some((event) => event.payload.type === "history-complete"));
    expect(
      events.find(
        (event) => event.payload.type === "chat" && event.payload.message.serverId === "past-1",
      )?.payload,
    ).toMatchObject({ message: { source: "playback", text: "earlier history" } });
    expect(
      (
        await session.execute(
          {
            type: "send",
            target: "#room",
            text: "a real tagged reply",
            kind: "text",
            replyToServerId: "remote-1",
          },
          entityId<"operation">("reply"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.execute(
          { type: "typing", target: "#room", active: true },
          entityId<"operation">("typing"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.execute(
          { type: "reaction", target: "#room", serverId: "remote-1", value: "🐈", remove: false },
          entityId<"operation">("reaction"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.execute(
          {
            type: "mark-read",
            target: "#room",
            serverTime: Date.parse("2026-01-01T00:00:00.000Z"),
          },
          entityId<"operation">("read"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.execute(
          { type: "redact", target: "#room", serverId: "echo-1" },
          entityId<"operation">("redact"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    await until(
      () =>
        events.some((event) => event.payload.type === "reaction") &&
        events.some((event) => event.payload.type === "read-marker") &&
        events.some((event) => event.payload.type === "redaction"),
    );
    expect(
      events.find(
        (event) => event.payload.type === "chat" && event.payload.message.operationId === "reply",
      )?.payload,
    ).toMatchObject({ message: { replyToServerId: "remote-1", text: "a real tagged reply" } });
    expect(accepted).toContain("TAGMSG");
    const multiline = "first 🐈\n\n/quit literal paste\nlast\n";
    expect(
      (
        await session.execute(
          { type: "send", target: "#room", text: multiline, kind: "text" },
          entityId<"operation">("multiline"),
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    await until(() =>
      events.some(
        (event) =>
          event.payload.type === "chat" && event.payload.message.operationId === "multiline",
      ),
    );
    expect(
      events.find(
        (event) =>
          event.payload.type === "chat" && event.payload.message.operationId === "multiline",
      )?.payload,
    ).toMatchObject({ message: { text: multiline, kind: "text" } });
    expect(accepted).not.toContain("QUIT");
    controller.abort();
    await consume;
    expect(events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.generation === 42)).toBe(true);
  } finally {
    await session.close();
    await consume;
    listener.stop(true);
  }
});
