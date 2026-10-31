// Compiles a standalone `dist/openirc` executable for the current platform. The Solid
// plugin replaces the bunfig.toml preload. Autoloading is off so the binary ignores any
// bunfig.toml or .env in the directory it is launched from (this repo's bunfig.toml
// preload would otherwise break it). Builds are native only: OpenTUI embeds the
// platform's @opentui/core-<os>-<arch> library, which bun installs for the host alone.
import solidPlugin from "@opentui/solid/bun-plugin";

const outfile = "dist/openirc";
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  plugins: [solidPlugin],
  minify: true,
  compile: { outfile, autoloadBunfig: false, autoloadDotenv: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${outfile}`);
