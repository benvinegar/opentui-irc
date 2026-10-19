import type { InputRenderable, Renderable } from "@opentui/core";
import {
  createContext,
  createEffect,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";

const dark = {
  bg: "#161821",
  panel: "#20232f",
  raised: "#2b3042",
  text: "#e4e8f2",
  muted: "#9ca8bf",
  accent: "#a8b7ff",
  error: "#ffb4b4",
  green: "#a6dfb3",
};
const light = {
  bg: "#f4f5fa",
  panel: "#e4e7f0",
  raised: "#d3d9e9",
  text: "#172039",
  muted: "#47536e",
  accent: "#3f45a8",
  error: "#9d2020",
  green: "#166138",
};
const contrast = {
  bg: "#000000",
  panel: "#000000",
  raised: "#292929",
  text: "#ffffff",
  muted: "#dddddd",
  accent: "#ffff00",
  error: "#ff9b9b",
  green: "#80ff80",
};
export const ThemeContext = createContext<Accessor<"dark" | "light" | "high-contrast">>(
  () => "dark" as const,
);
export function usePalette() {
  const theme = useContext(ThemeContext);
  const palette = () =>
    theme() === "light" ? light : theme() === "high-contrast" ? contrast : dark;
  return {
    get bg() {
      return palette().bg;
    },
    get panel() {
      return palette().panel;
    },
    get raised() {
      return palette().raised;
    },
    get text() {
      return palette().text;
    },
    get muted() {
      return palette().muted;
    },
    get accent() {
      return palette().accent;
    },
    get error() {
      return palette().error;
    },
    get green() {
      return palette().green;
    },
  };
}
export interface FocusManager {
  current: Accessor<string>;
  set(id: string): void;
  register(id: string, layer: string, control: Renderable): () => void;
}
export const FocusContext = createContext<FocusManager>();
export function useControl(id: string, layer: string) {
  const focus = useContext(FocusContext)!;
  return {
    focused: () => focus.current() === id,
    select: () => focus.set(id),
    ref(control: Renderable) {
      onCleanup(focus.register(id, layer, control));
    },
  };
}
export function Button(props: {
  id: string;
  layer?: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  width?: number;
}) {
  const colors = usePalette();
  const control = useControl(props.id, props.layer ?? "main");
  const press = () => {
    control.select();
    if (!props.disabled) props.onPress();
  };
  return (
    <box
      id={props.id}
      ref={control.ref}
      focusable
      focused={control.focused()}
      flexShrink={0}
      {...(props.width === undefined ? {} : { width: props.width })}
      height={1}
      paddingX={1}
      backgroundColor={control.focused() || props.active ? colors.raised : colors.panel}
      onMouseDown={press}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault();
          press();
        }
      }}
    >
      <text
        fg={
          props.disabled
            ? colors.muted
            : control.focused() || props.active
              ? colors.accent
              : colors.text
        }
      >
        {props.label}
      </text>
    </box>
  );
}
export function Field(props: {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}) {
  const colors = usePalette();
  const control = useControl(props.id, "modal");
  let input: InputRenderable | undefined;
  createEffect(() => {
    const value = props.value;
    if (input && input.value !== value) input.value = value;
  });
  return (
    <box flexDirection="column" height={2} flexShrink={0}>
      <text fg={colors.muted}>{props.label}</text>
      <input
        id={props.id}
        ref={(element) => {
          input = element;
          control.ref(element);
        }}
        value={props.value}
        focused={control.focused()}
        onMouseDown={control.select}
        onInput={props.onInput}
        placeholder={props.placeholder ?? ""}
        backgroundColor={colors.raised}
        focusedBackgroundColor={colors.bg}
        textColor={colors.text}
        maxLength={512}
      />
    </box>
  );
}
export function Dialog(props: {
  title: string;
  children: JSX.Element;
  onClose: () => void;
  width: number;
  height: number;
}) {
  const colors = usePalette();
  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, Math.floor((props.width - Math.min(76, props.width)) / 2))}
      width={Math.min(76, props.width)}
      height={Math.min(props.height - 2, 34)}
      backgroundColor={colors.panel}
      border
      borderColor={colors.accent}
      flexDirection="column"
      paddingX={2}
    >
      <box height={2} flexShrink={0} justifyContent="space-between" flexDirection="row">
        <text fg={colors.accent}>
          <b>{props.title}</b>
        </text>
        <Button id="dialog-close" layer="modal" label="Close [Esc]" onPress={props.onClose} />
      </box>
      <scrollbox
        id="modal-scroll"
        flexGrow={1}
        contentOptions={{ flexDirection: "column", gap: 1 }}
        scrollX={false}
      >
        {props.children}
      </scrollbox>
    </box>
  );
}
