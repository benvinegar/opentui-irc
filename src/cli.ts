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

const MODE_FLAGS = new Map<string, CliOptions["mode"]>([
  ["--help", "help"],
  ["-h", "help"],
  ["--version", "version"],
  ["-v", "version"],
  ["--check-config", "check-config"],
]);

function invalidOption(message: string): Result<never> {
  return { ok: false, error: { code: "invalid-input", message, retryable: false } };
}
/** Documented permissions named by a comma-separated list, in canonical order. */
function controlRights(value: string | undefined): ControlPermission[] | undefined {
  const rights = value?.split(",");
  if (
    !rights?.length ||
    rights.some((right) => !ALL_CONTROL_PERMISSIONS.some((allowed) => allowed === right))
  )
    return undefined;
  return ALL_CONTROL_PERMISSIONS.filter((right) => rights.includes(right));
}
function directoryOption(value: string | undefined): string | undefined {
  if (!value || value.startsWith("-") || value.includes("\0")) return undefined;
  return resolve(value);
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
      ? // Pre-rename directory name, kept so existing history is found.
        join(home, "Library", "Application Support", "OpenIRC")
      : join(xdg("XDG_DATA_HOME", join(home, ".local", "share")), "openirc");
  let mode: CliOptions["mode"] = "run";
  let controlEnabled = true;
  const controlPermissions = new Set<ControlPermission>(DEFAULT_CONTROL_PERMISSIONS);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const flagMode = MODE_FLAGS.get(argument);
    if (flagMode) mode = flagMode;
    else if (argument === "--no-control") controlEnabled = false;
    else if (argument === "--control-allow") {
      const rights = controlRights(args[++index]);
      if (!rights)
        return invalidOption("Use a comma-separated list of documented control permissions.");
      for (const right of rights) controlPermissions.add(right);
    } else if (argument === "--config-dir" || argument === "--data-dir") {
      const directory = directoryOption(args[++index]);
      if (directory === undefined) return invalidOption("Directory options require a path.");
      if (argument === "--config-dir") configDirectory = directory;
      else dataDirectory = directory;
    } else return invalidOption("Unknown option. Use --help for usage.");
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

export const HELP = `opentui-irc — a newcomer-friendly terminal IRC client

Usage: openirc [options]        (from a checkout: bun run start [options])

  --config-dir PATH   Directory for openirc.jsonc and tui.jsonc
  --data-dir PATH     Directory for the local history database
  --check-config      Validate configuration without connecting or opening the TUI
  --no-control        Disable live control (still reserves this profile against offline writes)
  --control-allow P   Grant extra local permissions: read-messages,send-messages,destructive
  -h, --help          Show this help
  -v, --version       Show version

Agent setup: openirc help (versioned JSON; no TUI needed), e.g. openirc config schema.
Start without options for the TUI. Local control defaults to inspect/configure/network only.
Closing opentui-irc disconnects; use an existing bouncer for offline collection.
Local history defaults to 30 days and can be disabled in Settings.
`;
