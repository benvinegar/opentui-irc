// Compiles a standalone `dist/openirc` executable for the current platform. The Solid
// plugin replaces the bunfig.toml preload, which a compiled binary never reads.
import solidPlugin from "@opentui/solid/bun-plugin";

const outfile = "dist/openirc";
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  plugins: [solidPlugin],
  minify: true,
  compile: { outfile },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${outfile}`);
