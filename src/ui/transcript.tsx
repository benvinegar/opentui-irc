import { Show, useContext } from "solid-js";
import type { Message } from "../contracts/model";
import { ThemeContext, usePalette } from "./primitives";
import { formatMessageTime, nicknameColor } from "./transcript-style";

export function MessageRow(props: {
  message: Message;
  gutterWidth: number;
  firstUnread: boolean;
  /** Same sender shortly after their previous line: omit the repeated gutter. */
  continuation?: boolean;
  /** Shown above the row when the calendar day changes. */
  dayLabel?: string;
  onSelect: () => void;
}) {
  const colors = usePalette();
  const theme = useContext(ThemeContext);
  return (
    <box
      id={`message-${props.message.id}`}
      flexDirection="column"
      flexShrink={0}
      onMouseUp={props.onSelect}
    >
      <Show when={props.dayLabel}>
        <box flexDirection="row" height={1} flexShrink={0}>
          <box width={props.gutterWidth + 2} flexShrink={0} />
          <text fg={colors.muted} wrapMode="none" truncate>
            {props.dayLabel}
          </text>
        </box>
      </Show>
      <Show when={props.firstUnread}>
        <box flexDirection="row" height={1} flexShrink={0}>
          <box width={props.gutterWidth + 2} flexShrink={0} />
          <text fg={colors.yellow}>── new ──</text>
        </box>
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <box width={props.gutterWidth} flexShrink={0} flexDirection="row" overflow="hidden">
          <text width={5} height={1} wrapMode="none" fg={colors.muted}>
            {props.continuation
              ? ""
              : formatMessageTime(props.message.serverTime ?? props.message.receivedAt)}
          </text>
          <box width={1} flexShrink={0} />
          <text
            id={`nick-${props.message.id}`}
            width={Math.max(1, props.gutterWidth - 7)}
            height={1}
            wrapMode="none"
            truncate
            textAlign="right"
            fg={
              props.message.kind === "event"
                ? colors.muted
                : nicknameColor(props.message.sender.nick, theme())
            }
          >
            {props.continuation ? "" : <b>{props.message.sender.nick}</b>}
          </text>
        </box>
        <box width={2} flexShrink={0} />
        <box flexGrow={1} minWidth={0} flexDirection="column">
          <Show when={props.message.replyTo}>
            <text wrapMode="word" fg={colors.muted}>
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
            <text wrapMode="word" fg={colors.accent}>
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
