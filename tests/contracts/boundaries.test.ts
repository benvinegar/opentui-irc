import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const source = resolve(import.meta.dirname, "../../src");
const layers: Readonly<
  Record<string, { readonly local: readonly string[]; readonly external: readonly string[] }>
> = {
  contracts: { local: ["contracts"], external: [] },
  domain: { local: ["domain", "contracts"], external: [] },
  app: { local: ["app", "domain", "contracts"], external: [] },
  irc: { local: ["irc", "domain", "contracts"], external: [] },
  transport: { local: ["transport", "contracts"], external: ["bun", "bun:", "node:"] },
  storage: { local: ["storage", "contracts"], external: ["bun", "bun:", "node:", "jsonc-parser"] },
  services: { local: ["services", "domain", "contracts"], external: ["node:"] },
  ui: { local: ["ui", "contracts"], external: ["solid-js", "@opentui/"] },
};

/** Lightweight literal-import guard, not a security sandbox or full dependency analyzer. */
it("keeps implementation imports inside their assigned architectural layer", () => {
  const violations: string[] = [];
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue;
    const file = resolve(entry.parentPath, entry.name);
    const path = relative(source, file);
    const layer = path.split("/")[0]!;
    const policy = layers[layer];
    // Composition root files deliberately wire all adapters.
    if (!policy) continue;
    const text = readFileSync(file, "utf8");
    const imports = text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/gu,
    );
    for (const match of imports) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = relative(source, resolve(dirname(file), specifier)).split("/")[0]!;
        if (!policy.local.includes(target)) violations.push(`${path} -> ${specifier}`);
      } else if (
        !policy.external.some(
          (prefix) =>
            specifier === prefix ||
            (prefix.endsWith(":") || prefix.endsWith("/")
              ? specifier.startsWith(prefix)
              : specifier.startsWith(`${prefix}/`)),
        )
      ) {
        violations.push(`${path} -> ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
