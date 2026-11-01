import { Show, useContext } from "solid-js";
import type { Message } from "../contracts/model";
import { FitText, Rule, ThemeContext, usePalette } from "./primitives";
import { formatMessageTime, nicknameColor } from "./transcript-style";

export function MessageRow(props: {
  message: Message;
  gutterWidth: number;
  firstUnread: boolean;
  /** Same sender shortly after their previous line: omit the repeated gutter. */
  continuation?: boolean;
  /** Shown above the row as a full-width rule when the calendar day changes. */
  dayLabel?: string;
  /** Comfortable density: a blank line above each new sender group. */
  spaced?: boolean;
  onSelect: (point: { x: number; y: number }) => void;
  /** Pressing the nickname opens the person card instead of the message menu. */
  onNick?: (point: { x: number; y: number }) => void;
}) {
  const colors = usePalette();
  const theme = useContext(ThemeContext);
  // Only a press and release on the same cell is a click; anything else was a drag.
  let pressed: { x: number; y: number } | undefined;
  const clicked = (event: { x: number; y: number }) =>
    pressed?.x === event.x && pressed.y === event.y;
  return (
    <box
      id={`message-${props.message.id}`}
      flexDirection="column"
      flexShrink={0}
      onMouseDown={(event) => {
        pressed = { x: event.x, y: event.y };
      }}
      onMouseUp={(event) => {
        if (clicked(event)) props.onSelect({ x: event.x, y: event.y });
      }}
    >
      <Show when={props.spaced && !props.continuation}>
        <box height={1} flexShrink={0} />
      </Show>
      <Show when={props.dayLabel}>
        <Rule
          label={props.dayLabel ?? ""}
          inset={props.gutterWidth + 1}
          fg={colors.border}
          labelFg={colors.muted}
        />
        <box height={1} flexShrink={0} />
      </Show>
      <Show when={props.firstUnread}>
        <box flexDirection="row" height={1} flexShrink={0}>
          <box width={props.gutterWidth + 2} flexShrink={0} />
          <text selectable={false} fg={colors.yellow}>
            ── new ──
          </text>
        </box>
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <box width={props.gutterWidth} flexShrink={0} flexDirection="row" overflow="hidden">
          <text width={5} height={1} wrapMode="none" selectable={false} fg={colors.muted}>
            {props.continuation
              ? ""
              : formatMessageTime(props.message.serverTime ?? props.message.receivedAt)}
          </text>
          <box width={1} flexShrink={0} />
          <box
            flexShrink={0}
            onMouseUp={(event) => {
              if (props.continuation || !props.onNick || !clicked(event)) return;
              event.stopPropagation();
              props.onNick({ x: event.x, y: event.y });
            }}
          >
            <FitText
              id={`nick-${props.message.id}`}
              width={Math.max(1, props.gutterWidth - 7)}
              textAlign="right"
              bold
              fg={
                props.message.kind === "event"
                  ? colors.muted
                  : nicknameColor(props.message.sender.nick, theme())
              }
              text={props.continuation ? "" : props.message.sender.nick}
            />
          </box>
        </box>
        <box width={2} flexShrink={0} />
        <box flexGrow={1} minWidth={0} flexDirection="column">
          <Show when={props.message.replyTo}>
            <text wrapMode="word" selectable={false} fg={colors.muted}>
              ↳ reply to {props.message.replyTo?.localId ?? "earlier message"}
            </text>
          </Show>
          <text
            id={`body-${props.message.id}`}
            selectable
            wrapMode="word"
            fg={
              props.message.kind === "event"
                ? colors.muted
                : props.message.sendState === "failed" || props.message.sendState === "uncertain"
                  ? colors.error
                  : colors.text
            }
          >
            {props.message.redacted
              ? "[message removed]"
              : `${props.message.kind === "action" ? "* " : ""}${props.message.text}`}
            <Show when={props.message.sendState && props.message.sendState !== "echo-observed"}>
              <span
                style={{
                  fg:
                    props.message.sendState === "failed" || props.message.sendState === "uncertain"
                      ? colors.error
                      : colors.muted,
                }}
              >
                {" "}
                [{props.message.sendState}]
              </span>
            </Show>
          </text>
          <Show when={props.message.reactions.length}>
            <text wrapMode="word" selectable={false} fg={colors.accent}>
              {props.message.reactions
                .map((reaction) => `${reaction.value} ${reaction.count}`)
                .join("  ")}
            </text>
          </Show>
        </box>
      </box>
    </box>
  );
}
