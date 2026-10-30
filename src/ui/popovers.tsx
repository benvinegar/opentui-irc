import { For, Show, useContext } from "solid-js";
import { Button, FitText, ListItem, Popover, ThemeContext, usePalette } from "./primitives";
import type { CardLine } from "./shell-labels";
import { nicknameColor } from "./transcript-style";

export const REACTIONS = ["👍", "🎉", "😂", "👀", "🔥", "✅"] as const;

export interface MenuEntry {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  /** Single-key shortcut while the menu is open. */
  readonly key: string;
  /** Opens a submenu rather than acting. */
  readonly more?: boolean;
  readonly run: () => void;
}

export type MenuPage = "main" | "react" | "links";

interface Placement {
  anchor: { x: number; y: number };
  screenWidth: number;
  screenHeight: number;
  onClose: () => void;
}

function MenuItems(props: { entries: readonly MenuEntry[] }) {
  return (
    <For each={props.entries}>
      {(entry) => (
        <ListItem
          id={entry.id}
          layer="modal"
          prefix={entry.icon}
          label={entry.label}
          hint={entry.more ? `${entry.key} ›` : `${entry.key}  `}
          onPress={entry.run}
        />
      )}
    </For>
  );
}

/** Message actions anchored where the message was clicked; React and multi-link are subpages. */
export function MessageMenu(
  props: Placement & {
    title: string;
    page: MenuPage;
    entries: readonly MenuEntry[];
    links: readonly string[];
    react: (value: string) => void;
  },
) {
  const width = () =>
    props.page === "links"
      ? Math.min(64, Math.max(...props.links.map((url) => url.length)) + 10)
      : 30;
  return (
    <Popover
      anchor={props.anchor}
      screenWidth={props.screenWidth}
      screenHeight={props.screenHeight}
      width={width()}
      height={(props.page === "react" ? 1 : props.entries.length) + 2}
      title={props.title}
      onClose={props.onClose}
    >
      <Show when={props.page === "react"} fallback={<MenuItems entries={props.entries} />}>
        <box flexDirection="row" height={1} paddingX={1}>
          <For each={REACTIONS}>
            {(value, index) => (
              <Button
                id={`react-${index()}`}
                layer="modal"
                quiet
                label={value}
                onPress={() => props.react(value)}
              />
            )}
          </For>
        </box>
      </Show>
    </Popover>
  );
}

/** Who someone is, from WHOIS, plus Message and Copy nickname. */
export function PersonCard(
  props: Placement & {
    nick: string;
    role: string;
    lines: readonly CardLine[];
    entries: readonly MenuEntry[];
  },
) {
  const colors = usePalette();
  const theme = useContext(ThemeContext);
  return (
    <Popover
      anchor={props.anchor}
      screenWidth={props.screenWidth}
      screenHeight={props.screenHeight}
      width={36}
      height={props.lines.length + props.entries.length + 4}
      onClose={props.onClose}
    >
      <box flexDirection="row" height={1} paddingX={1}>
        <FitText text={props.nick} bold fg={nicknameColor(props.nick, theme())} />
        <text flexShrink={0} fg={colors.muted}>
          {props.role}
        </text>
      </box>
      <For each={props.lines}>
        {([line, tone]) => (
          <box flexDirection="row" height={1} paddingX={1}>
            <FitText
              text={line}
              fg={tone === "error" ? colors.error : tone === "text" ? colors.text : colors.muted}
            />
          </box>
        )}
      </For>
      <box height={1} border={["bottom"]} borderColor={colors.border} />
      <MenuItems entries={props.entries} />
    </Popover>
  );
}
