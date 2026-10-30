/* oxlint-disable no-control-regex -- Explicitly reject control characters at the input boundary. */
import type { AppAction, AppApi, UserIrcCommand } from "../contracts/app";
import type { NetworkId, Result } from "../contracts/common";
import type { AppSnapshot, ConversationView } from "../contracts/model";
import type { CommandService, InputContext, InputIntent } from "../contracts/services";

const entries = [
  ["connect", "/connect", "Connect the current network"],
  ["disconnect", "/disconnect", "Disconnect without automatic retry"],
  ["reconnect", "/reconnect", "Start a fresh connection"],
  ["join", "/join #channel", "Join a channel on the current network"],
  ["query", "/query nickname", "Open a direct conversation"],
  ["msg", "/msg target message", "Send to an already open conversation; use /query first"],
  ["notice", "/notice target message", "Send a notice to an open conversation"],
  ["me", "/me action", "Describe an action in the current conversation"],
  ["part", "/part", "Leave and close the current conversation"],
  ["close", "/close", "Close the current conversation"],
  ["nick", "/nick nickname", "Change your nickname"],
  ["away", "/away reason", "Set an away message"],
  ["back", "/back", "Clear your away message"],
  ["whois", "/whois nickname", "Request information about a person"],
  ["list", "/list", "Request the channel directory"],
  ["topic", "/topic [new topic]", "Read or change the current channel topic"],
  ["mute", "/mute", "Mute notifications in this conversation"],
  ["unmute", "/unmute", "Restore notifications in this conversation"],
  ["settings", "/settings", "Open network and privacy settings"],
  ["help", "/help [command]", "Show commands and keyboard shortcuts"],
  ["quit", "/quit", "Disconnect and exit opentui-irc"],
].map(([name, usage, description]) => ({ name: name!, usage: usage!, description: description! }));

type Parsed = Result<InputIntent>;

const invalid = (message: string): Parsed => ({
  ok: false,
  error: { code: "invalid-input", message, retryable: false },
});
const action = (value: AppAction): Parsed => ({
  ok: true,
  value: { type: "action", action: value },
});

interface CommandRequest {
  readonly command: string;
  readonly args: string;
  readonly networkId: NetworkId;
  readonly snapshot: AppSnapshot;
  readonly usage: () => Parsed;
}
type NetworkCommand = (request: CommandRequest) => Parsed;
type ConversationCommand = (request: CommandRequest, conversation: ConversationView) => Parsed;

/** Exactly one argument, such as a nickname or channel. */
const word = (args: string) => args.length > 0 && !/\s/u.test(args);
const ircRequest = (networkId: NetworkId, command: UserIrcCommand) =>
  action({ type: "irc.request", networkId, command });
const lifecycle =
  (type: "network.connect" | "network.disconnect" | "network.reconnect"): NetworkCommand =>
  ({ args, networkId, usage }) =>
    args ? usage() : action({ type, networkId });
const nickRequest =
  (type: "nick" | "whois"): NetworkCommand =>
  ({ args, networkId, usage }) =>
    word(args) ? ircRequest(networkId, { type, nick: args }) : usage();
const directMessage: NetworkCommand = ({ command, args, networkId, snapshot, usage }) => {
  const split = /^(\S+)\s+(.+)$/u.exec(args);
  if (!split) return usage();
  // No guessed IRC case mapping: exact displayed target, or explicit /query first.
  const target = snapshot.conversations.find(
    (item) => item.networkId === networkId && item.name === split[1] && item.kind !== "status",
  );
  return target
    ? action({
        type: "message.send",
        conversationId: target.id,
        text: split[2]!,
        kind: command === "notice" ? "notice" : "text",
      })
    : invalid("Open the target with /query or /join first, then use its displayed name.");
};

