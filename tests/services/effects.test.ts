import { describe, expect, test } from "vitest";
import {
  createExternalActions,
  createNotificationSink,
  type EffectRequest,
} from "../../src/services/effects";
import { conversationId } from "../fixtures/scenario";

const signal = new AbortController().signal;
function runner() {
  const calls: EffectRequest[] = [];
  return {
    calls,
    run: async (request: EffectRequest) => {
      calls.push(request);
      return { ok: true as const, value: undefined };
    },
  };
}
describe("safe OS effects", () => {
  test.each([
    "javascript:alert(1)",
    "file:///tmp/private",
    "irc://example.org",
    "https://name:password@example.org",
    "https://example.org/\nsecret",
    "--help",
    "https://example.org/\u001b",
  ])("rejects unsafe URI %j without running anything", async (url) => {
    const spy = runner();
    expect(
      await createExternalActions({ platform: "linux", run: spy.run }).openUrl(url, signal),
    ).toMatchObject({ ok: false });
    expect(spy.calls).toHaveLength(0);
  });
  test("link arguments containing shell syntax are passed as one argument, never interpolated", async () => {
    const spy = runner();
    expect(
      await createExternalActions({ platform: "linux", run: spy.run }).openUrl(
        "https://example.org/$(touch%20oops);echo",
        signal,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(spy.calls[0]?.argv).toEqual(["xdg-open", "https://example.org/$(touch%20oops);echo"]);
  });
  test("copy uses stdin, falls back across missing Linux helpers, and visibly fails", async () => {
    const calls: EffectRequest[] = [];
    const external = createExternalActions({
      platform: "linux",
      run: async (request) => {
        calls.push(request);
        return { ok: false, error: { code: "unavailable", message: "Missing", retryable: false } };
      },
    });
    expect(await external.copyText(";$(not a command)", signal)).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("terminal") },
    });
    expect(calls).toHaveLength(3);
    expect(
      calls.every(
        (call) => call.input === ";$(not a command)" && !call.argv.includes(";$(not a command)"),
      ),
    ).toBe(true);
  });
  test("cancellation prevents effects and unsupported platforms report honestly", async () => {
    const spy = runner();
    const abort = new AbortController();
    abort.abort();
    const external = createExternalActions({ platform: "darwin", run: spy.run });
    expect(await external.openUrl("https://example.org", abort.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await external.copyText("text", abort.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(spy.calls).toHaveLength(0);
    expect(
      await createExternalActions({ platform: "other", run: spy.run }).copyText("text", signal),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  test("notifications separate AppleScript source from untrusted arguments", async () => {
    const spy = runner();
    const malicious = 'hi" & do shell script "touch /tmp/nope';
    expect(
      await createNotificationSink({ platform: "darwin", run: spy.run }).notify({
        title: malicious,
        body: "secret\u001b[2J",
        conversationId,
      }),
    ).toMatchObject({ ok: true });
    expect(spy.calls[0]?.argv.at(-2)).toBe(malicious);
    expect(spy.calls[0]?.argv[2]).not.toContain(malicious);
    expect(spy.calls[0]?.argv.at(-1)).not.toContain("\u001b");
  });
});

describe("effect platform branches", () => {
  const unavailable = {
    ok: false as const,
    error: { code: "unavailable" as const, message: "Missing", retryable: false },
  };
  test("macOS opens links with open and copies with pbcopy", async () => {
    const spy = runner();
    const external = createExternalActions({ platform: "darwin", run: spy.run });
    await external.openUrl("https://example.org/a%20b", signal);
    await external.copyText("hello", signal);
    expect(spy.calls.map((call) => call.argv)).toEqual([
      ["open", "https://example.org/a%20b"],
      ["pbcopy"],
    ]);
  });
  test.each([
    ["nope", "This link is not a valid URL."],
    ["https://", "This link is not a valid URL."],
    [
      `https://example.org/${"a".repeat(8_200)}`,
      "Use a valid http or https URL without control characters.",
    ],
  ])("rejects malformed link %#", async (url, message) => {
    const spy = runner();
    expect(
      await createExternalActions({ platform: "linux", run: spy.run }).openUrl(url, signal),
    ).toMatchObject({ ok: false, error: { code: "invalid-input", message } });
    expect(spy.calls).toHaveLength(0);
  });
  test("valid links on an unsupported platform report unsupported", async () => {
    const spy = runner();
    expect(
      await createExternalActions({ platform: "win32", run: spy.run }).openUrl(
        "https://example.org",
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(spy.calls).toHaveLength(0);
  });
  test.each([["a\u0000b"], ["x".repeat(1_048_577)]])("rejects uncopyable text %#", async (text) => {
    const spy = runner();
    expect(
      await createExternalActions({ platform: "linux", run: spy.run }).copyText(text, signal),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(spy.calls).toHaveLength(0);
  });
  test("copy stops at the first working Linux helper", async () => {
    const calls: string[] = [];
    const external = createExternalActions({
      platform: "linux",
      run: async ({ argv }) => {
        calls.push(argv[0]!);
        return argv[0] === "xclip" ? { ok: true, value: undefined } : unavailable;
      },
    });
    expect(await external.copyText("text", signal)).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual(["wl-copy", "xclip"]);
  });
  test("a cancellation during fallback is returned instead of trying more helpers", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const external = createExternalActions({
      platform: "linux",
      run: async ({ argv }) => {
        calls.push(argv[0]!);
        abort.abort();
        return { ok: false, error: { code: "cancelled", message: "Stopped", retryable: false } };
      },
    });
    expect(await external.copyText("text", abort.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(calls).toEqual(["wl-copy"]);
  });
  test("a signal aborted between helpers stops the fallback chain", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const external = createExternalActions({
      platform: "linux",
      run: async ({ argv }) => {
        calls.push(argv[0]!);
        abort.abort();
        return unavailable;
      },
    });
    expect(await external.copyText("text", abort.signal)).toMatchObject({
      error: { code: "cancelled" },
    });
    expect(calls).toEqual(["wl-copy"]);
  });
  test("Linux notifications pass sanitized, bounded text after an option terminator", async () => {
    const spy = runner();
    const sink = createNotificationSink({ platform: "linux", run: spy.run });
    expect(
      await sink.notify({ title: "--evil\u001b[2J\n", body: "b".repeat(5_000), conversationId }),
    ).toMatchObject({ ok: true });
    const argv = spy.calls[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(["notify-send", "--app-name=OpenIRC", "--"]);
    expect(argv[3]).toBe("--evil [2J ");
    expect(argv[4]).toHaveLength(1_024);
    await sink.notify({ title: "no body", conversationId });
    expect(spy.calls[1]!.argv.at(-1)).toBe("");
  });
  test("notifications are honestly unsupported elsewhere", async () => {
    const spy = runner();
    expect(
      await createNotificationSink({ platform: "win32", run: spy.run }).notify({
        title: "t",
        conversationId,
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(spy.calls).toHaveLength(0);
  });
});
