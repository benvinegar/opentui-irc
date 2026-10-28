import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import type { AppApi } from "../../src/contracts/app";
import type { Result } from "../../src/contracts/common";
import { entityId } from "../../src/contracts/common";
import { createApp } from "../../src/app/create-app";
import { randomIds, systemClock } from "../../src/app/platform-independent-runtime";
import { createSessionFactory } from "../../src/irc/session";
import { createBunTransport } from "../../src/transport/bun";
import { createHistoryRepository } from "../../src/storage/history";
import { createSettingsRepository } from "../../src/storage/settings";

const signal = () => new AbortController().signal;
const take = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for client state");
    await Bun.sleep(5);
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function localServer() {
  const connections: Socket<{ input: string; nick: string }>[] = [];
  const lines: string[] = [];
  let message = 0;
  const server = Bun.listen<{ input: string; nick: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { input: "", nick: "newcomer" };
        connections.push(socket);
      },
      data(socket, chunk) {
        socket.data.input += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = socket.data.input.indexOf("\r\n")) !== -1) {
          let line = socket.data.input.slice(0, end);
          socket.data.input = socket.data.input.slice(end + 2);
          lines.push(line);
          let tags = "";
          if (line.startsWith("@")) {
            const offset = line.indexOf(" ");
            tags = line.slice(1, offset);
            line = line.slice(offset + 1);
          }
          const [command, ...arguments_] = line.split(" ");
          if (command === "NICK") socket.data.nick = arguments_[0]!;
          else if (command === "CAP" && arguments_[0] === "LS")
            socket.write(
              ":local CAP * LS :message-tags server-time batch echo-message labeled-response multi-prefix\r\n",
            );
          else if (command === "CAP" && arguments_[0] === "REQ")
            socket.write(`:local CAP * ACK ${arguments_.slice(1).join(" ")}\r\n`);
          else if (command === "CAP" && arguments_[0] === "END")
            socket.write(
              `:local 001 ${socket.data.nick} :Welcome\r\n:local 005 ${socket.data.nick} CASEMAPPING=rfc1459 CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnt :supported\r\n`,
            );
          else if (command === "JOIN") {
            const channel = arguments_[0]!;
            socket.write(
              `:${socket.data.nick}!u@localhost JOIN :${channel}\r\n:local 353 ${socket.data.nick} = ${channel} :@guide ${socket.data.nick}\r\n:local 366 ${socket.data.nick} ${channel} :end\r\n`,
            );
          } else if (command === "PRIVMSG" || command === "NOTICE") {
            const label = tags.split(";").find((tag) => tag.startsWith("label="));
            socket.write(
              `@${label ? `${label};` : ""}msgid=local-${++message};time=${new Date().toISOString()} :${socket.data.nick}!u@localhost ${line}\r\n`,
            );
          } else if (command === "PING")
            socket.write(`:local PONG local :${arguments_.join(" ").replace(/^:/u, "")}\r\n`);
          else if (command === "QUIT") socket.end();
        }
      },
    },
  });
  return {
    server,
    lines,
    connections,
    send(text: string, serverId: string) {
      connections
        .at(-1)!
        .write(
          `@msgid=${serverId};time=${new Date().toISOString()} :guide!u@localhost PRIVMSG #welcome :${text}\r\n`,
        );
    },
    async close() {
      for (const socket of connections) socket.terminate();
      server.stop(true);
      await Bun.sleep(1);
    },
  };
}

describe("real composed local IRC client", () => {
  test("registers, joins, sends/receives, searches, reconnects and restores SQLite history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openirc-integration-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const local = localServer();
    cleanups.push(() => local.close());
    const config = createSettingsRepository(join(directory, "config"));
    const defaults = take(await config.load(signal()));
    const networkId = entityId<"network">("local-integration");
    take(
      await config.save(
        {
          section: "user",
          value: {
            ...defaults.user,
            networks: [
              {
                id: networkId,
                name: "Local integration",
                endpoints: [{ host: "127.0.0.1", port: local.server.port, tls: false }],
                identity: {
                  nick: "newcomer",
                  alternateNicks: ["newcomer_"],
                  username: "openirc",
                  realname: "opentui-irc test",
                },
                autoConnect: true,
                autoJoin: [{ channel: "#welcome" }],
              },
            ],
          },
        },
        defaults.revision,
        signal(),
      ),
    );
    const boot = async (): Promise<AppApi> => {
      const history = take(
        await createHistoryRepository(join(directory, "data", "history.sqlite")),
      );
      const secrets = {
        async resolve() {
          return { ok: true as const, value: "unused" };
        },
        async store() {
          return { ok: true as const, value: entityId<"secret-ref">("env:UNUSED") };
        },
      };
      const app = take(
        await createApp(
          {
            clock: systemClock,
            ids: randomIds,
            diagnostics: { record() {} },
            history,
            settings: config,
            secrets,
            notifications: {
              async notify() {
                return { ok: true, value: undefined };
              },
            },
            sessions: createSessionFactory({
              transport: createBunTransport(),
              secrets,
              clock: systemClock,
              policy: { floodIntervalMs: 1 },
            }),
          },
          signal(),
        ),
      );
      cleanups.push(async () => {
        await app.shutdown();
      });
      return app;
    };
    const app = await boot();
    await until(() =>
      app.state.getSnapshot().conversations.some((c) => c.kind === "channel" && c.joined),
    );
    const channel = app.state.getSnapshot().conversations.find((c) => c.kind === "channel")!;
    take(
      await app.dispatch({ type: "conversation.activate", conversationId: channel.id }, signal()),
    );
    const outgoing = take(
      await app.dispatch(
        {
          type: "message.send",
          conversationId: channel.id,
          kind: "text",
          text: "hello from the client",
        },
        signal(),
      ),
    );
    const read = take(app.timeline(channel.id));
    await until(
      () =>
        read.getSnapshot().messages.find((m) => m.id === outgoing.messageId)?.sendState ===
        "echo-observed",
    );
    local.send("newcomer: welcome from the server", "incoming-1");
    await until(() => read.getSnapshot().messages.some((m) => m.serverId === "incoming-1"));
    expect(
      read.getSnapshot().messages.filter((m) => m.text === "hello from the client"),
    ).toHaveLength(1);
    expect(
      take(await app.search({ text: "welcome from the server", limit: 10 }, signal())).items,
    ).toHaveLength(1);
    expect(
      app.state.getSnapshot().conversations.find((c) => c.id === channel.id)?.mentionCount,
    ).toBe(1);
    take(await app.dispatch({ type: "network.reconnect", networkId }, signal()));
    await until(
      () =>
        local.connections.length === 2 &&
        app.state.getSnapshot().conversations.some((c) => c.id === channel.id && c.joined),
    );
    expect(
      read.getSnapshot().messages.filter((m) => m.text === "hello from the client"),
    ).toHaveLength(1);
    expect((await app.shutdown()).ok).toBe(true);
    const restored = await boot();
    await until(() =>
      restored.state.getSnapshot().conversations.some((c) => c.id === channel.id && c.joined),
    );
    take(
      await restored.dispatch(
        { type: "conversation.activate", conversationId: channel.id },
        signal(),
      ),
    );
    expect(
      take(restored.timeline(channel.id))
        .getSnapshot()
        .messages.some((m) => m.serverId === "incoming-1"),
    ).toBe(true);
    expect(
      take(await restored.search({ text: "hello from the client", limit: 10 }, signal())).items,
    ).toHaveLength(1);
  }, 10000);
});
