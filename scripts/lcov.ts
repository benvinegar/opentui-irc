// Dependency-free LCOV parse/merge/summary used by scripts/coverage.ts.
import { isAbsolute, relative } from "node:path";

/** Bun's LCOV only carries per-file FNF/FNH totals and no branch data, so both are optional. */
export type FileCoverage = {
  path: string;
  lines: Map<number, number>;
  functions: Map<string, number>;
  functionTotals?: { found: number; hit: number };
  branches: Map<string, number>;
  /** V8 lists exactly the executable statements; Bun also lists case labels and continuation lines. */
  statementLines?: boolean;
};

export type Ratio = { covered: number; total: number };
export type FileSummary = { path: string; lines: Ratio; functions: Ratio; branches: Ratio };

export function normalizePath(path: string, root: string): string {
  const relativePath = isAbsolute(path) ? relative(root, path) : path;
  return relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function emptyFile(path: string): FileCoverage {
  return { path, lines: new Map(), functions: new Map(), branches: new Map() };
}

function count(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function maxInto<K>(map: Map<K, number>, key: K, hits: number): void {
  map.set(key, Math.max(map.get(key) ?? 0, hits));
}

/** Applies one LCOV line to the current record. Unknown tags are ignored. */
function applyLine(file: FileCoverage, tag: string, value: string): void {
  const parts = value.split(",");
  if (tag === "DA") maxInto(file.lines, Number(parts[0]), count(parts[1]));
  else if (tag === "FN") maxInto(file.functions, parts.at(-1) ?? "", 0);
  else if (tag === "FNDA") maxInto(file.functions, parts.slice(1).join(","), count(parts[0]));
  else if (tag === "BRDA") maxInto(file.branches, parts.slice(0, 3).join(","), count(parts[3]));
  else if (tag === "FNF")
    file.functionTotals = { found: count(value), hit: file.functionTotals?.hit ?? 0 };
  else if (tag === "FNH")
    file.functionTotals = { found: file.functionTotals?.found ?? 0, hit: count(value) };
}

export function parseLcov(
  text: string,
  root: string,
  options: { statementLines?: boolean } = {},
): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "end_of_record") {
      if (current) files.push(current);
      current = undefined;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const tag = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (tag === "SF")
      current = {
        ...emptyFile(normalizePath(value, root)),
        statementLines: options.statementLines === true,
      };
    else if (current) applyLine(current, tag, value);
  }
  return files;
}

function functionRatio(file: FileCoverage): Ratio {
  if (file.functions.size > 0) {
    const covered = [...file.functions.values()].filter((hits) => hits > 0).length;
    return { covered, total: file.functions.size };
  }
  return { covered: file.functionTotals?.hit ?? 0, total: file.functionTotals?.found ?? 0 };
}

function fraction(ratio: Ratio): number {
  return ratio.total === 0 ? 1 : ratio.covered / ratio.total;
}

/**
 * Unions records by path. Lines and branches take the max hit count per key; when one record
 * lists statement lines (V8), only those lines count, so Bun-only listings of non-statement lines
 * are not reported as uncovered. Per-function
 * names are only available from V8, so functions keep whichever record reports the higher
 * ratio (a lower bound of the true union).
 */
function executed(file: FileCoverage): boolean {
  return [...file.lines.values()].some((hits) => hits > 0);
}

export function mergeFiles(left: FileCoverage, right: FileCoverage): FileCoverage {
  const merged = emptyFile(left.path);
  const statements = [left, right].find((source) => source.statementLines && source.lines.size > 0);
  if (statements) merged.statementLines = true;
  for (const source of [left, right]) {
    for (const [line, hits] of source.lines)
      if (!statements || statements.lines.has(line)) maxInto(merged.lines, line, hits);
  }
  // Only V8 records branches. If V8 never ran a file that Bun did, its branches are unknown,
  // not uncovered, so leave them out rather than count them as zero.
  const unmeasured = [left, right].some((source) => !executed(source) && source.branches.size > 0);
  if (!(unmeasured && executed(left) !== executed(right)))
    for (const source of [left, right])
      for (const [key, hits] of source.branches) maxInto(merged.branches, key, hits);
  const best = fraction(functionRatio(right)) > fraction(functionRatio(left)) ? right : left;
  for (const [name, hits] of best.functions) merged.functions.set(name, hits);
  if (best.functionTotals) merged.functionTotals = best.functionTotals;
  return merged;
}

export function mergeReports(reports: readonly FileCoverage[][]): Map<string, FileCoverage> {
  const merged = new Map<string, FileCoverage>();
  for (const file of reports.flat()) {
    const existing = merged.get(file.path);
    merged.set(file.path, existing ? mergeFiles(existing, file) : file);
  }
  return merged;
}

function hitRatio(map: Map<unknown, number>): Ratio {
  const covered = [...map.values()].filter((hits) => hits > 0).length;
  return { covered, total: map.size };
}

export function summarize(file: FileCoverage): FileSummary {
  return {
    path: file.path,
    lines: hitRatio(file.lines),
    functions: functionRatio(file),
    branches: hitRatio(file.branches),
  };
}

export function total(summaries: readonly FileSummary[]): Omit<FileSummary, "path"> {
  const add = (pick: (summary: FileSummary) => Ratio): Ratio =>
    summaries.reduce(
      (sum, summary) => ({
        covered: sum.covered + pick(summary).covered,
        total: sum.total + pick(summary).total,
      }),
      { covered: 0, total: 0 },
    );
  return {
    lines: add((summary) => summary.lines),
    functions: add((summary) => summary.functions),
    branches: add((summary) => summary.branches),
  };
}

export function percent(ratio: Ratio): number {
  return fraction(ratio) * 100;
}
