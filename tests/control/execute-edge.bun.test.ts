import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../src/contracts/common";
import {
  DEFAULT_CONTROL_PERMISSIONS,
  type ControlMethod,
  type ControlRequest,
  type JsonObject,
} from "../../src/contracts/control";
import type { SettingsRepository } from "../../src/contracts/settings";
import { createControlExecutor } from "../../src/control/execute";
import { resolveControlPaths } from "../../src/control/socket";
import { createSettingsRepository } from "../../src/storage/settings";
import { harness } from "../app/harness";

const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
const secrets = harness().deps.secrets;
let sequence = 0;
function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Expected successful test setup result.");
  return result.value;
}
function request(method: ControlMethod, params: JsonObject = {}): ControlRequest {
  return {
    version: 1,
    id: `execute-edge-${++sequence}`,
    method,
    params,
    permissions: DEFAULT_CONTROL_PERMISSIONS,
  };
}
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "openirc-execute-edge-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function profile(base: string, name: string) {
  const config = join(base, name);
  await mkdir(config, { recursive: true });
  const paths = value(await resolveControlPaths(config));
  cleanups.push(() => rm(paths.directory, { recursive: true, force: true }));
  return config;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("offline control executor edges", () => {
  test("an adapter that throws while opening settings fails with a static internal error", async () => {
    const config = await profile(await root(), "config");
    const execute = createControlExecutor({
      configDirectory: config,
      secrets,
      settingsFactory: () => {
        throw new Error("private adapter detail");
      },
    });
    const response = await execute(request("config.get"), signal());
    expect(response).toMatchObject({
      ok: false,
      id: expect.stringMatching(/^execute-edge-/),
      error: { code: "internal", retryable: false },
    });
    expect(JSON.stringify(response)).not.toContain("private adapter detail");
  });
  test("bounds cached offline services per profile and recreates evicted ones on demand", async () => {
    const base = await root();
    const configs = await Promise.all(
      Array.from({ length: 18 }, (_, index) => profile(base, `profile-${index}`)),
    );
    const opened: string[] = [];
    const execute = createControlExecutor({
      configDirectory: configs[0]!,
      secrets,
      settingsFactory: (directory): SettingsRepository => {
        opened.push(directory);
        return createSettingsRepository(directory);
      },
    });
    for (const configDirectory of configs)
      expect(await execute(request("config.get"), signal(), { configDirectory })).toMatchObject({
        ok: true,
      });
    expect(opened).toEqual(configs);
    // The most recent profile is still cached; the first one was evicted and is reopened.
    expect(
      await execute(request("networks.list"), signal(), { configDirectory: configs[17]! }),
    ).toMatchObject({ ok: true });
    expect(opened).toHaveLength(18);
    expect(
      await execute(request("networks.list"), signal(), { configDirectory: configs[0]! }),
    ).toMatchObject({ ok: true });
    expect(opened).toHaveLength(19);
    expect(opened.at(-1)).toBe(configs[0]);
  });
  test("rejects malformed and oversized requests before probing the profile", async () => {
    const config = await profile(await root(), "config");
    let opened = 0;
    const execute = createControlExecutor({
      configDirectory: config,
      secrets,
      settingsFactory: (directory) => {
        opened++;
        return createSettingsRepository(directory);
      },
    });
    const malformed = await execute(
      { ...request("status"), method: "raw.irc" } as unknown as ControlRequest,
      signal(),
    );
    expect(malformed).toMatchObject({ ok: false, id: "invalid" });
    const oversized = await execute(
      request("secrets.store", { value: "x".repeat(1024 * 1024) }),
      signal(),
    );
    expect(oversized).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(opened).toBe(0);
  });
});
