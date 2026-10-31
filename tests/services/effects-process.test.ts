import { afterEach, describe, expect, test, vi } from "vitest";
import { createExternalActions, createNotificationSink } from "../../src/services/effects";
import { conversationId } from "../fixtures/scenario";

/**
 * The default runner uses Bun.spawn. These tests replace the Bun global with a fake process
 * table so no real desktop helper (xdg-open, wl-copy, notify-send, ...) is ever started.
 */
interface SpawnCall {
  readonly argv: readonly string[];
  readonly options: { stdin: unknown; stdout: unknown; stderr: unknown };
}
function fakeSpawn(behaviour: "exit-0" | "exit-1" | "hang" | "throw") {
  const calls: SpawnCall[] = [];
  const kills: number[] = [];
  const spawn = vi.fn((argv: string[], options: SpawnCall["options"]) => {
    calls.push({ argv, options });
    if (behaviour === "throw") throw new Error("ENOENT private-detail");
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
      if (behaviour === "exit-0") resolve(0);
      if (behaviour === "exit-1") resolve(1);
    });
    return {
      exited,
      kill: () => {
        kills.push(calls.length);
        finish(143);
      },
    };
  });
  vi.stubGlobal("Bun", { spawn });
  return { calls, kills, spawn };
}

const signal = new AbortController().signal;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("default desktop process runner", () => {
  test("a zero exit status opens the link without any stdin or captured output", async () => {
    const fake = fakeSpawn("exit-0");
    const result = await createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org/path",
      signal,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.argv).toEqual(["xdg-open", "https://example.org/path"]);
    expect(fake.calls[0]!.options).toEqual({ stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  });

  test("copied text is delivered through stdin as a Blob, never as an argument", async () => {
    const fake = fakeSpawn("exit-0");
    expect(await createExternalActions({ platform: "darwin" }).copyText("$(x)", signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fake.calls[0]!.argv).toEqual(["pbcopy"]);
    const stdin = fake.calls[0]!.options.stdin;
    expect(stdin).toBeInstanceOf(Blob);
    expect(stdin instanceof Blob ? await stdin.text() : null).toBe("$(x)");
  });

  test("a failing helper exit status is reported as unavailable and Linux copy falls back", async () => {
    const fake = fakeSpawn("exit-1");
    const opened = await createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org",
      signal,
    );
    expect(opened).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("desktop action failed") },
    });
    const copied = await createExternalActions({ platform: "linux" }).copyText("t", signal);
    expect(copied).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fake.calls.slice(1).map((call) => call.argv[0])).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  test("a missing helper binary is reported safely without leaking the spawn error", async () => {
    fakeSpawn("throw");
    const result = await createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org",
      signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("helper is unavailable") },
    });
    expect(JSON.stringify(result)).not.toContain("private-detail");
  });

  test("aborting a running helper kills it and reports cancellation", async () => {
    const fake = fakeSpawn("hang");
    const controller = new AbortController();
    const pending = createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org",
      controller.signal,
    );
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fake.kills).toEqual([1]);
  });

  test("a helper that never exits is killed after five seconds", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn("hang");
    const pending = createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org",
      signal,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fake.kills).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a spawn failure after cancellation reports cancellation, not unavailability", async () => {
    const controller = new AbortController();
    const spawn = vi.fn(() => {
      controller.abort();
      throw new Error("interrupted");
    });
    vi.stubGlobal("Bun", { spawn });
    const result = await createExternalActions({ platform: "linux" }).openUrl(
      "https://example.org",
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("the default platform is the host platform", async () => {
    const fake = fakeSpawn("exit-0");
    await createExternalActions().openUrl("https://example.org", signal);
    await createNotificationSink().notify({ title: "t", conversationId });
    const supported = process.platform === "linux" || process.platform === "darwin";
    const openers: Record<string, string> = { darwin: "open", linux: "xdg-open" };
    const notifiers: Record<string, string> = { darwin: "osascript", linux: "notify-send" };
    expect(fake.calls.map((call) => call.argv[0])).toEqual(
      supported ? [openers[process.platform], notifiers[process.platform]] : [],
    );
  });

  test("notifications use the default runner and report helper failure", async () => {
    fakeSpawn("exit-1");
    expect(
      await createNotificationSink({ platform: "linux" }).notify({ title: "t", conversationId }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
