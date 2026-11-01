import type { UserId } from "../contracts/common";
import type { DiscoverySnapshot, UserDetails } from "../contracts/discovery";
import type {
  ConnectionPhase,
  ConversationView,
  Message,
  NetworkView,
  UserView,
} from "../contracts/model";

export type Modal =
  | "settings"
  | "help"
  | "join"
  | "query"
  | "switch"
  | "search"
  | "paste"
  | "message"
  | "messages"
  | "directory"
  | "whois"
  | "person"
  | "redact"
  | "quit"
  | null;

export type KeyHint = readonly [string, string];
type CardTone = "text" | "muted" | "error";
export type CardLine = readonly [string, CardTone];

export const messageTime = (message: Message) => message.serverTime ?? message.receivedAt;

export const phaseLabel = (phase: ConnectionPhase) =>
  phase === "ready"
    ? "connected"
    : phase === "disconnected"
      ? "offline"
      : phase === "reconnecting"
        ? "reconnecting…"
        : "connecting…";

/** Control a newly opened modal focuses first. */
const MODAL_FOCUS: Partial<Record<NonNullable<Modal>, string>> = {
  settings: "network-name",
  whois: "whois-nick",
  directory: "directory-filter",
  message: "copy-message",
  person: "person-message",
  quit: "quit-confirm",
  redact: "redact-cancel",
  join: "dialog-input",
  query: "dialog-input",
  switch: "dialog-input",
  search: "dialog-input",
};
export const modalFocusTarget = (modal: Modal) => (modal && MODAL_FOCUS[modal]) ?? "dialog-close";

const DIALOG_TITLES: Partial<Record<NonNullable<Modal>, string>> = {
  settings: "Settings · Add network",
  paste: "Review paste — nothing has been sent",
  quit: "Disconnect and quit?",
  switch: "Jump to…",
  redact: "Remove message",
  whois: "Look up a person",
  messages: "Select a message",
  query: "Message someone",
};
export const dialogTitle = (modal: NonNullable<Modal>) =>
  DIALOG_TITLES[modal] ?? `${modal.charAt(0).toUpperCase()}${modal.slice(1)}`;

/** Short confirmations and pickers use a compact dialog. */
export const compactDialog = (modal: Modal) =>
  modal === "switch" ||
  modal === "join" ||
  modal === "query" ||
  modal === "quit" ||
  modal === "redact";

/** Footer key legend for the current layer; `submenu` is a message-menu page other than main. */
export function footerHints(modal: Modal, submenu: boolean): readonly KeyHint[] {
  if (modal === "switch")
    return [
      ["↑↓", "select"],
      ["enter", "open"],
      ["esc", "close"],
    ];
  if (modal === "message" || modal === "person")
    return [
      ["↑↓", "select"],
      ["letter", "shortcut"],
      ["esc", submenu ? "back" : "close"],
    ];
  if (modal === "help" || modal === "messages")
    return [
      ["pgup pgdn", "scroll"],
      ["esc", "close"],
    ];
  if (modal)
    return [
      ["tab", "next"],
      ["enter", "choose"],
      ["esc", "close"],
    ];
  return [
    ["ctrl+k", "jump to…"],
    ["ctrl+f", "search"],
    ["f1", "help"],
    ["ctrl+q", "quit"],
  ];
}

/** Header text beside the conversation name: a DM warning, connection security, or the topic. */
export function conversationSubtitle(
  conversation: ConversationView | undefined,
  network: NetworkView | undefined,
) {
  if (conversation?.kind === "direct") return "Nicknames can be reused. Verify accounts.";
  if (conversation?.kind !== "status") return conversation?.topic || "";
  const phase = network?.phase ?? "disconnected";
  const transport = ["registering", "authenticating", "ready"].includes(phase)
    ? network?.secure
      ? "TLS"
      : "plaintext"
    : "";
  return [transport, phaseLabel(phase)].filter(Boolean).join(" · ");
}

const ROLES = new Map([
  ["~", "owner"],
  ["&", "admin"],
  ["@", "op"],
  ["%", "half-op"],
  ["+", "voice"],
]);
export const memberRole = (prefix: string | undefined) => ROLES.get(prefix ?? "") ?? "";

export function typingLabel(ids: readonly UserId[], members: readonly UserView[]) {
  const nicks = ids
    .map((id) => members.find((member) => member.id === id)?.nick)
    .filter((nick): nick is string => !!nick);
  if (!nicks.length || nicks.length !== ids.length) return "Someone is typing…";
  if (nicks.length > 2) return "Several people are typing…";
  return `${nicks.join(" and ")} ${nicks.length === 1 ? "is" : "are"} typing…`;
}

export function searchSummary(searching: boolean, count: number) {
  if (searching) return "Searching…";
  if (!count) return "Up to 50 results from local history.";
  return `${count}${count === 50 ? "+" : ""} result${count === 1 ? "" : "s"} · enter to reveal in context`;
}

/** Card lines from a WHOIS reply; the network may omit any of them. */
function detailLines(details: UserDetails): CardLine[] {
  const lines: CardLine[] = [];
  if (details.username || details.hostname)
    lines.push([`${details.username ?? "?"}@${details.hostname ?? "?"}`, "muted"]);
  if (details.realname) lines.push([`"${details.realname}"`, "text"]);
  lines.push([details.account ? `account: ${details.account}` : "not identified", "muted"]);
  if (details.awayReason) lines.push([`away: ${details.awayReason}`, "text"]);
  if (details.channels.length) lines.push([`in ${details.channels.join(" ")}`, "muted"]);
  return lines;
}

/** Person card body for `nick`, using only a WHOIS reply that matches it. */
export function personCardLines(
  nick: string,
  info: DiscoverySnapshot["user"] | undefined,
  online: boolean,
): readonly CardLine[] {
  const details =
    info?.details && info.details.nick.toLowerCase() === nick.toLowerCase()
      ? info.details
      : undefined;
  if (!online) return [["Offline · details unavailable", "muted"]];
  if (info?.state === "failed" && !details)
    return [[info.error?.message ?? "No details available.", "error"]];
  if (!details) return [["Looking up…", "muted"]];
  return detailLines(details);
}
