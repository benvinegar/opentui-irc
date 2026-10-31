import { For, Show, useContext } from "solid-js";
import type { ConversationId } from "../contracts/common";
import type { ConnectionPhase, ConversationView, NetworkView, UserView } from "../contracts/model";
import type { CommandService } from "../contracts/services";
import type { UserSettings } from "../contracts/settings";
import { Button, FitText, KeyHints, ListItem, ThemeContext, usePalette } from "./primitives";
import { phaseLabel, type KeyHint } from "./shell-labels";
import { nicknameColor } from "./transcript-style";

const HELP_KEYS = [
  ["ctrl+k", "jump to a conversation or action"],
  ["ctrl+f", "search history"],
  ["ctrl+j", "join a channel"],
  ["ctrl+,", "settings"],
  ["alt+↑↓", "previous / next conversation"],
  ["ctrl+↑↓", "recall messages you sent"],
  ["tab", "complete nicknames and commands"],
  ["shift+tab", "move focus out of the composer"],
  ["pgup pgdn", "scroll"],
  ["ctrl+end", "jump to latest"],
  ["esc", "close, or cancel a reply"],
  ["click", "a message to copy, reply, react, or open links"],
  ["drag", "select message text to copy it"],
  ["click name", "see who someone is, or message them"],
] as const;

type Palette = ReturnType<typeof usePalette>;
const phaseColor = (colors: Palette, phase: ConnectionPhase) =>
  phase === "ready" ? colors.green : phase === "disconnected" ? colors.muted : colors.yellow;

