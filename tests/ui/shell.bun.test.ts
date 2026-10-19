// Bun does not apply top-level bunfig preload to its test runner. Register the
// actual Solid compiler before dynamically loading any TSX or framework modules.
// Keeping this wrapper JSX-free also makes plain `bun test` work without flags.
import "@opentui/solid/preload";
await import("./shell-suite");
