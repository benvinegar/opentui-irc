import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../tests");
const entries = await readdir(directory, { recursive: true });
const files = entries
  .filter((path) => /\.bun\.test\.tsx?$/u.test(path))
  .sort()
  .map((path) => resolve(directory, path));
if (files.length === 0) {
  console.log("No Bun integration tests yet.");
} else {
  const child = Bun.spawn([process.execPath, "test", ...files], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
