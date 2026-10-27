import { join } from "node:path";
// Bundled at build time so a compiled binary does not need package.json on disk.
import packageMetadata from "../package.json" with { type: "json" };
import { createApp } from "./app/create-app";
import { randomIds, systemClock } from "./app/platform-independent-runtime";
import type { AppApi } from "./contracts/app";
import type { Result } from "./contracts/common";
import type { ControlError, ControlHandler, ControlServer } from "./contracts/control";
import { createControlServer, acquireControlLease } from "./control/socket";
import type { ControlLease } from "./control/socket";
import { createControlService } from "./control/service";
import { createSessionFactory } from "./irc/session";
import { createBunTransport } from "./transport/bun";
import { createHistoryRepository } from "./storage/history";
import { createSettingsRepository } from "./storage/settings";
import { createSecretProvider } from "./storage/secrets";
import { createCommandService } from "./services/commands";
import { createExternalActions, createNotificationSink } from "./services/effects";
import { plainText } from "./domain/message-policy";
import { HELP, parseCli } from "./cli";

const CONTROL_COMMANDS = new Set([
  "config",
  "networks",
  "channels",
  "conversations",
  "operations",
  "history",
  "timeline",
  "discovery",
  "action",
  "secrets",
  "status",
  "capabilities",
  "help",
  "shutdown",
]);
function isControlInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (["--config-dir", "--data-dir", "--control-allow"].includes(argument)) {
      index++;
      continue;
    }
    if (!argument.startsWith("-")) return CONTROL_COMMANDS.has(argument);
  }
  return false;
}

/** Production composition root; the control lease is acquired before any auto-connect or DB work. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (isControlInvocation(args)) {
    const { controlMain } = await import("./ctl");
    return controlMain(args);
  }
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
    console.log(`OpenIRC ${packageMetadata.version}`);
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
  let ui: { destroy(): void; readonly done: Promise<void> } | undefined;
  let server: ControlServer | undefined;
  let lease: ControlLease | undefined;
  let handler: ControlHandler | undefined;
  let startup: Promise<Result<AppApi, ControlError>> | undefined;
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
        const initialized = startup ? await startup.catch(() => undefined) : undefined;
        const owned = app ?? (initialized?.ok ? initialized.value : undefined);
        const result = await owned?.shutdown();
        if (result && !result.ok) failure = result.error.message;
      } catch {
        failure = "OpenIRC could not flush all local state.";
      }
      // Never release the profile while the app is still flushing or initializing.
      await server?.close();
      await lease?.release();
      ui?.destroy();
      if (ui) await ui.done;
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
    startup = (async (): Promise<Result<AppApi, ControlError>> => {
      if (options.controlEnabled) {
        const started = await createControlServer({
          configDirectory: options.configDirectory,
          handler: (request, signal) =>
            handler && !stopping
              ? handler(request, signal)
              : Promise.resolve({
                  version: 1,
                  id: request.id,
                  ok: false,
                  error: {
                    code: "unavailable",
                    message: "OpenIRC is initializing or shutting down. Retry inspection shortly.",
                    retryable: true,
                  },
                }),
          afterResponse(request, response) {
            if (request.method === "app.shutdown" && response.ok) void stop();
          },
        });
        if (!started.ok) return started;
        server = started.value;
      } else {
        const acquired = await acquireControlLease(options.configDirectory, root.signal);
        if (!acquired.ok) return acquired;
        lease = acquired.value;
      }
      if (stopping || root.signal.aborted)
        return {
          ok: false,
          error: { code: "cancelled", message: "Startup cancelled.", retryable: false },
        };
      const opened = await createHistoryRepository(join(options.dataDirectory, "history.sqlite"));
      if (!opened.ok) return opened;
      const secrets = createSecretProvider();
      const created = await createApp(
        {
          clock: systemClock,
          ids: randomIds,
          diagnostics: {
            record() {
              /* No user bodies or raw protocol logging. */
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
      if (created.ok)
        handler = createControlService({
          app: created.value,
          settings,
          secrets,
          permissions: options.controlPermissions,
        });
      return created;
    })();
    const created = await startup;
    if (!created.ok) {
      if (!stopping) console.error(plainText(created.error.message));
      return stopping ? exitCode : 1;
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
      await ui.done;
    } else void ui.done.then(stop);
    await done;
    return exitCode;
  } catch {
    await stop();
    console.error(
      "OpenIRC could not start the terminal interface. Check your terminal and configuration.",
    );
    return 1;
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (import.meta.main) process.exitCode = await main();
