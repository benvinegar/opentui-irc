/* oxlint-disable no-control-regex -- Password input rejects terminal control and line-break bytes. */
import { createSignal } from "solid-js";
import { useControl, usePalette } from "./primitives";

/**
 * A deliberately non-native password editor. Only masks enter text renderables;
 * plaintext stays in caller-owned local signals until storeSecret receives it.
 * JavaScript strings cannot provide guaranteed memory zeroization.
 */
export function SecureField(props: {
  id: string;
  value: string;
  onInput: (value: string) => void;
  onError: (message: string) => void;
}) {
  const colors = usePalette();
  const control = useControl(props.id, "modal");
  const [cursor, setCursor] = createSignal(0);
  const characters = () => Array.from(props.value);
  const position = () => Math.min(cursor(), characters().length);
  const insert = (text: string) => {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
      props.onError(
        "Passwords must be a single line without control characters. Nothing was pasted.",
      );
      return;
    }
    const incoming = Array.from(text);
    const current = characters();
    if (current.length + incoming.length > 1024) {
      props.onError("Password input is limited to 1,024 characters.");
      return;
    }
    const index = position();
    props.onInput([...current.slice(0, index), ...incoming, ...current.slice(index)].join(""));
    setCursor(index + incoming.length);
  };
  const mask = () => {
    const count = characters().length;
    if (!count) return control.focused() ? "|" : "[empty]";
    const length = Math.min(count, 64);
    const index = Math.min(position(), length);
    return (
      "•".repeat(index) +
      (control.focused() ? "|" : "") +
      "•".repeat(length - index) +
      (count > 64 ? "…" : "")
    );
  };
  return (
    <box height={2} flexShrink={0} flexDirection="column">
      <text fg={colors.muted}>Account password · hidden · saved in your OS credential vault</text>
      <box
        id={props.id}
        ref={control.ref}
        height={1}
        focusable
        focused={control.focused()}
        backgroundColor={control.focused() ? colors.bg : colors.raised}
        onMouseDown={() => {
          control.select();
          setCursor(characters().length);
        }}
        onPaste={(event) => {
          event.preventDefault();
          event.stopPropagation();
          insert(new TextDecoder().decode(event.bytes));
        }}
        onKeyDown={(event) => {
          // Leave global traversal/quit keys alone; prevent all password editing from propagating.
          if (
            event.name === "tab" ||
            event.name === "escape" ||
            (event.ctrl && ["q", "c"].includes(event.name))
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const current = characters();
          const index = position();
          if (event.ctrl && event.name === "u") {
            props.onInput("");
            setCursor(0);
          } else if (event.name === "left") setCursor(Math.max(0, index - 1));
          else if (event.name === "right") setCursor(Math.min(current.length, index + 1));
          else if (event.name === "home") setCursor(0);
          else if (event.name === "end") setCursor(current.length);
          else if (event.name === "backspace" && index > 0) {
            current.splice(index - 1, 1);
            props.onInput(current.join(""));
            setCursor(index - 1);
          } else if (event.name === "delete") {
            current.splice(index, 1);
            props.onInput(current.join(""));
          } else if (
            !event.ctrl &&
            !event.meta &&
            !event.option &&
            event.sequence &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(event.sequence)
          )
            insert(event.sequence);
        }}
      >
        <text fg={colors.text} selectable={false}>
          {mask()}
        </text>
      </box>
    </box>
  );
}
