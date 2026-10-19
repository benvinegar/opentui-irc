import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dirname, "../../src/main.ts");
const run = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

describe("production CLI", () => {
  test("help/version do not need a TTY", async () => {
    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("OpenIRC");
    const version = await run("--version");
    expect(version.code).toBe(0);
    expect(version.stdout).toContain("0.0.0");
  });
  test("validates config without opening history/network and reports malformed input safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openirc-cli-"));
    try {
      const valid = await run("--check-config", "--config-dir", directory);
      expect(valid.code).toBe(0);
      expect(valid.stdout).toContain("0 networks");
      await writeFile(join(directory, "openirc.jsonc"), '{"password":"sensitive-do-not-log"}');
      const invalid = await run("--check-config", "--config-dir", directory);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).not.toContain("sensitive-do-not-log");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("rejects non-interactive UI startup with an actionable message", async () => {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("interactive terminal");
  });
});
