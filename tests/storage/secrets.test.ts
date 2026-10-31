import { afterEach, describe, expect, test, vi } from "vitest";
import { entityId } from "../../src/contracts/common";
import { createSecretProvider } from "../../src/storage/secrets";

const signal = new AbortController().signal;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("credential references", () => {
  test("resolves only explicit environment references and never includes reference/value in errors", async () => {
    vi.stubEnv("OPENIRC_TEST_SECRET", "private-test-value");
    const provider = createSecretProvider();
    expect(await provider.resolve(entityId("env:OPENIRC_TEST_SECRET"), signal)).toEqual({
      ok: true,
      value: "private-test-value",
    });
    const missing = await provider.resolve(entityId("env:OPENIRC_DOES_NOT_EXIST"), signal);
    expect(missing.ok ? null : missing.error.code).toBe("unavailable");
    expect(JSON.stringify(missing)).not.toContain("OPENIRC_DOES_NOT_EXIST");
    expect((await provider.resolve(entityId("file:/tmp/password"), signal)).ok).toBe(false);
    expect((await provider.resolve(entityId("env:BAD VARIABLE"), signal)).ok).toBe(false);
  });
  test("missing OS store is explicitly unsupported with no plaintext fallback", async () => {
    vi.stubGlobal("Bun", undefined);
    const provider = createSecretProvider();
    const stored = await provider.store("private-test-value", signal);
    expect(stored.ok ? null : stored.error.code).toBe("unsupported");
    expect(JSON.stringify(stored)).not.toContain("private-test-value");
    expect(
      (await provider.resolve(entityId("keychain:00000000-0000-0000-0000-000000000000"), signal))
        .ok,
    ).toBe(false);
  });
  test("OS vault write must be read back before returning a durable opaque reference", async () => {
    const vault = new Map<string, string>();
    const set = vi.fn(async ({ name, value }: { name: string; value: string }) => {
      vault.set(name, value);
    });
    const get = vi.fn(async ({ name }: { name: string }) => vault.get(name) ?? null);
    vi.stubGlobal("Bun", { secrets: { set, get } });
    const provider = createSecretProvider();
    const result = await provider.store("private-test-value", signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/^keychain:[a-f0-9-]{36}$/u);
    expect(await provider.resolve(result.value, signal)).toEqual({
      ok: true,
      value: "private-test-value",
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ service: "org.openirc.credentials" }),
    );
  });
  test("locked or broken vault returns safe failure rather than claiming secure storage", async () => {
    vi.stubGlobal("Bun", {
      secrets: {
        set: vi.fn(async () => {
          throw new Error("private-test-value");
        }),
        get: vi.fn(),
      },
    });
    const failed = await createSecretProvider().store("private-test-value", signal);
    expect(failed.ok ? null : failed.error.code).toBe("unsupported");
    expect(JSON.stringify(failed)).not.toContain("private-test-value");
    const remove = vi.fn(async () => true);
    vi.stubGlobal("Bun", {
      secrets: { set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: remove },
    });
    expect((await createSecretProvider().store("private-test-value", signal)).ok).toBe(false);
    expect(remove).toHaveBeenCalled();
  });
  test("aborting a pending OS lookup promptly unblocks and detaches its abort listener", async () => {
    vi.stubGlobal("Bun", { secrets: { get: vi.fn(() => new Promise(() => {})) } });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = createSecretProvider().resolve(
      entityId("keychain:00000000-0000-0000-0000-000000000000"),
      controller.signal,
    );
    controller.abort();
    const result = await pending;
    expect(result.ok ? null : result.error.code).toBe("cancelled");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("cancellation happens before any credential access and empty strings are rejected", async () => {
    const set = vi.fn();
    vi.stubGlobal("Bun", { secrets: { set, get: vi.fn() } });
    const aborted = new AbortController();
    aborted.abort();
    const provider = createSecretProvider();
    expect((await provider.store("private-test-value", aborted.signal)).ok).toBe(false);
    expect((await provider.resolve(entityId("env:OPENIRC_TEST_SECRET"), aborted.signal)).ok).toBe(
      false,
    );
    expect((await provider.store("", signal)).ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("OS vault edge cases", () => {
  const reference = entityId<"secret-ref">("keychain:00000000-0000-0000-0000-000000000000");
  test("a missing, rejected or throwing vault lookup is unavailable without leaking details", async () => {
    const get = vi.fn(async (): Promise<string | null> => null);
    vi.stubGlobal("Bun", { secrets: { get } });
    const provider = createSecretProvider();
    expect(await provider.resolve(reference, signal)).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("not available") },
    });
    expect(get).toHaveBeenCalledWith({
      service: "org.openirc.credentials",
      name: "00000000-0000-0000-0000-000000000000",
    });
    get.mockImplementationOnce(async () => {
      throw new Error("private-test-value");
    });
    const rejected = await provider.resolve(reference, signal);
    expect(rejected).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(rejected)).not.toContain("private-test-value");
    get.mockImplementationOnce(() => {
      throw new Error("private-test-value");
    });
    const thrown = await provider.resolve(reference, signal);
    expect(thrown).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(thrown)).not.toContain("private-test-value");
  });
  test("a vault without get support is unsupported for lookups and storage", async () => {
    const set = vi.fn();
    vi.stubGlobal("Bun", { secrets: { set } });
    const provider = createSecretProvider();
    expect(await provider.resolve(reference, signal)).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(await provider.store("private-test-value", signal)).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(set).not.toHaveBeenCalled();
  });
  test.each([["a\u0000b"], ["x".repeat(65_537)]])(
    "rejects unstorable credential %# before touching the vault",
    async (value) => {
      const set = vi.fn();
      vi.stubGlobal("Bun", { secrets: { set, get: vi.fn() } });
      expect(await createSecretProvider().store(value, signal)).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
      expect(set).not.toHaveBeenCalled();
    },
  );
  test("failed cleanup after an unverifiable or failed write never falls back to plaintext", async () => {
    const remove = vi.fn(async () => {
      throw new Error("locked");
    });
    vi.stubGlobal("Bun", {
      secrets: { set: vi.fn(async () => {}), get: vi.fn(async () => "other"), delete: remove },
    });
    const provider = createSecretProvider();
    expect(await provider.store("private-test-value", signal)).toMatchObject({
      ok: false,
      error: { code: "unsupported", message: expect.stringContaining("verified") },
    });
    vi.stubGlobal("Bun", {
      secrets: {
        set: vi.fn(async () => {
          throw new Error("denied");
        }),
        get: vi.fn(),
        delete: remove,
      },
    });
    expect(await provider.store("private-test-value", signal)).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
