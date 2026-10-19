import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { OpenIrc, type UiOptions } from "./app";

export type { UiOptions } from "./app";

export interface UiHandle {
  /** Resolves after renderer cleanup and terminal restoration, not app shutdown. */
  readonly done: Promise<void>;
  destroy(): void;
}

/** Production renderer: main owns signals, app shutdown, and this renderer's destruction. */
export async function startUi(options: UiOptions): Promise<UiHandle> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: options.app.settings.getSnapshot()?.tui.mouse ?? true,
  });
  try {
    await render(() => <OpenIrc {...options} />, renderer);
    return { done: renderer.closed, destroy: () => renderer.destroy() };
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}
