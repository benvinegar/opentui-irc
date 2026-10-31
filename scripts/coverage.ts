// Runs both suites once with coverage, merges their LCOV and enforces the floor.
//   bun run coverage            run Vitest + Bun tests, merge, print, check the floor
//   bun run coverage --report   merge existing coverage/{vitest,bun}/lcov.info only
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { exclusions, floor, include } from "./coverage-config";
import {
  mergeReports,
  parseLcov,
  percent,
  summarize,
  total,
  type FileSummary,
  type Ratio,
} from "./lcov";

const root = resolve(import.meta.dirname, "..");
const vitestDirectory = "coverage/vitest";
const bunDirectory = "coverage/bun";
const metrics = ["lines", "functions", "branches"] as const;

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}

async function runSuites(): Promise<void> {
  await rm(resolve(root, vitestDirectory), { recursive: true, force: true });
  await rm(resolve(root, bunDirectory), { recursive: true, force: true });
  await run([
    "test",
    "--coverage",
    "--coverage.reporter=lcovonly",
    `--coverage.reportsDirectory=${vitestDirectory}`,
  ]);
  await run([
    "test:bun",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${bunDirectory}`,
  ]);
}

function counted(path: string): boolean {
  return include.test(path) && !exclusions.some(({ pattern }) => pattern.test(path));
}

function cell(ratio: Ratio): string {
  return `${percent(ratio).toFixed(1).padStart(6)}% ${`${ratio.covered}/${ratio.total}`.padStart(9)}`;
}

function row(name: string, summary: Omit<FileSummary, "path">): string {
  return `${name.padEnd(42)} ${metrics.map((metric) => cell(summary[metric])).join("  ")}`;
}

function print(summaries: FileSummary[], totals: Omit<FileSummary, "path">): void {
  console.log(
    `\n${"File (lowest line coverage first)".padEnd(42)} ${"lines".padEnd(17)}  ${"functions".padEnd(17)}  branches*`,
  );
  for (const summary of summaries) console.log(row(summary.path, summary));
  console.log(row("All counted files", totals));
  console.log(
    "* branches are Vitest-only (Bun LCOV has none); files only Bun runs show 0/0. Lines count V8 statements. Functions take the better suite per file.",
  );
  console.log(
    `Excluded: ${exclusions.map(({ pattern, reason }) => `${pattern.source} (${reason})`).join("; ")}`,
  );
}

function checkFloor(totals: Omit<FileSummary, "path">): boolean {
  let ok = true;
  for (const metric of metrics) {
    const value = percent(totals[metric]);
    if (value < floor[metric]) {
      console.error(
        `Coverage ${metric} ${value.toFixed(2)}% is below the floor of ${floor[metric]}%.`,
      );
      ok = false;
    } else if (Math.floor(value) > floor[metric]) {
      console.log(
        `Coverage ${metric} is ${value.toFixed(2)}%; raise the floor in scripts/coverage-config.ts to ${Math.floor(value)}.`,
      );
    }
  }
  return ok;
}

if (!process.argv.includes("--report")) await runSuites();
const reports = await Promise.all(
  [vitestDirectory, bunDirectory].map(async (directory) =>
    parseLcov(await readFile(resolve(root, directory, "lcov.info"), "utf8"), root, {
      statementLines: directory === vitestDirectory,
    }),
  ),
);
const summaries = [...mergeReports(reports).values()]
  .filter((file) => counted(file.path))
  .map(summarize)
  .sort(
    (left, right) =>
      percent(left.lines) - percent(right.lines) || left.path.localeCompare(right.path),
  );
const totals = total(summaries);
print(summaries, totals);
if (!checkFloor(totals)) process.exitCode = 1;