/** Commands that need only a network. */
const networkCommands = new Map<string, NetworkCommand>([
  ["connect", lifecycle("network.connect")],
  ["disconnect", lifecycle("network.disconnect")],
  ["reconnect", lifecycle("network.reconnect")],
  [
    "join",
    ({ args, networkId, usage }) =>
      word(args) && /^[#&+!]/u.test(args)
        ? action({ type: "conversation.join", networkId, channel: args })
        : usage(),
  ],
  [
    "query",
    ({ args, networkId, usage }) =>
      word(args) ? action({ type: "conversation.query", networkId, nick: args }) : usage(),
  ],
  ["nick", nickRequest("nick")],
  ["whois", nickRequest("whois")],
  [
    "away",
    ({ args, networkId, usage }) =>
      args ? ircRequest(networkId, { type: "away", reason: args }) : usage(),
  ],
  [
    "back",
    ({ args, networkId, usage }) =>
      args ? usage() : ircRequest(networkId, { type: "away", reason: null }),
  ],
  [
    "list",
    ({ args, networkId, usage }) => (args ? usage() : ircRequest(networkId, { type: "list" })),
  ],
  ["msg", directMessage],
  ["notice", directMessage],
]);

const closeConversation: ConversationCommand = ({ args, usage }, conversation) =>
  args ? usage() : action({ type: "conversation.close", conversationId: conversation.id });
const muteConversation =
  (muted: boolean): ConversationCommand =>
  ({ args, usage }, conversation) =>
    args ? usage() : action({ type: "conversation.mute", conversationId: conversation.id, muted });

/** Commands that act on the selected conversation. */
const conversationCommands = new Map<string, ConversationCommand>([
  ["part", closeConversation],
  ["close", closeConversation],
  ["mute", muteConversation(true)],
  ["unmute", muteConversation(false)],
  [
    "me",
    ({ args, usage }, conversation) =>
      !args || conversation.kind === "status"
        ? usage()
        : action({
            type: "message.send",
            conversationId: conversation.id,
            text: args,
            kind: "action",
          }),
  ],
  [
    "topic",
    ({ args, networkId }, conversation) =>
      conversation.kind !== "channel"
        ? invalid("Topics belong to channels.")
        : ircRequest(networkId, {
            type: "topic",
            channel: conversation.name,
            ...(args ? { text: args } : {}),
          }),
  ],
]);

/** Client-local commands that need neither a network nor a conversation. */
function parseClientCommand(command: string, args: string): Parsed | undefined {
  if (command === "help")
    return { ok: true, value: { type: "help", ...(args ? { command: args } : {}) } };
  if (command === "settings" && !args) return { ok: true, value: { type: "settings" } };
  if (command === "quit" && !args) return { ok: true, value: { type: "quit" } };
  return undefined;
}

/** Pure parser: snapshots supply context; parsing never dispatches or opens a socket. */
export function createCommandService(app: Pick<AppApi, "state" | "timeline">): CommandService {
  const resolve = (context: InputContext) => {
    const snapshot = app.state.getSnapshot();
    const conversation = snapshot.conversations.find((item) => item.id === context.conversationId);
    return { snapshot, conversation, networkId: context.networkId ?? conversation?.networkId };
  };
  const sendText = (text: string, conversation: ConversationView | undefined): Parsed => {
    if (!conversation || conversation.kind === "status")
      return invalid("Choose a channel or direct conversation before sending.");
    return action({
      type: "message.send",
      conversationId: conversation.id,
      text: text.startsWith("//") ? text.slice(1) : text,
      kind: "text",
    });
  };
  const parseCommand = (command: string, args: string, context: InputContext): Parsed => {
    const client = parseClientCommand(command, args);
    if (client) return client;
    const entry = entries.find((item) => item.name === command);
    if (!entry)
      return invalid(
        "Unknown command. Type /help for supported commands; use // for a literal slash.",
      );
    const { snapshot, conversation, networkId } = resolve(context);
    if (!networkId) return invalid("Select a network first, or add one in Settings.");
    const request = {
      command,
      args,
      networkId,
      snapshot,
      usage: () => invalid(`Usage: ${entry.usage}`),
    };
    const networkCommand = networkCommands.get(command);
    if (networkCommand) return networkCommand(request);
    if (!conversation) return invalid("Select a conversation first.");
    return conversationCommands.get(command)?.(request, conversation) ?? request.usage();
  };
  return {
    help(command) {
      return command
        ? entries.filter((entry) => entry.name === command.replace(/^\//, "").toLowerCase())
        : entries;
    },
    parse(text, context) {
      if (!text.trim()) return invalid("Write a message first.");
      if (
        text.length > 32_768 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
      )
        return invalid("Input is too long or contains unsafe control characters.");
      if (!text.startsWith("/") || text.startsWith("//"))
        return sendText(text, resolve(context).conversation);
      // A multiline submission is always one message, never a batch of slash commands.
      if (/[\r\n]/u.test(text))
        return invalid(
          "Slash commands must be one line. Use // to send literal text beginning with /.",
        );
      const match = /^\/(\S+)\s*(.*)$/u.exec(text);
      if (!match) return invalid("Type /help to see available commands.");
      return parseCommand(match[1]!.toLowerCase(), match[2]!.trim(), context);
    },
    complete(text, cursorUtf16, context) {
      if (!Number.isInteger(cursorUtf16) || cursorUtf16 < 0 || cursorUtf16 > text.length) return [];
      // Never split a UTF-16 surrogate pair.
      if (
        cursorUtf16 > 0 &&
        /[\uD800-\uDBFF]/u.test(text[cursorUtf16 - 1]!) &&
        /[\uDC00-\uDFFF]/u.test(text[cursorUtf16] ?? "")
      )
        return [];
      const before = text.slice(0, cursorUtf16);
      const token = /\S*$/u.exec(before)![0];
      const start = cursorUtf16 - token.length;
      const replace = { start, end: cursorUtf16 };
      if (start === 0 && token.startsWith("/"))
        return entries
          .filter((entry) => `/${entry.name}`.startsWith(token.toLowerCase()))
          .map((entry) => ({ label: entry.usage, insertText: `/${entry.name} `, replace }));
      const { snapshot, conversation, networkId } = resolve(context);
      const names = snapshot.conversations
        .filter((item) => item.networkId === networkId && item.kind === "channel")
        .map((item) => item.name);
      if (conversation) {
        const timeline = app.timeline(conversation.id);
        if (timeline.ok)
          names.push(...timeline.value.getSnapshot().members.map((member) => member.nick));
      }
      return [...new Set(names)]
        .filter((name) => name.toLowerCase().startsWith(token.toLowerCase()))
        .slice(0, 30)
        .map((name) => ({
          label: name,
          insertText: start === 0 && !/^[#&+!]/u.test(name) ? `${name}: ` : name,
          replace,
        }));
    },
  };
}
