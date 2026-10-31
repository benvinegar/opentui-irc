import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.bun.test.ts"],
    environment: "node",
    // Vitest-only report for `vitest run --coverage`. `bun run coverage` overrides the reporter
    // with LCOV and merges it with the Bun suites (scripts/coverage.ts).
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text", "html"],
    },
  },
});