/** Networks with their status conversation, then channels and direct messages. */
export function Sidebar(props: {
  networks: readonly NetworkView[];
  conversations: readonly ConversationView[];
  activeId: ConversationId | undefined;
  width: number;
  activate: (id: ConversationId) => void;
  /** Networks without a status conversation open the palette instead. */
  browse: () => void;
}) {
  const colors = usePalette();
  return (
    <scrollbox
      id="sidebar"
      width={props.width}
      flexShrink={0}
      backgroundColor={colors.panel}
      contentOptions={{ flexDirection: "column", paddingTop: 1, paddingX: 1 }}
      scrollX={false}
    >
      <box height={2} flexShrink={0} paddingX={1}>
        <text height={1} fg={colors.accent}>
          <b>opentui-irc</b>
        </text>
      </box>
      <For each={props.networks}>
        {(net) => {
          const conversations = (kind: "channel" | "direct" | "status") =>
            props.conversations.filter((item) => item.networkId === net.id && item.kind === kind);
          const status = () => conversations("status")[0];
          return (
            <box flexDirection="column" flexShrink={0} paddingBottom={1}>
              <ListItem
                id={status() ? `conversation-${status()!.id}` : `network-${net.id}`}
                prefix="●"
                prefixColor={phaseColor(colors, net.phase)}
                label={net.name}
                strong
                {...(net.phase === "ready" ? {} : { hint: phaseLabel(net.phase) })}
                active={!!status() && props.activeId === status()!.id}
                onPress={() => {
                  if (status()) props.activate(status()!.id);
                  else props.browse();
                }}
              />
              <Show when={net.lastError}>
                <box paddingX={1} flexShrink={0}>
                  <text wrapMode="word" fg={colors.error}>
                    {net.lastError?.message}
                  </text>
                </box>
              </Show>
              <For each={["channel", "direct"] as const}>
                {(kind) => (
                  <Show when={conversations(kind).length}>
                    <box height={1} flexShrink={0} paddingX={1} marginTop={1}>
                      <text fg={colors.muted}>{kind === "channel" ? "CHANNELS" : "DIRECT"}</text>
                    </box>
                    <For each={conversations(kind)}>
                      {(conversation) => (
                        <ListItem
                          id={`conversation-${conversation.id}`}
                          prefix={kind === "channel" ? "#" : "@"}
                          label={
                            kind === "channel"
                              ? conversation.name.replace(/^#/u, "")
                              : conversation.name
                          }
                          {...(conversation.mentionCount
                            ? { badge: String(conversation.mentionCount), alert: true }
                            : conversation.unreadCount && !conversation.muted
                              ? { badge: String(conversation.unreadCount), strong: true }
                              : {})}
                          dim={conversation.muted || !conversation.joined}
                          active={props.activeId === conversation.id}
                          onPress={() => props.activate(conversation.id)}
                        />
                      )}
                    </For>
                  </Show>
                )}
              </For>
              <Show
                when={
                  net.phase === "ready" &&
                  !conversations("channel").length &&
                  !conversations("direct").length
                }
              >
                <box paddingX={1} flexShrink={0}>
                  <text wrapMode="word" fg={colors.muted}>
                    No channels yet. Press ctrl+j to join one.
                  </text>
                </box>
              </Show>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}

export function ConversationHeader(props: {
  name: string;
  subtitle: string;
  /** Channel head count shown when the member panel is hidden; 0 omits it. */
  people: number;
  maxNameWidth: number;
}) {
  const colors = usePalette();
  return (
    <box
      id="conversation-header"
      height={2}
      flexShrink={0}
      paddingX={2}
      flexDirection="row"
      border={["bottom"]}
      borderColor={colors.border}
    >
      <FitText
        text={props.name}
        bold
        fg={colors.text}
        width={Math.min(Bun.stringWidth(props.name), props.maxNameWidth)}
      />
      <box width={2} flexShrink={0} />
      <FitText fg={colors.muted} text={props.subtitle} />
      <Show when={props.people}>
        <text flexShrink={0} height={1} fg={colors.muted}>
          {"  "}
          {props.people} {props.people === 1 ? "person" : "people"}
        </text>
      </Show>
    </box>
  );
}

/** First-run guidance shown while no conversation is active. */
export function Welcome(props: {
  history: UserSettings["history"] | undefined;
  setup: () => void;
}) {
  const colors = usePalette();
  return (
    <box flexGrow={1} paddingX={4} paddingTop={2} flexDirection="column">
      <box flexDirection="column" maxWidth={64} gap={1}>
        <text fg={colors.accent}>
          <b>Your next conversation starts here.</b>
        </text>
        <box flexDirection="column">
          <text fg={colors.text}>
            <span style={{ fg: colors.muted }}>1 </span> Add your IRC network
          </text>
          <text fg={colors.text}>
            <span style={{ fg: colors.muted }}>2 </span> Connect to it
          </text>
          <text fg={colors.text}>
            <span style={{ fg: colors.muted }}>3 </span> Join a channel or message someone
          </text>
        </box>
        <box flexDirection="row">
          <Button id="welcome-setup" label="Set up a network →" active onPress={props.setup} />
        </box>
        <text fg={colors.muted} wrapMode="word">
          Local history is {props.history?.enabled ? "enabled" : "disabled"}.
          {props.history?.enabled
            ? ` Messages are retained ${props.history?.retentionDays === null ? "indefinitely" : `for ${props.history?.retentionDays} days`}.`
            : ""}{" "}
          Review privacy in Settings before connecting.
        </text>
      </box>
    </box>
  );
}

export function MemberList(props: {
  /** Sorted and bounded for display. */
  members: readonly UserView[];
  total: number;
  width: number;
  pick: (nick: string, point: { x: number; y: number }) => void;
}) {
  const colors = usePalette();
  const theme = useContext(ThemeContext);
  return (
    <scrollbox
      id="members"
      width={props.width}
      flexShrink={0}
      contentOptions={{ flexDirection: "column", paddingX: 1 }}
      scrollX={false}
    >
      <text height={1} flexShrink={0} fg={colors.muted}>
        PEOPLE · {props.total}
      </text>
      <For each={props.members}>
        {(member) => (
          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            onMouseUp={(event) => props.pick(member.nick, { x: event.x, y: event.y })}
          >
            <FitText
              text={`${member.prefixes[0] ?? " "}${member.nick}`}
              fg={member.away ? colors.muted : nicknameColor(member.nick, theme())}
            />
          </box>
        )}
      </For>
    </scrollbox>
  );
}

/** Footer: status or error text, else key hints; plus a jump-to-latest button and the nick. */
export function StatusBar(props: {
  message: string;
  hints: readonly KeyHint[];
  width: number;
  network: NetworkView | undefined;
  /** Scrolled up or viewing an older window. */
  behind: boolean;
  jumpLatest: () => void;
}) {
  const colors = usePalette();
  const hintsWidth = () =>
    props.width -
    6 -
    (props.network ? props.network.nick.length + 14 : 0) -
    (props.behind ? 10 : 0);
  return (
    <box
      id="status-bar"
      height={1}
      flexShrink={0}
      paddingX={2}
      flexDirection="row"
      backgroundColor={colors.panel}
    >
      <box flexGrow={1} minWidth={0}>
        <Show
          when={props.message}
          fallback={<KeyHints hints={props.hints} maxWidth={hintsWidth()} />}
        >
          <box height={1} flexDirection="row">
            <FitText text={props.message ?? ""} fg={colors.error} />
          </box>
        </Show>
      </box>
      <Show when={props.behind}>
        <Button id="latest" quiet label="↓ latest" onPress={props.jumpLatest} />
      </Show>
      <Show when={props.network}>
        <text flexShrink={0} height={1} fg={colors.muted}>
          {"  "}
          {props.network!.nick}
          <Show when={props.network!.phase === "ready" && !props.network!.secure}>
            <span style={{ fg: colors.yellow }}> · plaintext</span>
          </Show>
          <span style={{ fg: phaseColor(colors, props.network!.phase) }}> ●</span>
        </text>
      </Show>
    </box>
  );
}

/** Key reference (unless one command was asked about) and command help. */
export function HelpPanel(props: { commands: CommandService; command: string | undefined }) {
  const colors = usePalette();
  return (
    <>
      <Show when={!props.command}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={colors.accent}>
            <b>Keys</b>
          </text>
          <For each={HELP_KEYS}>
            {([key, description]) => (
              <box flexDirection="row" height={1} flexShrink={0}>
                <text width={12} flexShrink={0} fg={colors.text}>
                  {key}
                </text>
                <FitText text={description} fg={colors.muted} />
              </box>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="column" flexShrink={0}>
        <text fg={colors.accent}>
          <b>Commands</b>
        </text>
        <For each={props.commands.help(props.command)}>
          {(entry) => (
            <box flexDirection="row" flexShrink={0}>
              <text width={24} flexShrink={0} fg={colors.text}>
                {entry.usage}
              </text>
              <text flexGrow={1} minWidth={0} wrapMode="word" fg={colors.muted}>
                {entry.description}
              </text>
            </box>
          )}
        </For>
      </box>
    </>
  );
}
