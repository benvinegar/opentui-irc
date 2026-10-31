/**
 * Bun-runtime coverage for the OS boundary adapters (desktop helpers, credential vault, clock).
 * Bun.spawn and Bun.secrets are replaced with in-memory fakes for every test, so no real
 * keychain, xdg-open/open, clipboard helper or notification daemon is ever invoked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomIds, systemClock } from "../../src/app/platform-independent-runtime";
import { entityId } from "../../src/contracts/common";
import { createExternalActions, createNotificationSink } from "../../src/services/effects";
import { createSecretProvider } from "../../src/storage/secrets";

type Exit = number | "hang" | "throw";
interface Spawned {
  readonly argv: readonly string[];
  readonly stdin: unknown;
}
const realSpawn = Bun.spawn;
const realSecrets = Bun.secrets;
let spawned: Spawned[] = [];
let kills = 0;
let nextExit: Exit[] = [];

function fakeSpawn(argv: string[], options: { stdin: unknown }) {
  spawned.push({ argv, stdin: options.stdin });
  const exit = nextExit.shift() ?? 0;
  if (exit === "throw") throw new Error("ENOENT private-detail");
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
    if (exit !== "hang") resolve(exit);
  });
  return {
    exited,
    kill() {
      kills += 1;
      finish(143);
    },
  };
}

function useVault(vault: Map<string, string>, overrides: Record<string, unknown> = {}) {
  Object.assign(Bun, {
    secrets: {
      get: async ({ name }: { name: string }) => vault.get(name) ?? null,
      set: async ({ name, value }: { name: string; value: string }) => {
        vault.set(name, value);
      },
      delete: async ({ name }: { name: string }) => vault.delete(name),
      ...overrides,
    },
  });
}

beforeEach(() => {
  spawned = [];
  kills = 0;
  nextExit = [];
  Object.assign(Bun, { spawn: fakeSpawn });
  useVault(new Map());
});
afterEach(() => {
  Object.assign(Bun, { spawn: realSpawn, secrets: realSecrets });
});

const signal = new AbortController().signal;
const conversationId = entityId<"conversation">("conversation-1");

describe("desktop effects with the default runner", () => {
  test("links open through the platform helper and invalid links never spawn", async () => {
    const linux = createExternalActions({ platform: "linux" });
    expect(await linux.openUrl("https://example.org/a", signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      await createExternalActions({ platform: "darwin" }).openUrl("http://x.test", signal),
    ).toMatchObject({ ok: true });
    for (const bad of ["nope", "ftp://example.org", "https://u:p@example.org", "a b"])
      expect(await linux.openUrl(bad, signal)).toMatchObject({ error: { code: "invalid-input" } });
    expect(
      await createExternalActions({ platform: "win32" }).openUrl("https://example.org", signal),
    ).toMatchObject({ error: { code: "unsupported" } });
    expect(spawned.map((call) => call.argv)).toEqual([
      ["xdg-open", "https://example.org/a"],
      ["open", "http://x.test/"],
    ]);
    expect(spawned[0]!.stdin).toBe("ignore");
  });

  test("copy pipes text through stdin and falls back across failing Linux helpers", async () => {
    nextExit = [1, "throw", 0];
    const result = await createExternalActions({ platform: "linux" }).copyText("hi", signal);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(spawned.map((call) => call.argv[0])).toEqual(["wl-copy", "xclip", "xsel"]);
    const stdin = spawned[2]!.stdin;
    expect(stdin instanceof Blob ? await stdin.text() : null).toBe("hi");
    nextExit = [1];
    expect(await createExternalActions({ platform: "darwin" }).copyText("x", signal)).toMatchObject(
      { error: { code: "unavailable", message: expect.stringContaining("Clipboard") } },
    );
    expect(await createExternalActions({ platform: "aix" }).copyText("x", signal)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(
      await createExternalActions({ platform: "linux" }).copyText("a\u0000", signal),
    ).toMatchObject({ error: { code: "invalid-input" } });
  });

  test("aborting a running helper kills it and reports cancellation", async () => {
    nextExit = ["hang"];
    const controller = new AbortController();
    const pending = createExternalActions({ platform: "linux" }).copyText("x", controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: "cancelled" } });
    expect(kills).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await createExternalActions({ platform: "linux" }).openUrl("https://e.test", aborted.signal),
    ).toMatchObject({ error: { code: "cancelled" } });
    expect(spawned).toHaveLength(1);
  });

  test("notifications pass sanitized text as arguments on Linux and macOS only", async () => {
    nextExit = [0, 1];
    expect(
      await createNotificationSink({ platform: "linux" }).notify({
        title: "a\u0007b",
        body: "c",
        conversationId,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await createNotificationSink({ platform: "darwin" }).notify({ title: "t", conversationId }),
    ).toMatchObject({ error: { code: "unavailable" } });
    expect(
      await createNotificationSink({ platform: "sunos" }).notify({ title: "t", conversationId }),
    ).toMatchObject({ error: { code: "unsupported" } });
    expect(spawned[0]!.argv.slice(-2)).toEqual(["a b", "c"]);
    expect(spawned[1]!.argv.slice(-2)).toEqual(["t", ""]);
  });
});

describe("credential vault adapter under Bun", () => {
  test("stored credentials are verified, opaque and resolvable", async () => {
    const vault = new Map<string, string>();
    useVault(vault);
    const provider = createSecretProvider();
    const stored = await provider.store("private-test-value", signal);
    expect(stored.ok && stored.value.startsWith("keychain:")).toBe(true);
    if (!stored.ok) return;
    expect(await provider.resolve(stored.value, signal)).toEqual({
      ok: true,
      value: "private-test-value",
    });
    expect([...vault.values()]).toEqual(["private-test-value"]);
  });

  test("unverifiable and failed writes are cleaned up and never claim secure storage", async () => {
    const vault = new Map<string, string>();
    useVault(vault, { get: async () => "different" });
    const provider = createSecretProvider();
    expect(await provider.store("private-test-value", signal)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(vault.size).toBe(0);
    useVault(vault, {
      set: async () => {
        throw new Error("locked");
      },
      delete: async () => {
        throw new Error("locked");
      },
    });
    expect(await provider.store("private-test-value", signal)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(await provider.store("", signal)).toMatchObject({ error: { code: "invalid-input" } });
  });

  test("lookups report missing, failing and cancelled vault access safely", async () => {
    const reference = entityId<"secret-ref">("keychain:00000000-0000-0000-0000-000000000000");
    const provider = createSecretProvider();
    expect(await provider.resolve(reference, signal)).toMatchObject({
      error: { code: "unavailable" },
    });
    useVault(new Map(), {
      get: async () => {
        throw new Error("private-detail");
      },
    });
    const failed = await provider.resolve(reference, signal);
    expect(failed).toMatchObject({ error: { code: "unavailable" } });
    expect(JSON.stringify(failed)).not.toContain("private-detail");
    useVault(new Map(), { get: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = provider.resolve(reference, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: "cancelled" } });
    Object.assign(Bun, { secrets: undefined });
    expect(await provider.resolve(reference, signal)).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(await provider.store("v", signal)).toMatchObject({ error: { code: "unsupported" } });
  });
});

describe("platform runtime and opaque ids under Bun", () => {
  test("sleep resolves, honours cancellation and ids are unique", async () => {
    const started = systemClock.now();
    await systemClock.sleep(1, signal);
    expect(systemClock.now()).toBeGreaterThanOrEqual(started);
    const aborted = new AbortController();
    aborted.abort();
    await expect(systemClock.sleep(10, aborted.signal)).rejects.toThrow("Cancelled");
    const controller = new AbortController();
    const pending = systemClock.sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Cancelled");
    expect(randomIds.next()).not.toBe(randomIds.next());
  });

  test("opaque ids reject empty and control-character values", () => {
    expect(() => entityId("")).toThrow(TypeError);
    expect(() => entityId("a\u0007b")).toThrow("Invalid opaque ID");
    expect(() => entityId("a\u007fb")).toThrow(TypeError);
    expect(entityId("ok")).toBe(entityId("ok"));
  });
});
