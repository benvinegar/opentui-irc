import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Result } from "../../src/contracts/common";
import { createControlExecutor } from "../../src/control/execute";
import { parseControlResponse } from "../../src/control/protocol";
import {
  acquireControlLease,
  probeControlServer,
  resolveControlPaths,
} from "../../src/control/socket";
import { createSecretProvider } from "../../src/storage/secrets";

const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
const project = resolve(import.meta.dirname, "../..");
function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Expected successful lifecycle setup result.");
  return result.value;
}
async function exists(path: string) {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}
async function waitFor(path: string) {
  const until = Date.now() + 4000;
  while (!(await exists(path))) {
    if (Date.now() > until) throw new Error("Lifecycle checkpoint was not reached.");
    await Bun.sleep(5);
  }
}
async function profile() {
  const root = await mkdtemp(join(tmpdir(), "openirc-routing-life-"));
  const config = join(root, "config");
  const paths = value(await resolveControlPaths(config));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => rm(paths.directory, { recursive: true, force: true }));
  return { root, config, paths };
}
/** Isolated module seams delay real SQLite ownership/close; real main, app, settings,
 * service, socket and CLI remain intact. Only UI rendering is replaced (no real TTY needed). */
async function production(
  root: string,
  config: string,
  mode: "startup" | "ready" | "disabled" | "fault",
) {
  const historyPath = join(project, "src/storage/history.ts");
  const uiPath = join(project, "src/ui/start.tsx");
  const mainPath = join(project, "src/main.ts");
  const script = `
    import { mock } from 'bun:test';
    import { access, writeFile } from 'node:fs/promises';
    const root = ${JSON.stringify(root)};
    const net = await import('node:net');
    const originalCreateServer = net.createServer;
    let listener;
    if (${JSON.stringify(mode)} === 'fault') mock.module('node:net', () => ({ ...net, createServer(...args) { listener = originalCreateServer(...args); return listener; } }));
    const wait = async name => { while (!await access(root+'/'+name).then(()=>true,()=>false)) await Bun.sleep(5); };
    const historyModule = await import(${JSON.stringify(historyPath)});
    const openHistory = historyModule.createHistoryRepository;
    mock.module(${JSON.stringify(historyPath)}, () => ({ ...historyModule,
      async createHistoryRepository(path) {
        if (${JSON.stringify(mode)} === 'startup') { await writeFile(root+'/opening', 'checkpoint'); await wait('allow-open'); }
        const opened = await openHistory(path);
        if (!opened.ok) return opened;
        return { ok: true, value: { ...opened.value,
          async close() { await writeFile(root+'/flushing', 'checkpoint'); await wait('allow-close'); return opened.value.close(); }
        } };
      }
    }));
    mock.module(${JSON.stringify(uiPath)}, () => ({ async startUi() {
      let finish; const done = new Promise(resolve => { finish = resolve; });
      await writeFile(root+'/ready', 'checkpoint');
      if (${JSON.stringify(mode)} === 'fault') void wait('fail-listener').then(async () => { listener.emit('error', new Error('Scripted listener fault.')); await writeFile(root+'/listener-failed', 'checkpoint'); });
      return { done, destroy() { finish(); } };
    } }));
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    const { main } = await import(${JSON.stringify(mainPath)});
    process.exitCode = await main(['--config-dir', ${JSON.stringify(config)}, '--data-dir', root+'/data', '--control-allow', 'destructive', ...(${JSON.stringify(mode)} === 'disabled' ? ['--no-control'] : [])]);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
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
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await stdout;
    await stderr;
  });
  return { child, stdout, stderr };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("production startup/shutdown profile ownership", () => {
  test("SIGTERM during history open retains the profile until startup unwinds and actual history close completes", async () => {
    const { root, config } = await profile();
    const { child, stdout, stderr } = await production(root, config, "startup");
    await waitFor(join(root, "opening"));
    expect(value(await probeControlServer(config, signal()))).toBe("live");
    child.kill("SIGTERM");
    await Bun.sleep(20);
    expect(child.exitCode).toBeNull();
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await writeFile(join(root, "allow-open"), "continue");
    await waitFor(join(root, "flushing"));
    expect(child.exitCode).toBeNull();
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    expect(value(await probeControlServer(config, signal()))).toBe("live");
    await writeFile(join(root, "allow-close"), "continue");
    expect(await child.exited).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
  }, 10000);

  test("successful real CLI shutdown flushes one reply before final persistence and keeps the lease during the flush", async () => {
    const { root, config } = await profile();
    const { child, stdout, stderr } = await production(root, config, "ready");
    await waitFor(join(root, "ready"));
    const ctl = Bun.spawn(
      [
        process.execPath,
        "run",
        join(project, "src/main.ts"),
        "--config-dir",
        config,
        "shutdown",
        "--allow-destructive",
        "--confirm",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    cleanups.push(async () => {
      if (ctl.exitCode === null) ctl.kill("SIGKILL");
      await ctl.exited;
    });
    const [code, output, error] = await Promise.all([
      ctl.exited,
      new Response(ctl.stdout).text(),
      new Response(ctl.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(value(parseControlResponse(JSON.parse(output)))).toMatchObject({
      ok: true,
      result: { accepted: true },
    });
    await waitFor(join(root, "flushing"));
    expect(child.exitCode).toBeNull();
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    const execute = createControlExecutor({
      configDirectory: config,
      secrets: createSecretProvider(),
    });
    expect(
      await execute(
        {
          version: 1,
          id: "during-final-flush",
          method: "config.get",
          params: {},
          permissions: ["inspect"],
        },
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await exists(join(config, "tui.jsonc"))).toBe(false);
    await writeFile(join(root, "allow-close"), "continue");
    expect(await child.exited).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
  }, 10000);

  test("listener failure cannot release a still-running application's profile lease", async () => {
    const { root, config } = await profile();
    const { child, stdout, stderr } = await production(root, config, "fault");
    await waitFor(join(root, "ready"));
    await writeFile(join(root, "fail-listener"), "continue");
    await waitFor(join(root, "listener-failed"));
    await Bun.sleep(20);
    expect(child.exitCode).toBeNull();
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    child.kill("SIGTERM");
    await waitFor(join(root, "flushing"));
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await writeFile(join(root, "allow-close"), "continue");
    expect(await child.exited).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
  }, 10000);

  test("control-disabled production app holds its offline lease through shutdown final flush", async () => {
    const { root, config } = await profile();
    const { child, stdout, stderr } = await production(root, config, "disabled");
    await waitFor(join(root, "ready"));
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    child.kill("SIGTERM");
    await waitFor(join(root, "flushing"));
    expect(child.exitCode).toBeNull();
    expect(value(await probeControlServer(config, signal()))).toBe("busy");
    expect((await acquireControlLease(config, signal())).ok).toBe(false);
    await writeFile(join(root, "allow-close"), "continue");
    expect(await child.exited).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    expect(value(await probeControlServer(config, signal()))).toBe("absent");
  }, 10000);
});
