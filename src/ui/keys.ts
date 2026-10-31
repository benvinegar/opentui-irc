/** The parts of an OpenTUI key event that bindings inspect. */
export interface KeyPress {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  preventDefault(): void;
}

export interface KeyBinding {
  /** Key names that trigger the binding. */
  readonly name: readonly string[];
  /** Required modifiers; modifiers a binding does not list are not checked. */
  readonly ctrl?: true;
  readonly meta?: true;
  /** Extra condition; when it fails, later bindings may still match. */
  readonly when?: () => boolean;
  readonly run: (event: KeyPress) => void;
}

const matches = (event: KeyPress, binding: KeyBinding) =>
  binding.name.includes(event.name) &&
  (!binding.ctrl || event.ctrl) &&
  (!binding.meta || event.meta) &&
  (binding.when?.() ?? true);

/** Runs the first matching binding, in table order, and consumes its key. */
export function runKeyBinding(event: KeyPress, bindings: readonly KeyBinding[]): boolean {
  const binding = bindings.find((candidate) => matches(event, candidate));
  if (!binding) return false;
  event.preventDefault();
  binding.run(event);
  return true;
}

/** -1 for keys that move backward (up/left/pageup), otherwise 1. */
export const keyStep = (name: string): -1 | 1 =>
  name === "up" || name === "left" || name === "pageup" ? -1 : 1;
