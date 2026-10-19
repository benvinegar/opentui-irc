import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Keep the parent's pipe open: EOF must not be what releases the cancelled CLI.
test.each([
  { args: ["secrets", "store", "--stdin"], signal: "SIGTERM" },
  { args: ["config", "apply", "--stdin"], signal: "SIGTERM" },
  { args: ["secrets", "store", "--stdin"], signal: "SIGINT" },
])("ctl exits with one cancelled envelope while stdin has no EOF: %j", async ({ args, signal }) => {
  const directory = await mkdtemp(join(tmpdir(), "openirc-cli-cancel-"));
  const entrypoint = resolve(import.meta.dirname, "../../src/ctl.ts");
  const script = `
    import { controlMain } from ${JSON.stringify(entrypoint)};
    const task = controlMain(${JSON.stringify([...args, "--config-dir", directory])});
    process.stderr.write("ready\\n");
    process.exitCode = await task;
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const ready = child.stderr.getReader();
    const chunk = await ready.read();
    expect(new TextDecoder().decode(chunk.value)).toContain("ready");
    child.stdin.write("private-partial-input-without-newline");
    await child.stdin.flush();
    child.kill(signal);
    const code = await child.exited;
    expect(code).toBe(1);
    const stdout = await new Response(child.stdout).text();
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const response: unknown = JSON.parse(lines[0]!);
    expect(response).toMatchObject({ version: 1, ok: false, error: { code: "cancelled" } });
    expect(stdout).not.toContain("private");
    expect((await ready.read()).done).toBe(true);
    ready.releaseLock();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    clearTimeout(watchdog);
    child.stdin.end();
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
