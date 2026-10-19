import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Result } from "./contracts/common";

export interface CliOptions {
  readonly mode: "run" | "help" | "version" | "check-config";
  readonly configDirectory: string;
  readonly dataDirectory: string;
}

export function parseCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
  platform = process.platform,
): Result<CliOptions> {
  const xdg = (name: string, fallback: string) =>
    environment[name] && isAbsolute(environment[name]!) ? environment[name]! : fallback;
  let configDirectory = join(xdg("XDG_CONFIG_HOME", join(home, ".config")), "openirc");
  let dataDirectory =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "OpenIRC")
      : join(xdg("XDG_DATA_HOME", join(home, ".local", "share")), "openirc");
  let mode: CliOptions["mode"] = "run";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") mode = "help";
    else if (argument === "--version" || argument === "-v") mode = "version";
    else if (argument === "--check-config") mode = "check-config";
    else if (argument === "--config-dir" || argument === "--data-dir") {
      const value = args[++index];
      if (!value || value.startsWith("-") || value.includes("\0"))
        return {
          ok: false,
          error: {
            code: "invalid-input",
            message: "Directory options require a path.",
            retryable: false,
          },
        };
      if (argument === "--config-dir") configDirectory = resolve(value);
      else dataDirectory = resolve(value);
    } else
      return {
        ok: false,
        error: {
          code: "invalid-input",
          message: "Unknown option. Use --help for usage.",
          retryable: false,
        },
      };
  }
  return { ok: true, value: { mode, configDirectory, dataDirectory } };
}

export const HELP = `OpenIRC — a newcomer-friendly terminal IRC client

Usage: bun run start [options]

  --config-dir PATH   Directory for openirc.jsonc and tui.jsonc
  --data-dir PATH     Directory for the local history database
  --check-config      Validate configuration without connecting or opening the TUI
  -h, --help          Show this help
  -v, --version       Show version

Start without options, then use Settings to add a network.
Closing OpenIRC disconnects; use an existing bouncer for offline collection.
Local history defaults to 30 days and can be disabled in Settings.
`;
