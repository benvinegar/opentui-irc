/* oxlint-disable no-control-regex -- Control characters must be rejected before OS effects. */
import type { AppError, Result } from "../contracts/common";
import type { ExternalActions, NotificationSink } from "../contracts/services";

export interface EffectRequest {
  readonly argv: readonly string[];
  readonly input?: string;
  readonly signal: AbortSignal;
}
export interface EffectOptions {
  readonly platform?: string;
  /** Inject for tests or another OS. Arguments are never interpreted by a shell. */
  readonly run?: (request: EffectRequest) => Promise<Result<void>>;
}
const fail = (code: AppError["code"], message: string): Result<void> => ({
  ok: false,
  error: { code, message, retryable: false },
});
const cancelled = () => fail("cancelled", "Action cancelled.");

/** Bun-only default; importing this module in Node is safe when a runner is injected. */
async function runProcess({ argv, input, signal }: EffectRequest): Promise<Result<void>> {
  if (signal.aborted) return cancelled();
  try {
    const child = Bun.spawn([...argv], {
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "ignore",
      stderr: "ignore",
    });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 5_000);
    try {
      const code = await child.exited;
      if (signal.aborted) return cancelled();
      return code === 0
        ? { ok: true, value: undefined }
        : fail(
            "unavailable",
            "The desktop action failed. Check your desktop session or use terminal selection to copy.",
          );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  } catch {
    return signal.aborted
      ? cancelled()
      : fail(
          "unavailable",
          "The desktop helper is unavailable. Use terminal selection to copy, or open the link manually.",
        );
  }
}

export function createExternalActions(options: EffectOptions = {}): ExternalActions {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProcess;
  return {
    async openUrl(value, signal) {
      if (signal.aborted) return cancelled();
      if (value.length > 8_192 || /[\u0000-\u0020\u007f-\u009f]/u.test(value))
        return fail("invalid-input", "Use a valid http or https URL without control characters.");
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return fail("invalid-input", "This link is not a valid URL.");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        return fail(
          "invalid-input",
          "Only http and https links without embedded credentials can be opened.",
        );
      if (platform !== "linux" && platform !== "darwin")
        return fail("unsupported", "Opening links is not supported on this platform.");
      return run({
        argv: platform === "darwin" ? ["open", url.href] : ["xdg-open", url.href],
        signal,
      });
    },
    async copyText(text, signal) {
      if (signal.aborted) return cancelled();
      if (text.length > 1_048_576 || text.includes("\u0000"))
        return fail("invalid-input", "The selection is too large or contains NUL characters.");
      const commands =
        platform === "darwin"
          ? [["pbcopy"]]
          : platform === "linux"
            ? [
                ["wl-copy"],
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
              ]
            : [];
      if (!commands.length)
        return fail(
          "unsupported",
          "Clipboard integration is unavailable. Select text in your terminal and use its Copy action.",
        );
      for (const argv of commands) {
        if (signal.aborted) return cancelled();
        const result = await run({ argv, input: text, signal });
        if (result.ok || result.error.code === "cancelled") return result;
      }
      return fail(
        "unavailable",
        "Clipboard unavailable. Select the text in your terminal and use its Copy action.",
      );
    },
  };
}

const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 1_024);
export function createNotificationSink(options: EffectOptions = {}): NotificationSink {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProcess;
  return {
    async notify(notification) {
      const title = safe(notification.title);
      const body = safe(notification.body ?? "");
      const signal = new AbortController().signal;
      if (platform === "linux")
        return run({ argv: ["notify-send", "--app-name=OpenIRC", "--", title, body], signal });
      if (platform === "darwin")
        return run({
          argv: [
            "osascript",
            "-e",
            "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
            "--",
            title,
            body,
          ],
          signal,
        });
      return fail("unsupported", "Desktop notifications are unavailable on this platform.");
    },
  };
}
