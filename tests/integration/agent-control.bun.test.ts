import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AppApi } from "../../src/contracts/app";
import type { ControlHandler, ControlPermission } from "../../src/contracts/control";
import { ALL_CONTROL_PERMISSIONS } from "../../src/contracts/control";
import { entityId } from "../../src/contracts/common";
import { createApp } from "../../src/app/create-app";
import { createHistoryRepository } from "../../src/storage/history";
import { createSettingsRepository } from "../../src/storage/settings";
import { createControlService } from "../../src/control/service";
import {
  acquireControlLease,
  createControlServer,
  resolveControlPaths,
} from "../../src/control/socket";
import { parseControlResponse } from "../../src/control/protocol";
import { harness, settle } from "../app/harness";
import { profile } from "../fixtures/scenario";

const entry = resolve(import.meta.dirname, "../../src/ctl.ts");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
async function run(configDirectory: string, args: readonly string[], input?: string) {
  const child = Bun.spawn(
    [process.execPath, "run", entry, "--config-dir", configDirectory, ...args],
    { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const parsed = parseControlResponse(JSON.parse(stdout));
  if (!parsed.ok) throw new Error("CLI did not produce a valid response");
  expect(code).toBe(parsed.value.ok ? 0 : 1);
  return { response: parsed.value, stdout, stderr, code };
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "openirc-agent-"));
  const config = join(root, "config");
  const paths = await resolveControlPaths(config);
  if (!paths.ok) throw new Error("expected private paths");
  cleanups.push(async () => {
    await rm(paths.value.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { root, config };
}
async function live(permissions?: readonly ControlPermission[]) {
  const { root, config } = await directory();
  const repo = createSettingsRepository(config);
  const defaults = await repo.load(signal());
  if (!defaults.ok) throw new Error("expected defaults");
  const saved = await repo.save(
    { section: "user", value: { ...defaults.value.user, networks: [profile] } },
    defaults.value.revision,
    signal(),
  );
  if (!saved.ok) throw new Error("expected config save");
  const h = harness();
  let handler: ControlHandler | undefined;
  const started = await createControlServer({
    configDirectory: config,
    handler: (req, sig) =>
      handler
        ? handler(req, sig)
        : Promise.resolve({
            version: 1,
            id: req.id,
            ok: false,
            error: { code: "unavailable", message: "Initializing", retryable: true },
          }),
  });
  if (!started.ok) throw new Error(started.error.message);
  let app: AppApi | undefined;
  cleanups.push(async () => {
    await app?.shutdown();
    await started.value.close();
  });
  const history = await createHistoryRepository(join(root, "data", "history.sqlite"));
  if (!history.ok) throw new Error("expected history");
  const created = await createApp({ ...h.deps, settings: repo, history: history.value }, signal());
  if (!created.ok) throw new Error(created.error.message);
  app = created.value;
  handler = createControlService({
    app,
    settings: repo,
    secrets: h.deps.secrets,
    ...(permissions ? { permissions } : {}),
  });
  return { root, config, repo, app, h, server: started.value };
}

describe("real headless agent CLI", () => {
  test("offline schema/planning/apply is JSON-only, CAS checked, and never opens history", async () => {
    const { root, config } = await directory();
    const schema = await run(config, ["config", "schema", "--json"]);
    expect(schema.response.ok).toBe(true);
    expect(schema.stdout).toContain("retentionDays");
    const before = await run(config, ["config", "get"]);
    expect(before.response.ok).toBe(true);
    const dry = await run(config, ["config", "set", "tui.theme", '"light"', "--dry-run"]);
    expect(dry.response.ok).toBe(true);
    expect((await createSettingsRepository(config).load(signal())).ok).toBe(true);
    expect(
      await stat(join(config, "tui.jsonc")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const applied = await run(config, ["config", "set", "tui.theme", '"light"']);
    expect(applied.response.ok).toBe(true);
    const settings = await createSettingsRepository(config).load(signal());
    expect(settings.ok && settings.value.tui.theme).toBe("light");
    const stale = await run(config, [
      "config",
      "set",
      "tui.theme",
      '"dark"',
      "--expected-revision",
      "stale-revision",
    ]);
    expect(stale.response).toMatchObject({ ok: false, error: { code: "conflict" } });
    const status = await run(config, ["status"]);
    expect(status.response).toMatchObject({ ok: true, result: { running: false } });
    expect(
      await stat(join(root, "data")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  test("offline network setup/update/remove preserves unrelated settings without connecting", async () => {
    const { config } = await directory();
    const added = await run(config, [
      "networks",
      "add",
      "--id",
      "libera",
      "--name",
      "Libera",
      "--host",
      "irc.libera.chat",
      "--nick",
      "newcomer",
    ]);
    expect(added.response.ok).toBe(true);
    const repo = createSettingsRepository(config);
    const doc = await repo.load(signal());
    if (!doc.ok) throw new Error("expected config");
    expect(doc.value.user.networks[0]?.autoConnect).toBe(false);
    const updated = { ...doc.value.user.networks[0]!, autoJoin: [{ channel: "#typescript" }] };
    const changed = await run(
      config,
      ["networks", "update", "libera", "--stdin"],
      JSON.stringify(updated),
    );
    expect(changed.response.ok).toBe(true);
    const loaded = await repo.load(signal());
    expect(loaded.ok && loaded.value.user.networks[0]?.autoJoin[0]?.channel).toBe("#typescript");
    if (!loaded.ok) throw new Error("expected updated config");
    const withExclusions = await repo.save(
      {
        section: "user",
        value: {
          ...loaded.value.user,
          networks: [...loaded.value.user.networks, profile],
          history: {
            ...loaded.value.user.history,
            excludedConversations: [
              { networkId: loaded.value.user.networks[0]!.id, kind: "direct", name: "friend" },
              { networkId: profile.id, kind: "direct", name: "other-friend" },
            ],
          },
        },
      },
      loaded.value.revision,
      signal(),
    );
    expect(withExclusions.ok).toBe(true);
    const removed = await run(config, ["networks", "remove", "libera"]);
    expect(removed.response.ok).toBe(true);
    const final = await repo.load(signal());
    expect(final.ok && final.value.user.networks.map((network) => network.id)).toEqual([
      profile.id,
    ]);
    expect(final.ok && final.value.user.history.retentionDays).toBe(30);
    expect(final.ok && final.value.user.history.excludedConversations).toEqual([
      { networkId: profile.id, kind: "direct", name: "other-friend" },
    ]);
  });
  test("does not expose rejected secret argv/input or allow unsafe destructive defaults", async () => {
    const { config } = await directory();
    const invalid = await run(config, ["secrets", "store", "--value", "private-should-not-echo"]);
    expect(invalid.response.ok).toBe(false);
    expect(invalid.stdout + invalid.stderr).not.toContain("private-should-not-echo");
    const badConfig = await run(
      config,
      ["config", "apply", "--stdin"],
      JSON.stringify({ section: "user", patch: { password: "private-rejected-config" } }),
    );
    expect(badConfig.response.ok).toBe(false);
    expect(badConfig.stdout + badConfig.stderr).not.toContain("private-rejected-config");
    const denied = await run(config, ["config", "set", "user.history.retentionDays", "7"]);
    expect(denied.response).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    const confirmed = await run(config, [
      "config",
      "set",
      "user.history.retentionDays",
      "7",
      "--allow-destructive",
      "--confirm",
    ]);
    expect(confirmed.response.ok).toBe(true);
  });
  test("routes live configuration through AppApi and reports explicit permission boundaries", async () => {
    const context = await live();
    expect((await run(context.config, ["status"])).response).toMatchObject({
      ok: true,
      result: { running: true },
    });
    expect((await run(context.config, ["config", "set", "tui.theme", '"light"'])).response.ok).toBe(
      true,
    );
    expect(context.app.settings.getSnapshot()?.tui.theme).toBe("light");
    expect(context.h.sessions).toHaveLength(0);
    const read = await run(context.config, [
      "history",
      "search",
      "--text",
      "private",
      "--allow-read",
    ]);
    expect(read.response).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    const write = await run(
      context.config,
      ["action", "--stdin", "--allow-send"],
      JSON.stringify({
        type: "message.send",
        conversationId: "any",
        text: "private-do-not-send",
        kind: "text",
      }),
    );
    expect(write.response).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(context.h.sessions).toHaveLength(0);
    expect(await readFile(join(context.config, "tui.jsonc"), "utf8")).toContain("light");
  });
  test("granted message access still needs caller intent, and uses normal app actions", async () => {
    const context = await live(ALL_CONTROL_PERMISSIONS);
    expect((await run(context.config, ["networks", "connect", profile.id])).response.ok).toBe(true);
    await settle();
    const session = context.h.session(profile.id);
    session.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await settle();
    expect(
      (await run(context.config, ["conversations", "query", profile.id, "peer"])).response.ok,
    ).toBe(true);
    const conversation = context.app.state
      .getSnapshot()
      .conversations.find((c) => c.kind === "direct")!;
    const body = {
      type: "message.send",
      conversationId: conversation.id,
      text: "private test message",
      kind: "text",
    };
    expect(
      (await run(context.config, ["action", "--stdin"], JSON.stringify(body))).response,
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    const sent = await run(
      context.config,
      ["action", "--stdin", "--allow-send"],
      JSON.stringify(body),
    );
    expect(sent.response.ok).toBe(true);
    expect(session.commands.filter((item) => item.command.type === "send")).toHaveLength(1);
    const without = await run(context.config, ["history", "search", "--text", "private"]);
    expect(without.response.ok).toBe(false);
    expect(without.stdout).not.toContain("private test message");
    const read = await run(context.config, [
      "history",
      "search",
      "--text",
      "private",
      "--allow-read",
    ]);
    expect(read.response.ok).toBe(true);
    expect(read.stdout).toContain("private test message");
    const timeline = await run(context.config, [
      "timeline",
      "get",
      conversation.id,
      "--allow-read",
    ]);
    expect(timeline.response.ok).toBe(true);
    expect(timeline.stdout).toContain("private test message");
  });
  test("real stdin and Unix IPC hand credentials only to secure ingress and return references", async () => {
    const context = await live();
    let received = "";
    // Use a supported reference shape, never a live OS vault or real credential in tests.
    context.h.deps.secrets.store = async (value) => {
      received = value;
      return { ok: true, value: entityId<"secret-ref">("env:AGENT_TEST") };
    };
    const stored = await run(
      context.config,
      ["secrets", "store", "--stdin"],
      "synthetic-sensitive-password\n",
    );
    expect(received).toBe("synthetic-sensitive-password");
    expect(stored.response).toMatchObject({ ok: true, result: { reference: "env:AGENT_TEST" } });
    expect(stored.stdout + stored.stderr).not.toContain("synthetic-sensitive-password");
    const updated = {
      ...profile,
      sasl: {
        mechanism: "PLAIN",
        account: "test-account",
        password: "env:AGENT_TEST",
        required: true,
      },
    };
    const applied = await run(
      context.config,
      ["networks", "update", profile.id, "--stdin"],
      JSON.stringify(updated),
    );
    expect(applied.response.ok).toBe(true);
    const inspected = await run(context.config, ["config", "get"]);
    expect(inspected.stdout).toContain("env:AGENT_TEST");
    expect(inspected.stdout).not.toContain("synthetic-sensitive-password");
    expect(context.h.sessions).toHaveLength(0);
  });
  test("external settings reload is inspected then applied to the live app", async () => {
    const context = await live();
    const original = context.app.settings.getSnapshot()!;
    const external = await context.repo.save(
      { section: "tui", value: { ...original.tui, theme: "high-contrast" } },
      original.revision,
      signal(),
    );
    expect(external.ok).toBe(true);
    expect(context.app.settings.getSnapshot()?.tui.theme).toBe("dark");
    const preview = await run(context.config, ["config", "reload", "--dry-run"]);
    expect(preview.response.ok).toBe(true);
    expect(context.app.settings.getSnapshot()?.tui.theme).toBe("dark");
    const reloaded = await run(context.config, ["config", "reload"]);
    expect(reloaded.response.ok).toBe(true);
    expect(context.app.settings.getSnapshot()?.tui.theme).toBe("high-contrast");
  });
  test("busy/control-disabled profiles never receive fallback file writes", async () => {
    const { config } = await directory();
    const lease = await acquireControlLease(config, signal());
    if (!lease.ok) throw new Error("expected lease");
    cleanups.push(() => lease.value.release());
    const response = await run(config, ["config", "set", "tui.theme", '"light"']);
    expect(response.response).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(
      await stat(join(config, "tui.jsonc")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
