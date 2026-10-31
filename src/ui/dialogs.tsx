import { For, Show } from "solid-js";
import type { ConversationId } from "../contracts/common";
import type { Message } from "../contracts/model";
import { Button, Field, ListItem, usePalette } from "./primitives";
import { messageTime, searchSummary } from "./shell-labels";
import { formatMessageTime } from "./transcript-style";

export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string;
  readonly run: () => void;
}

/** Join a channel or message someone on the active network. */
export function TargetForm(props: {
  kind: "join" | "query";
  networkName: string | undefined;
  value: string;
  onInput: (value: string) => void;
  submit: () => void;
}) {
  const colors = usePalette();
  const join = () => props.kind === "join";
  return (
    <>
      <text fg={colors.muted}>
        Network: {props.networkName ?? "add a network in Settings first"}
      </text>
      <Field
        id="dialog-input"
        label={join() ? "Channel name" : "Nickname"}
        value={props.value}
        onInput={props.onInput}
        placeholder={join() ? "#welcome" : "nickname"}
      />
      <Button
        id="target-submit"
        layer="modal"
        label={join() ? "Join channel" : "Start conversation"}
        onPress={props.submit}
      />
    </>
  );
}

/** Filterable conversations and actions, grouped under headings. */
export function CommandPalette(props: {
  filter: string;
  onFilter: (value: string) => void;
  entries: readonly PaletteEntry[];
  selected: number;
}) {
  const colors = usePalette();
  return (
    <>
      <Field
        id="dialog-input"
        label="Filter"
        hideLabel
        placeholder="Type a channel, person, or action…"
        value={props.filter}
        onInput={props.onFilter}
      />
      <box flexDirection="column" flexShrink={0}>
        <For each={props.entries}>
          {(entry, index) => (
            <>
              <Show when={props.entries[index() - 1]?.group !== entry.group}>
                <box height={1} flexShrink={0} paddingX={1} marginTop={index() ? 1 : 0}>
                  <text fg={colors.muted}>{entry.group}</text>
                </box>
              </Show>
              <ListItem
                id={entry.id}
                layer="modal"
                label={entry.label}
                {...(entry.hint ? { hint: entry.hint } : {})}
                active={index() === props.selected}
                onPress={entry.run}
              />
            </>
          )}
        </For>
        <Show when={!props.entries.length}>
          <text fg={colors.muted}>Nothing matches. Try /join or /msg in the composer.</text>
        </Show>
      </box>
    </>
  );
}

export function SearchPanel(props: {
  query: string;
  onQuery: (value: string) => void;
  searching: boolean;
  results: readonly Message[];
  search: () => void;
  conversationName: (id: ConversationId) => string | undefined;
  reveal: (message: Message) => void;
}) {
  const colors = usePalette();
  return (
    <>
      <Field
        id="dialog-input"
        label="Search local history (all conversations)"
        hideLabel
        placeholder="Search all conversations, then press enter…"
        value={props.query}
        onInput={props.onQuery}
      />
      <box flexDirection="row" flexShrink={0} height={1} justifyContent="space-between">
        <text fg={colors.muted}>{searchSummary(props.searching, props.results.length)}</text>
        <Button
          id="search-submit"
          layer="modal"
          quiet
          label="search"
          disabled={props.searching}
          onPress={props.search}
        />
      </box>
      <box flexDirection="column" flexShrink={0}>
        <For each={props.results}>
          {(message) => (
            <ListItem
              id={`result-${message.id}`}
              layer="modal"
              label={`${message.sender.nick}: ${message.text}`}
              hint={`${props.conversationName(message.conversationId) ?? ""} ${formatMessageTime(messageTime(message))}`.trim()}
              onPress={() => props.reveal(message)}
            />
          )}
        </For>
      </box>
    </>
  );
}

export function PasteReview(props: { text: string; insert: () => void }) {
  const colors = usePalette();
  return (
    <>
      <text fg={colors.muted}>
        This paste will be inserted into the draft as literal text, not executed as slash commands.
        You must still press Send.
      </text>
      <text selectable fg={colors.text}>
        {props.text.slice(0, 4_000)}
        {props.text.length > 4_000 ? "\n[preview truncated]" : ""}
      </text>
      <Button
        id="paste-insert"
        layer="modal"
        label="Insert into draft (do not send)"
        onPress={props.insert}
      />
    </>
  );
}

/** Keyboard route to the message menu. */
export function MessagePicker(props: {
  messages: readonly Message[];
  pick: (message: Message) => void;
}) {
  const colors = usePalette();
  return (
    <>
      <text fg={colors.muted}>
        Select a message for copy, person details, or supported reply/reaction/removal actions.
      </text>
      <For each={props.messages}>
        {(message) => (
          <Button
            id={`pick-${message.id}`}
            layer="modal"
            label={`${message.sender.nick}: ${message.redacted ? "[message removed]" : message.text.slice(0, 100)}`}
            onPress={() => props.pick(message)}
          />
        )}
      </For>
    </>
  );
}

export function RedactConfirm(props: {
  busy: boolean;
  /** The message still exists and may still be removed. */
  allowed: boolean;
  confirm: () => void;
  cancel: () => void;
}) {
  const colors = usePalette();
  return (
    <>
      <text fg={colors.error}>
        Remove your message from this conversation? This cannot be undone. Other clients, server
        history, exports, or logs may still retain a copy.
      </text>
      <Button
        id="redact-confirm"
        layer="modal"
        label={props.busy ? "Requesting removal…" : "Yes, remove my message"}
        disabled={props.busy || !props.allowed}
        onPress={props.confirm}
      />
      <Button id="redact-cancel" layer="modal" label="Keep message" onPress={props.cancel} />
    </>
  );
}

export function QuitConfirm(props: { quit: () => void }) {
  const colors = usePalette();
  return (
    <>
      <text fg={colors.text}>
        opentui-irc will close its connections and flush local history. It does not remain connected
        in the background.
      </text>
      <Button id="quit-confirm" layer="modal" label="Disconnect and quit" onPress={props.quit} />
    </>
  );
}
