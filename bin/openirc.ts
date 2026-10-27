#!/usr/bin/env bun
// Installed entry point (`bun link`). bunfig.toml preloads only apply inside the project
// directory, so register the Solid JSX transform before loading the app.
import "@opentui/solid/preload";

const { main } = await import("../src/main");
process.exitCode = await main();
