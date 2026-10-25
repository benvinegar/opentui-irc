import type { InputRenderable, Renderable } from "@opentui/core";
import {
  createContext,
  createEffect,
  For,
  Show,
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
  yellow: "#e8d29a",
  border: "#30354a",
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
  yellow: "#7a5a00",
  border: "#c3c9da",
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
  yellow: "#ffd75f",
  border: "#bbbbbb",
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
    get yellow() {
      return palette().yellow;
    },
    get border() {
      return palette().border;
    },
  };
}
export interface FocusManager {
  current: Accessor<string>;
  active(layer: string): boolean;
  set(id: string): void;
  register(id: string, layer: string, control: Renderable): () => void;
}
export const FocusContext = createContext<FocusManager>();
export function useControl(id: string, layer: string) {
  const focus = useContext(FocusContext)!;
  return {
    active: () => focus.active(layer),
    focused: () => focus.active(layer) && focus.current() === id,
    select: () => {
      if (focus.active(layer)) focus.set(id);
    },
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
  /** Text-only affordance without a filled background. */
  quiet?: boolean;
}) {
  const colors = usePalette();
  const control = useControl(props.id, props.layer ?? "main");
  const press = () => {
    if (!control.active()) return;
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
      backgroundColor={
        control.focused() || props.active
          ? colors.raised
          : props.quiet
            ? "transparent"
            : colors.panel
      }
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
              : props.quiet
                ? colors.muted
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
  onSubmit?: () => void;
  /** The placeholder alone explains the input (quick pickers). */
  hideLabel?: boolean;
}) {
  const colors = usePalette();
  const control = useControl(props.id, "modal");
  let input: InputRenderable | undefined;
  createEffect(() => {
    const value = props.value;
    if (input && input.value !== value) input.value = value;
  });
  return (
    <box flexDirection="column" height={props.hideLabel ? 1 : 2} flexShrink={0}>
      <Show when={!props.hideLabel}>
        <text fg={colors.muted}>{props.label}</text>
      </Show>
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
        onSubmit={() => props.onSubmit?.()}
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
  /** Narrow, top-anchored dialogs read as a quick picker rather than a form. */
  compact?: boolean;
}) {
  const colors = usePalette();
  const width = () => Math.min(props.compact ? 64 : 76, props.width - 2);
  const height = () => Math.min(props.height - 4, props.compact ? 20 : 34);
  return (
    <box
      id="modal-backdrop"
      position="absolute"
      top={0}
      left={0}
      width={props.width}
      height={props.height}
      backgroundColor={`${colors.bg}aa`}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseScroll={(event) => event.stopPropagation()}
    >
      <box
        position="absolute"
        top={Math.max(1, Math.floor(props.height / 8))}
        left={Math.max(0, Math.floor((props.width - width()) / 2))}
        width={width()}
        height={height()}
        backgroundColor={colors.panel}
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title={` ${props.title} `}
        flexDirection="column"
        paddingX={1}
      >
        <box height={1} flexShrink={0} justifyContent="flex-end" flexDirection="row">
          <Button id="dialog-close" layer="modal" label="esc" quiet onPress={props.onClose} />
        </box>
        <scrollbox
          id="modal-scroll"
          flexGrow={1}
          contentOptions={{ flexDirection: "column", gap: 1, paddingX: 1 }}
          scrollX={false}
        >
          {props.children}
        </scrollbox>
      </box>
    </box>
  );
}
/** A navigable row: sidebar conversations and palette entries. */
export function ListItem(props: {
  id: string;
  layer?: string;
  label: string;
  prefix?: string;
  prefixColor?: string;
  badge?: string;
  hint?: string;
  strong?: boolean;
  alert?: boolean;
  dim?: boolean;
  active?: boolean;
  onPress: () => void;
}) {
  const colors = usePalette();
  const control = useControl(props.id, props.layer ?? "main");
  const press = () => {
    if (!control.active()) return;
    control.select();
    props.onPress();
  };
  const lit = () => control.focused() || props.active;
  return (
    <box
      id={props.id}
      ref={control.ref}
      focusable
      focused={control.focused()}
      flexShrink={0}
      height={1}
      paddingX={1}
      flexDirection="row"
      backgroundColor={lit() ? colors.raised : "transparent"}
      onMouseDown={press}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault();
          press();
        }
      }}
    >
      <Show when={props.prefix !== undefined}>
        <text
          width={2}
          flexShrink={0}
          fg={props.prefixColor ?? (lit() ? colors.accent : colors.muted)}
        >
          {props.prefix}
        </text>
      </Show>
      <text
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        height={1}
        wrapMode="none"
        fg={
          lit()
            ? colors.accent
            : props.dim
              ? colors.muted
              : props.strong || props.alert
                ? colors.text
                : colors.muted
        }
      >
        {props.strong || props.alert || props.active ? <b>{props.label}</b> : props.label}
      </text>
      <Show when={props.badge}>
        <text
          flexShrink={0}
          fg={props.alert ? colors.bg : colors.muted}
          {...(props.alert ? { bg: colors.accent } : {})}
        >
          {props.alert ? ` ${props.badge} ` : ` ${props.badge}`}
        </text>
      </Show>
      <Show when={props.hint}>
        <text flexShrink={0} fg={colors.muted}>
          {` ${props.hint}`}
        </text>
      </Show>
    </box>
  );
}
/** Footer key legend: keys stand out, descriptions recede. */
export function KeyHints(props: {
  hints: readonly (readonly [string, string])[];
  /** Drop trailing hints rather than cut one in half. */
  maxWidth: number;
}) {
  const colors = usePalette();
  const fitting = () => {
    let used = 0;
    return props.hints.filter(([key, label]) => {
      used += key.length + label.length + 4;
      return used - 3 <= props.maxWidth;
    });
  };
  return (
    <text height={1} wrapMode="none">
      <For each={fitting()}>
        {([key, label], index) => (
          <>
            <span style={{ fg: colors.text }}>{key}</span>
            <span style={{ fg: colors.muted }}>
              {` ${label}`}
              {index() < fitting().length - 1 ? "   " : ""}
            </span>
          </>
        )}
      </For>
    </text>
  );
}
