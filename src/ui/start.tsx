import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { OpenIrc, type UiOptions } from "./app";

export type { UiOptions } from "./app";

/** Production renderer: receives the real facade; no fake data or adapter construction. */
export async function startUi(options: UiOptions): Promise<{ destroy(): void }> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: options.app.settings.getSnapshot()?.tui.mouse ?? true,
  });
  try {
    await render(() => <OpenIrc {...options} />, renderer);
    return { destroy: () => renderer.destroy() };
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}
