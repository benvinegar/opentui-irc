import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../src/app/create-app";
import type { Result } from "../../src/contracts/common";
import {
  DEFAULT_CONTROL_PERMISSIONS,
  type ControlMethod,
  type ControlRequest,
  type JsonObject,
} from "../../src/contracts/control";
import type { SettingsRepository } from "../../src/contracts/settings";
import { createControlExecutor } from "../../src/control/execute";
import { isJsonObject, parseControlResponse } from "../../src/control/protocol";
import { createControlService } from "../../src/control/service";
import {
  acquireControlLease,
  createControlServer,
  probeControlServer,
  resolveControlPaths,
} from "../../src/control/socket";
import { createSettingsRepository, defaultUserSettings } from "../../src/storage/settings";
import { harness } from "../app/harness";

const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
let sequence = 0;
function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Expected successful test setup result.");
  return result.value;
}
function request(method: ControlMethod, params: JsonObject = {}): ControlRequest {
  return {
    version: 1,
    id: `routing-${++sequence}`,
    method,
    params,
    permissions: DEFAULT_CONTROL_PERMISSIONS,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function profile() {
  const root = await mkdtemp(join(tmpdir(), "openirc-routing-"));
  const config = join(root, "config");
  const paths = value(await resolveControlPaths(config));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => rm(paths.directory, { recursive: true, force: true }));
  return { root, config, paths };
}
async function exists(path: string) {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}
const secrets = harness().deps.secrets;
const entry = resolve(import.meta.dirname, "../../src/main.ts");
async function cli(root: string, config: string, args: readonly string[]) {
  const child = Bun.spawn([process.execPath, "run", entry, "--config-dir", config, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
    },
  });
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill();
    await child.exited;
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(stderr).toBe("");
  const response = value(parseControlResponse(JSON.parse(stdout)));
  return { code, response };
}
async function seed(config: string) {
  await mkdir(config, { recursive: true });
  const settings = createSettingsRepository(config);
  return { settings, document: value(await settings.load(signal())) };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real CLI and executor routing", () => {
  test("offline schema/get/apply and autoConnect profile configuration never create history or connect IRC", async () => {
    const { root, config } = await profile();
    let connected = 0;
    const observer = createServer((socket) => {
      connected++;
      socket.destroy();
    });
    await new Promise<void>((done) => observer.listen(0, "127.0.0.1", done));
    cleanups.push(() => new Promise<void>((done) => observer.close(() => done())));
    const address = observer.address();
    if (!address || typeof address === "string") throw new Error("Missing local test port.");
    await mkdir(config);
    await writeFile(
      join(config, "openirc.jsonc"),
      JSON.stringify({
        ...defaultUserSettings(),
        networks: [
          {
            id: "local-only",
            name: "Local scripted endpoint",
            endpoints: [{ host: "127.0.0.1", port: address.port, tls: false }],
            identity: { nick: "test", alternateNicks: [], username: "test", realname: "test" },
            autoConnect: true,
            autoJoin: [],
          },
        ],
      }),
    );
    for (const args of [
      ["config", "schema"],
      ["config", "get"],
      ["config", "set", "tui.theme", '"light"'],
      ["capabilities"],
    ]) {
      const result = await cli(root, config, args);
      expect(result.code).toBe(0);
      expect(result.response.ok).toBe(true);
      if (args[1] === "set")
        expect(result.response).toMatchObject({
          ok: true,
          result: { applied: true, mode: "offline", runtimeEffectsApplied: false },
        });
    }
    expect(value(await createSettingsRepository(config).load(signal())).tui.theme).toBe("light");
    expect(connected).toBe(0);
    expect(await exists(join(root, "xdg-data"))).toBe(false);
    expect((await readdir(config)).sort()).toEqual(["openirc.jsonc", "tui.jsonc"]);
  });

  test("offline capabilities distinguish executable methods from live-only methods", async () => {
    const { config } = await profile();
    const execute = createControlExecutor({ configDirectory: config, secrets });
    const response = await execute(request("capabilities"), signal());
    expect(response.ok).toBe(true);
    if (!response.ok || !isJsonObject(response.result))
      throw new Error("Missing capability object.");
    expect(response.result.mode).toBe("offline");
    expect(response.result.methods).toContain("config.apply");
    expect(response.result.methods).not.toContain("history.search");
    expect(response.result.methods).not.toContain("action.dispatch");
    expect(response.result.liveOnlyMethods).toContain("app.shutdown");
    expect(await execute(request("history.search", { text: "test" }), signal())).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  test("a live CLI mutation updates the actual AppApi settings read model as well as disk", async () => {
    const { root, config } = await profile();
    const { settings } = await seed(config);
    const h = harness();
    const app = value(await createApp({ ...h.deps, settings }, signal()));
    cleanups.push(() => app.shutdown());
    const service = createControlService({ app, settings, secrets });
    const server = value(await createControlServer({ configDirectory: config, handler: service }));
    cleanups.push(() => server.close());
    const before = app.settings.getSnapshot()!.revision;
    const alias = join(root, "live-alias");
    await symlink(config, alias);
    const result = await cli(root, alias, ["config", "set", "tui.theme", '"light"']);
    expect(result.code).toBe(0);
    expect(app.settings.getSnapshot()?.tui.theme).toBe("light");
    expect(app.settings.getSnapshot()?.revision).not.toBe(before);
    expect(value(await settings.load(signal())).revision).toBe(
      app.settings.getSnapshot()!.revision,
    );
    expect(h.sessions).toHaveLength(0);
    expect(await exists(join(root, "xdg-data"))).toBe(false);
  });

  test("busy/disabled/initializing profiles prevent direct writes, including through aliases", async () => {
    const { root, config } = await profile();
    const { settings, document } = await seed(config);
    const alias = join(root, "alias");
    await symlink(config, alias);
    let opened = 0;
    const execute = createControlExecutor({
      configDirectory: alias,
      secrets,
      settingsFactory: () => {
        opened++;
        return settings;
      },
    });
    const mutation = () =>
      request("config.apply", {
        edit: { section: "tui", patch: { theme: "light" } },
        expectedRevision: document.revision,
      });
    const lease = value(await acquireControlLease(config, signal()));
    cleanups.push(() => lease.release());
    expect(await execute(mutation(), signal())).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    const disabled = await cli(root, alias, ["config", "set", "tui.theme", '"light"']);
    expect(disabled.code).toBe(1);
    expect(opened).toBe(0);
    await lease.release();
    const server = value(
      await createControlServer({
        configDirectory: config,
        handler: async (input) => ({
          version: 1,
          id: input.id,
          ok: false,
          error: { code: "unavailable", message: "Initializing.", retryable: true },
        }),
      }),
    );
    cleanups.push(() => server.close());
    expect(await execute(mutation(), signal())).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    expect(opened).toBe(0);
    expect(value(await settings.load(signal())).tui.theme).toBe("dark");
  });

  test("timeout and invalid live replies never fall back to offline repositories", async () => {
    for (const mode of ["timeout", "invalid"] as const) {
      const { config, paths } = await profile();
      const { settings, document } = await seed(config);
      const held = value(await acquireControlLease(config, signal()));
      cleanups.push(() => held.release());
      const sockets = new Set<Socket>();
      let submitted = 0;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.on("data", () => {
          submitted++;
          if (mode === "invalid") socket.end('{"version":2,"id":"bad","ok":true,"result":null}\n');
        });
      });
      await new Promise<void>((done) => server.listen(paths.socketPath, done));
      await chmod(paths.socketPath, 0o600);
      cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      });
      let opened = 0;
      const execute = createControlExecutor({
        configDirectory: config,
        secrets,
        timeoutMs: 30,
        settingsFactory: () => {
          opened++;
          return settings;
        },
      });
      const result = await execute(
        request("config.apply", {
          edit: { section: "tui", patch: { theme: "light" } },
          expectedRevision: document.revision,
        }),
        signal(),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: mode === "timeout" ? "timeout" : "protocol", outcome: "unknown" },
      });
      expect(opened).toBe(0);
      expect(submitted).toBe(1);
      expect(value(await settings.load(signal())).tui.theme).toBe("dark");
      expect((await acquireControlLease(config, signal())).ok).toBe(false);
    }
  });

  test("a cancelled admitted offline save keeps its lease until the actual write finishes", async () => {
    const { config } = await profile();
    const { settings, document } = await seed(config);
    const entered = deferred();
    const finish = deferred();
    cleanups.push(async () => finish.resolve());
    const delayed: SettingsRepository = {
      ...settings,
      async save(change, revision) {
        entered.resolve();
        await finish.promise;
        return settings.save(change, revision, signal()); // Deliberately model an admitted write that cannot be cancelled.
      },
    };
    const execute = createControlExecutor({
      configDirectory: config,
      secrets,
      settingsFactory: () => delayed,
    });
    const controller = new AbortController();
    const pending = execute(
      request("config.apply", {
        edit: { section: "tui", patch: { theme: "light" } },
        expectedRevision: document.revision,
      }),
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    expect(
      (
        await createControlServer({
          configDirectory: config,
          handler: createControlService({ settings, secrets }),
        })
      ).ok,
    ).toBe(false);
    finish.resolve();
    expect((await pending).ok).toBe(true);
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
    expect(value(await settings.load(signal())).tui.theme).toBe("light");
  });

  test("the executor includes the NDJSON newline in its request byte budget before opening storage", async () => {
    const { config } = await profile();
    let opened = 0;
    const execute = createControlExecutor({
      configDirectory: config,
      secrets,
      settingsFactory: (directory) => {
        opened++;
        return createSettingsRepository(directory);
      },
    });
    const envelope = request("status", { padding: "" });
    const maximum = 1024 * 1024;
    const padded = {
      ...envelope,
      params: { padding: "x".repeat(maximum - Buffer.byteLength(JSON.stringify(envelope))) },
    };
    expect(Buffer.byteLength(JSON.stringify(padded))).toBe(maximum);
    expect(await execute(padded, signal())).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
    expect(opened).toBe(0);
  });

  test("invalid request IDs are not echoed into invalid response envelopes", async () => {
    const { config } = await profile();
    const execute = createControlExecutor({ configDirectory: config, secrets });
    const response = await execute({ ...request("status"), id: "unsafe\nrequest-id" }, signal());
    expect(response.ok).toBe(false);
    expect(response.id).toBe("invalid");
    expect(parseControlResponse(response).ok).toBe(true);
  });
});
