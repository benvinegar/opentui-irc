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
