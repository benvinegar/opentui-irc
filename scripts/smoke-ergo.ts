import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app/create-app";
import { randomIds, systemClock } from "../src/app/platform-independent-runtime";
import type { AppApi } from "../src/contracts/app";
import type { Result } from "../src/contracts/common";
import { entityId } from "../src/contracts/common";
import { createSessionFactory } from "../src/irc/session";
import { createBunTransport } from "../src/transport/bun";
import { createHistoryRepository } from "../src/storage/history";
import { createSettingsRepository } from "../src/storage/settings";
import { createSecretProvider } from "../src/storage/secrets";

// Official Ergo stable image, version 2.19.1-63c743a70644f0f1, pinned for reproducibility.
const IMAGE =
  "ghcr.io/ergochat/ergo@sha256:72db5b93b437ea0512fb79d9d4d035f0916ccba07ed736dec19e8d5b5a73f972";
const name = `openirc-interop-${process.pid}`;
const networkId = entityId<"network">("ergo-interop");
const signal = () => new AbortController().signal;
const take = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const apps: AppApi[] = [];
let started = false;
const directory = await mkdtemp(join(tmpdir(), "openirc-ergo-"));
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, text] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      "Docker operation failed. Check Docker access and availability of the pinned official Ergo image.",
    );
  return text.trim();
}
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await Bun.sleep(10);
  }
}
try {
  await docker("run", "--rm", "--init", "--name", name, "-d", "-p", "127.0.0.1::6667", IMAGE);
  started = true;
  const portOutput = await docker("port", name, "6667/tcp");
  const port = Number(/:(\d+)$/u.exec(portOutput)?.[1]);
  if (!port) throw new Error("Could not determine loopback test port.");
  const version = await docker("exec", name, "/ircd-bin/ergo", "--version");
  // Give the daemon its initial database/certificate generation window.
  await Bun.sleep(700);
  const suffix = crypto.randomUUID().slice(0, 8);
  const channel = `#openirc-${suffix}`;
  const boot = async (label: string) => {
    const config = createSettingsRepository(join(directory, label, "config"));
    const defaults = take(await config.load(signal()));
    take(
      await config.save(
        {
          section: "user",
          value: {
            ...defaults.user,
            sendTyping: true,
            networks: [
              {
                id: networkId,
                name: "Ergo interoperability",
                endpoints: [{ host: "127.0.0.1", port, tls: false }],
                identity: {
                  nick: `${label}${suffix}`,
                  alternateNicks: [],
                  username: "openirc",
                  realname: "OpenIRC local interoperability test",
                },
                autoConnect: true,
                autoJoin: [{ channel }],
              },
            ],
          },
        },
        defaults.revision,
        signal(),
      ),
    );
    const history = take(await createHistoryRepository(join(directory, label, "history.sqlite")));
    const secrets = createSecretProvider();
    const app = take(
      await createApp(
        {
          clock: systemClock,
          ids: randomIds,
          settings: config,
          history,
          secrets,
          sessions: createSessionFactory({
            transport: createBunTransport(),
            secrets,
            clock: systemClock,
            policy: { floodIntervalMs: 5 },
          }),
          diagnostics: { record() {} },
          notifications: {
            async notify() {
              return { ok: true, value: undefined };
            },
          },
        },
        signal(),
      ),
    );
    apps.push(app);
    await until(
      () => app.state.getSnapshot().conversations.some((c) => c.name === channel && c.joined),
      `join for ${label}`,
    );
    const conversation = app.state.getSnapshot().conversations.find((c) => c.name === channel)!;
    const timeline = take(app.timeline(conversation.id));
    return { app, conversation, timeline };
  };
  const a = await boot("alice");
  const b = await boot("bob");
  take(
    await a.app.dispatch(
      {
        type: "message.send",
        conversationId: a.conversation.id,
        text: "real Ergo message",
        kind: "text",
      },
      signal(),
    ),
  );
  await until(
    () =>
      b.timeline.getSnapshot().messages.some((m) => m.text === "real Ergo message" && !!m.serverId),
    "real server message IDs",
  );
  const original = b.timeline.getSnapshot().messages.find((m) => m.text === "real Ergo message")!;
  await until(
    () =>
      a.timeline
        .getSnapshot()
        .messages.some(
          (m) => m.text === "real Ergo message" && m.sendState === "echo-observed" && !!m.serverId,
        ),
    "correlated server echo",
  );
  const features = b.app.state.getSnapshot().networks[0]!.features;
  if (!features.history || !features.replies || !features.typing || !features.reactions)
    throw new Error("Expected modern Ergo features were not negotiated.");
  take(
    await b.app.dispatch(
      {
        type: "message.send",
        conversationId: b.conversation.id,
        text: "real Ergo reply",
        kind: "text",
        replyTo: original.id,
      },
      signal(),
    ),
  );
  await until(
    () =>
      a.timeline
        .getSnapshot()
        .messages.some(
          (m) => m.text === "real Ergo reply" && m.replyTo?.serverId === original.serverId,
        ),
    "reply tag interoperability",
  );
  take(
    await b.app.dispatch(
      { type: "typing.set", conversationId: b.conversation.id, active: true },
      signal(),
    ),
  );
  await until(
    () => a.timeline.getSnapshot().typing.length > 0,
    "typing indicator interoperability",
  );
  await Bun.sleep(3050); // Honor the client-tag rate limit before sending done.
  take(
    await b.app.dispatch(
      { type: "typing.set", conversationId: b.conversation.id, active: false },
      signal(),
    ),
  );
  await until(
    () => a.timeline.getSnapshot().typing.length === 0,
    "typing completion interoperability",
  );
  take(
    await b.app.dispatch(
      { type: "message.react", messageId: original.id, value: "👍", remove: false },
      signal(),
    ),
  );
  await until(
    () =>
      a.timeline
        .getSnapshot()
        .messages.some(
          (m) =>
            m.serverId === original.serverId &&
            m.reactions.some((r) => r.value === "👍" && r.count === 1),
        ),
    "reaction interoperability",
  );
  const multiline = "first pasted line\n/join #not-a-command\n\nlast pasted line";
  take(
    await a.app.dispatch(
      { type: "message.send", conversationId: a.conversation.id, text: multiline, kind: "text" },
      signal(),
    ),
  );
  await until(
    () =>
      b.timeline.getSnapshot().messages.some((m) => m.text === "/join #not-a-command") &&
      b.timeline.getSnapshot().messages.some((m) => m.text === "last pasted line"),
    "paced literal multiline fallback",
  );
  await until(
    () =>
      a.timeline
        .getSnapshot()
        .messages.some((m) => m.text === multiline && m.sendState === "echo-observed"),
    "multiline aggregate echo",
  );
  if (a.app.state.getSnapshot().conversations.some((c) => c.name === "#not-a-command"))
    throw new Error("Pasted text unexpectedly became a command.");
  const c = await boot("carol");
  await until(
    () =>
      c.timeline
        .getSnapshot()
        .messages.some((m) => m.text === "real Ergo message" && m.source === "playback"),
    "CHATHISTORY playback interoperability",
  );
  console.log(
    JSON.stringify(
      {
        server: version,
        loopbackOnly: true,
        checks: [
          "registration",
          "JOIN",
          "message IDs",
          "echo",
          "replies",
          "typing",
          "reactions",
          "CHATHISTORY playback",
          "literal multiline fallback",
        ],
        features,
      },
      null,
      2,
    ),
  );
} finally {
  for (const app of apps.reverse()) await app.shutdown();
  if (started) await docker("rm", "-f", name).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
