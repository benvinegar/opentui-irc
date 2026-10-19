import { parseCli } from "./cli";
import { runControlCli } from "./control/cli";
import { createControlExecutor } from "./control/execute";
import { createSecretProvider } from "./storage/secrets";

/** Headless entrypoint. Does not create an IRC app, history repository, or renderer. */
export async function controlMain(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const defaults = parseCli([]);
  if (!defaults.ok) {
    console.log(JSON.stringify({ version: 1, id: "cli", ok: false, error: defaults.error }));
    return 1;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await runControlCli(args, {
      execute: createControlExecutor({
        configDirectory: defaults.value.configDirectory,
        secrets: createSecretProvider(),
      }),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (import.meta.main) process.exitCode = await controlMain();
