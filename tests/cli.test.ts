import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli";

describe("CLI paths and options", () => {
  it("uses user-scoped paths instead of discovering working-directory files", () => {
    const parsed = parseCli([], {}, "/home/test", "linux");
    expect(parsed).toEqual({
      ok: true,
      value: {
        mode: "run",
        configDirectory: "/home/test/.config/openirc",
        dataDirectory: "/home/test/.local/share/openirc",
      },
    });
  });
  it("honors absolute XDG variables and macOS data layout", () => {
    const parsed = parseCli(
      [],
      { XDG_CONFIG_HOME: "/custom/config", XDG_DATA_HOME: "relative-not-trusted" },
      "/home/test",
      "darwin",
    );
    expect(parsed.ok && parsed.value.configDirectory).toBe("/custom/config/openirc");
    expect(parsed.ok && parsed.value.dataDirectory).toBe(
      "/home/test/Library/Application Support/OpenIRC",
    );
  });
  it("supports help/validation and rejects unknown or missing options", () => {
    const parsed = parseCli(["--check-config", "--config-dir", "/tmp/openirc-config"]);
    expect(parsed.ok && parsed.value.mode).toBe("check-config");
    expect(parsed.ok && parsed.value.configDirectory).toBe("/tmp/openirc-config");
    expect(parseCli(["--unknown"]).ok).toBe(false);
    expect(parseCli(["--data-dir"]).ok).toBe(false);
  });
});
