import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Result } from "./contracts/common";
import { ALL_CONTROL_PERMISSIONS, DEFAULT_CONTROL_PERMISSIONS } from "./contracts/control";
import type { ControlPermission } from "./contracts/control";

export interface CliOptions {
  readonly mode: "run" | "help" | "version" | "check-config";
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly controlEnabled: boolean;
  readonly controlPermissions: readonly ControlPermission[];
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
  let controlEnabled = true;
  const controlPermissions = new Set<ControlPermission>(DEFAULT_CONTROL_PERMISSIONS);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") mode = "help";
    else if (argument === "--version" || argument === "-v") mode = "version";
    else if (argument === "--check-config") mode = "check-config";
    else if (argument === "--no-control") controlEnabled = false;
    else if (argument === "--control-allow") {
      const rights = args[++index]?.split(",");
      if (
        !rights?.length ||
        rights.some((right) => !ALL_CONTROL_PERMISSIONS.some((allowed) => allowed === right))
      )
        return {
          ok: false,
          error: {
            code: "invalid-input",
            message: "Use a comma-separated list of documented control permissions.",
            retryable: false,
          },
        };
      for (const right of ALL_CONTROL_PERMISSIONS)
        if (rights.includes(right)) controlPermissions.add(right);
    } else if (argument === "--config-dir" || argument === "--data-dir") {
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
  return {
    ok: true,
    value: {
      mode,
      configDirectory,
      dataDirectory,
      controlEnabled,
      controlPermissions: [...controlPermissions],
    },
  };
}

export const HELP = `OpenIRC — a newcomer-friendly terminal IRC client

Usage: bun run start [options]

  --config-dir PATH   Directory for openirc.jsonc and tui.jsonc
  --data-dir PATH     Directory for the local history database
  --check-config      Validate configuration without connecting or opening the TUI
  --no-control        Disable live control (still reserves this profile against offline writes)
  --control-allow P   Grant extra local permissions: read-messages,send-messages,destructive
  -h, --help          Show this help
  -v, --version       Show version

Agent setup: bun run ctl --help (versioned JSON; no TUI needed).
Control commands also work through this entrypoint: bun run start config schema.
Start without options for the TUI. Local control defaults to inspect/configure/network only.
Closing OpenIRC disconnects; use an existing bouncer for offline collection.
Local history defaults to 30 days and can be disabled in Settings.
`;
