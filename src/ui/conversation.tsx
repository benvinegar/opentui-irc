import { createSignal, For, Show, untrack } from "solid-js";
import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { Message, TimelineSnapshot } from "../contracts/model";
import { Button, FitText, usePalette } from "./primitives";
import { messageTime } from "./shell-labels";
import { MessageRow } from "./transcript";
import { continuesGroup, dayKey, formatDay } from "./transcript-style";

type Point = { x: number; y: number };

/** Message rows with the draggable time/author rail. */
export function Transcript(props: {
  /** Already filtered and bounded for display. */
  messages: readonly Message[];
  gutterWidth: number;
  timeline: TimelineSnapshot | undefined;
  spaced: boolean;
  /** More messages are loaded than are mounted. */
  truncated: boolean;
  /** Loaded messages exist, but every one is a hidden HistServ entry. */
  onlyHistServ: boolean;
  resizingRail: boolean;
  frameRef: (element: BoxRenderable) => void;
  scrollRef: (element: ScrollBoxRenderable) => void;
  loadOlder: () => void;
  select: (message: Message, point: Point) => void;
  nick: (message: Message, point: Point) => void;
  startRailDrag: () => void;
}) {
  const colors = usePalette();
  const [railHot, setRailHot] = createSignal(false);
  const loadingOlder = () => !!props.timeline?.loadingOlder;
  return (
    <box
      id="transcript-frame"
      ref={props.frameRef}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
    >
      <scrollbox
        id="transcript"
        ref={props.scrollRef}
        flexGrow={1}
        minHeight={0}
        scrollX={false}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{
          flexDirection: "column",
          // The scrollbar overlays the final cell; keep wrapped text clear of it.
          paddingRight: 1,
        }}
      >
        <box flexDirection="row" flexShrink={0} paddingLeft={props.gutterWidth + 1}>
          <Button
            id="older"
            quiet
            label={loadingOlder() ? "loading older messages…" : "↑ load older messages"}
            disabled={loadingOlder()}
            onPress={props.loadOlder}
          />
        </box>
        <Show when={props.truncated}>
          <box paddingLeft={props.gutterWidth + 2}>
            <text fg={colors.muted}>
              Showing the latest 300 messages to keep terminal layout bounded. Use Search to reveal
              older context.
            </text>
          </box>
        </Show>
        <Show when={props.onlyHistServ}>
          <box paddingLeft={props.gutterWidth + 2}>
            <text wrapMode="word" fg={colors.muted}>
              Only HistServ entries are loaded. Load older for chat.
            </text>
          </box>
        </Show>
        <For each={props.messages}>
          {(message, index) => {
            const previous = () => props.messages[index() - 1];
            const unread = () => props.timeline?.firstUnreadId === message.id;
            return (
              <MessageRow
                message={message}
                gutterWidth={props.gutterWidth}
                firstUnread={unread()}
                spaced={props.spaced}
                continuation={
                  !unread() &&
                  continuesGroup(previous() && { ...previous()!, at: messageTime(previous()!) }, {
                    ...message,
                    at: messageTime(message),
                  })
                }
                {...(previous() && dayKey(messageTime(previous()!)) !== dayKey(messageTime(message))
                  ? { dayLabel: formatDay(messageTime(message)) }
                  : {})}
                onSelect={(point) => props.select(message, point)}
                {...(message.kind === "event"
                  ? {}
                  : { onNick: (point: Point) => props.nick(message, point) })}
              />
            );
          }}
        </For>
      </scrollbox>
      <box
        id="transcript-divider"
        position="absolute"
        left={props.gutterWidth}
        top={0}
        width={1}
        height="100%"
        border={["left"]}
        borderColor={railHot() || props.resizingRail ? colors.accent : colors.border}
        zIndex={1}
        onMouseOver={() => setRailHot(true)}
        onMouseOut={() => setRailHot(false)}
        onMouseDown={(event) => {
          event.preventDefault();
          setRailHot(false);
          props.startRailDrag();
        }}
      />
    </box>
  );
}

/** Who is typing, the reply banner, and the draft editor. */
export function Composer(props: {
  /** Empty when nobody is typing. */
  typing: string;
  replying: boolean;
  rows: number;
  focused: boolean;
  /** Pasted text sends literally, even when it starts with "/". */
  literal: boolean;
  placeholder: string;
  /** Read once at mount; later drafts are applied to the editor directly. */
  initialDraft: string;
  textareaRef: (element: TextareaRenderable) => void;
  focus: () => void;
  change: () => void;
  submit: () => void;
}) {
  const colors = usePalette();
  return (
    <>
      <Show when={props.typing}>
        <box height={1} flexShrink={0} paddingX={2}>
          <FitText text={props.typing} fg={colors.muted} />
        </box>
      </Show>
      <Show when={props.replying}>
        <box height={1} flexShrink={0} paddingX={2}>
          <text height={1} fg={colors.accent}>
            ↳ Replying to a message · esc to cancel
          </text>
        </box>
      </Show>
      <box
        id="composer-panel"
        height={props.rows + 2}
        flexShrink={0}
        marginX={1}
        paddingX={1}
        flexDirection="row"
        border
        borderStyle="rounded"
        borderColor={props.focused ? colors.accent : colors.border}
        {...(props.literal ? { title: " pasted text sends literally " } : {})}
      >
        <text width={2} flexShrink={0} fg={colors.accent}>
          ›
        </text>
        <textarea
          ref={props.textareaRef}
          height={props.rows}
          flexGrow={1}
          minWidth={0}
          focused={props.focused}
          onMouseDown={props.focus}
          initialValue={untrack(() => props.initialDraft)}
          placeholder={props.placeholder}
          wrapMode="word"
          backgroundColor={colors.bg}
          focusedBackgroundColor={colors.bg}
          textColor={colors.text}
          onContentChange={props.change}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={props.submit}
        />
      </box>
    </>
  );
}
