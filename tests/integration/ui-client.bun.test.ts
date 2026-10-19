// Bun test does not load application preloads automatically. Compile JSX before importing it.
import "@opentui/solid/preload";
await import("./ui-client-suite");
