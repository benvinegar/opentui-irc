import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.bun.test.ts"],
    environment: "node",
    // Node/Vitest only: Bun adapter and OpenTUI suites run under `bun run test:bun` and are not counted.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text", "html"],
    },
  },
});
