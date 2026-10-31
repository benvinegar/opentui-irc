// Scope and ratchet for `bun run coverage` (scripts/coverage.ts).

/** Counted files: production TypeScript under src/. */
export const include = /^src\/.+\.ts$/u;

/**
 * Not counted. `.tsx` is excluded as a whole because Bun reports UI coverage against the
 * Solid-transformed output (line numbers past the end of the source), not the original file.
 */
export const exclusions: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\.tsx$/u, reason: "Bun coverage for Solid JSX is not source-mapped" },
  {
    pattern: /^src\/main\.ts$/u,
    reason: "composition root; exercised end-to-end by test:terminal",
  },
  { pattern: /^src\/ctl\.ts$/u, reason: "headless entrypoint; tests spawn it as a subprocess" },
];

/**
 * Ratchet: merged totals rounded down to the integer. Raise these when coverage rises; lower
 * them only with a reviewed reason. Branches come from Vitest alone (Bun emits no branch data).
 */
export const floor = { lines: 90, functions: 95, branches: 77 };
