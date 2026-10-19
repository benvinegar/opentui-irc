import { join } from "node:path";
import { createApp } from "./app/create-app";
import { randomIds, systemClock } from "./app/platform-independent-runtime";
import type { AppApi } from "./contracts/app";
import { createSessionFactory } from "./irc/session";
import { createBunTransport } from "./transport/bun";
import { createHistoryRepository } from "./storage/history";
import { createSettingsRepository } from "./storage/settings";
import { createSecretProvider } from "./storage/secrets";
import { createCommandService } from "./services/commands";
import { createExternalActions, createNotificationSink } from "./services/effects";
import { plainText } from "./domain/message-policy";
import { HELP, parseCli } from "./cli";

/** The only production composition root. Adapters are wired explicitly, never via globals. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(args);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 1;
  }
  const options = parsed.value;
  if (options.mode === "help") {
    console.log(HELP);
    return 0;
  }
  if (options.mode === "version") {
    const metadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version: string;
    };
    console.log(`OpenIRC ${metadata.version}`);
    return 0;
  }
  if (process.platform !== "linux" && process.platform !== "darwin") {
    console.error("OpenIRC currently supports Linux and macOS.");
    return 1;
  }
  const root = new AbortController();
  const settings = createSettingsRepository(options.configDirectory);
  if (options.mode === "check-config") {
    const result = await settings.load(root.signal);
    if (!result.ok) {
      console.error(plainText(result.error.message));
      return 1;
    }
    console.log(`Configuration is valid (${result.value.user.networks.length} networks).`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "OpenIRC needs an interactive terminal. Use --help or --check-config for non-interactive commands.",
    );
    return 1;
  }
  let app: AppApi | undefined;
  let ui: { destroy(): void; readonly done?: Promise<void> } | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let exitCode = 0;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      root.abort();
      let failure: string | undefined;
      try {
        const result = await app?.shutdown();
        if (result && !result.ok) failure = result.error.message;
      } catch {
        failure = "OpenIRC could not flush all local state.";
      }
      ui?.destroy();
      if (ui?.done) await ui.done;
      if (failure) {
        console.error(plainText(failure));
        exitCode = 1;
      }
      finished();
    })();
    return stopPromise;
  };
  const onSignal = () => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const opened = await createHistoryRepository(join(options.dataDirectory, "history.sqlite"));
    if (!opened.ok) {
      console.error(plainText(opened.error.message));
      return 1;
    }
    const secrets = createSecretProvider();
    const created = await createApp(
      {
        clock: systemClock,
        ids: randomIds,
        diagnostics: {
          record() {
            /* Opt-in diagnostic logging can be added without leaking user bodies. */
          },
        },
        sessions: createSessionFactory({
          transport: createBunTransport(),
          secrets,
          clock: systemClock,
        }),
        history: opened.value,
        settings,
        secrets,
        notifications: createNotificationSink(),
      },
      root.signal,
    );
    if (!created.ok) {
      console.error(plainText(created.error.message));
      return 1;
    }
    app = created.value;
    if (stopping) {
      await app.shutdown();
      return exitCode;
    }
    const { startUi } = await import("./ui/start");
    ui = await startUi({
      app,
      commands: createCommandService(app),
      external: createExternalActions(),
      onQuit: stop,
    });
    if (stopping) {
      ui.destroy();
      if (ui.done) await ui.done;
    } else if (ui.done) void ui.done.then(stop);
    await done;
    return exitCode;
  } catch {
    await stop();
    console.error(
      "OpenIRC could not start the terminal interface. Check your terminal and configuration.",
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (import.meta.main) process.exitCode = await main();
