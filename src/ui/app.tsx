/* oxlint-disable no-control-regex -- Explicit terminal control rejection is a security boundary. */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  useContext,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import {
  onBlur,
  onFocus,
  onResize,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import { ScrollBoxRenderable, type Renderable, type TextareaRenderable } from "@opentui/core";
import type { AppAction, AppApi } from "../contracts/app";
import type { ConversationId, MessageId, NetworkId } from "../contracts/common";
import type { ConnectionPhase, Message, TimelineSnapshot } from "../contracts/model";
import type {
  CommandService,
  Completion,
  ExternalActions,
  InputContext,
} from "../contracts/services";
import { useReadable } from "./bridge";
import {
  Button,
  Dialog,
  Field,
  FocusContext,
  KeyHints,
  ListItem,
  ThemeContext,
  usePalette,
} from "./primitives";
import { SettingsForm } from "./settings";
import { DiscoveryPanel } from "./discovery";
import { createTypingReporter } from "./typing";
import { MessageRow } from "./transcript";
import {
  continuesGroup,
  dayKey,
  formatDay,
  nicknameColor,
  transcriptGutterWidth,
} from "./transcript-style";
import { isHistServMessage } from "../contracts/presentation";

export interface UiOptions {
  readonly app: AppApi;
  readonly commands: CommandService;
  readonly external: ExternalActions;
  readonly onQuit?: () => void | Promise<void>;
}
type Modal =
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
  | "redact"
  | "quit"
  | null;
const cleanPaste = (value: string) =>
  value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");

const messageTime = (message: Message) => message.serverTime ?? message.receivedAt;
const phaseLabel = (phase: ConnectionPhase) =>
  phase === "ready"
    ? "connected"
    : phase === "disconnected"
      ? "offline"
      : phase === "reconnecting"
        ? "reconnecting…"
        : "connecting…";
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
  ["click", "a message to copy, reply, or open links"],
] as const;
interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string;
  readonly run: () => void;
}

export function OpenIrc(props: UiOptions) {
  const document = useReadable(props.app.settings);
  return (
    <ThemeContext.Provider value={() => document()?.tui.theme ?? "dark"}>
      <Shell {...props} />
    </ThemeContext.Provider>
  );
}

function Shell(props: UiOptions) {
  const colors = usePalette();
  const theme = useContext(ThemeContext);
  const phaseColor = (phase: ConnectionPhase) =>
    phase === "ready" ? colors.green : phase === "disconnected" ? colors.muted : colors.yellow;
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const state = useReadable(props.app.state);
  const settings = useReadable(props.app.settings);
  const operations = useReadable(props.app.operations);
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const [focusId, setFocusId] = createSignal("composer");
  const controls = new Map<string, { layer: string; control: Renderable }>();
  const [modal, setModal] = createSignal<Modal>(null);
  const [status, setStatus] = createSignal("");
  const [formText, setFormText] = createSignal("");
  const [helpCommand, setHelpCommand] = createSignal<string>();
  const [paste, setPaste] = createSignal("");
  const [literalDraft, setLiteralDraft] = createSignal(false);
  const [selectedMessage, setSelectedMessage] = createSignal<Message>();
  const [discoveryNetwork, setDiscoveryNetwork] = createSignal<NetworkId>();
  const [requestedNick, setRequestedNick] = createSignal("");
  const [typingFocused, setTypingFocused] = createSignal(true);
  const [redacting, setRedacting] = createSignal(false);
  const [reply, setReply] = createSignal<MessageId>();
  const [results, setResults] = createSignal<readonly Message[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);
  const [terminalFocused, setTerminalFocused] = createSignal(false);
  const [reveal, setReveal] = createSignal<MessageId>();
  const [revealHistServ, setRevealHistServ] = createSignal(false);
  const [paletteIndex, setPaletteIndex] = createSignal(0);
  const [savingHistServ, setSavingHistServ] = createSignal(false);
  let composer: TextareaRenderable | undefined;
  let transcript: ScrollBoxRenderable | undefined;
  let draftGuard = false;
  let previousConversation: ConversationId | undefined;
  let pasteConversation: ConversationId | undefined;
  let sendBusy = false;
  let lastReport = "";
  let returnFocus = "composer";
  const histories = new Map<ConversationId, { text: string; literal: boolean }[]>();
  const literalConversations = new Set<ConversationId>();
  let historyIndex = 0;
  let historyDraft = "";
  let historyLiteralDraft = false;
  let completionCycle:
    | {
        base: string;
        output: string;
        cursor: number;
        choices: readonly Completion[];
        index: number;
        conversationId: ConversationId | undefined;
      }
    | undefined;
  let pendingAnchor: { id: string; offset: number } | undefined;
  let pendingReveal: MessageId | undefined;
  const activeId = createMemo(() => state().activeConversationId);
  const active = createMemo(() =>
    state().conversations.find((item) => item.id === state().activeConversationId),
  );
  const network = createMemo(
    () => state().networks.find((item) => item.id === active()?.networkId) ?? state().networks[0],
  );
  const context = (): InputContext => ({
    ...(network() ? { networkId: network()!.id } : {}),
    ...(active() ? { conversationId: active()!.id } : {}),
  });
  const [timeline, setTimeline] = createSignal<TimelineSnapshot>();
  const captureAnchor = () => {
    if (
      !transcript ||
      transcript.scrollTop + transcript.viewport.height >= transcript.scrollHeight - 1
    )
      return;
    const row = transcript
      .getChildren()
      .find(
        (child) =>
          child.id.startsWith("message-") && child.y + child.height > transcript!.viewport.y,
      );
    if (row) pendingAnchor = { id: row.id, offset: row.y - transcript.viewport.y };
  };
  createEffect(() => {
    const id = activeId();
    setTimeline(undefined);
    if (!id) return;
    const model = props.app.timeline(id);
    if (!model.ok) {
      setStatus(model.error.message);
      return;
    }
    setTimeline(model.value.getSnapshot());
    onCleanup(
      model.value.subscribe(() => {
        captureAnchor();
        setTimeline(model.value.getSnapshot());
      }),
    );
  });
  // App windows are bounded; impose a second hard cap on mounted layout work.
  const messages = createMemo(() => timeline()?.messages.slice(-300) ?? []);
  const showHistServ = createMemo(() => settings()?.tui.showHistServ === true || revealHistServ());
  const visibleMessages = createMemo(() =>
    messages().filter((message) => showHistServ() || !isHistServMessage(message)),
  );
  const histServCount = createMemo(() => messages().filter(isHistServMessage).length);
  const toggleHistServ = async () => {
    const document = settings();
    if (!document || savingHistServ()) return;
    setSavingHistServ(true);
    captureAnchor();
    try {
      const result = await props.app.saveSettings(
        { section: "tui", value: { ...document.tui, showHistServ: !showHistServ() } },
        document.revision,
        abort.signal,
      );
      if (result.ok) setRevealHistServ(false);
      else setStatus(result.error.message);
    } finally {
      setSavingHistServ(false);
    }
  };
  const sidebarWidth = createMemo(() =>
    dimensions().width < 65 ? 18 : (settings()?.tui.sidebarWidth ?? 26),
  );
  const gutterWidth = createMemo(() =>
    transcriptGutterWidth(
      dimensions().width - sidebarWidth(),
      Math.max(0, ...visibleMessages().map((message) => Bun.stringWidth(message.sender.nick))),
    ),
  );
  const composerRows = createMemo(() =>
    Math.min(3, 1 + (timeline()?.draft.match(/\n/g)?.length ?? 0)),
  );
  const orderedControls = (layer: string) => {
    const ids: string[] = [];
    const visit = (parent: Renderable) => {
      for (const child of parent.getChildren()) {
        const entry = controls.get(child.id);
        if (entry?.layer === layer && entry.control === child) ids.push(child.id);
        visit(child);
      }
    };
    visit(renderer.root);
    return ids;
  };
  let pendingFocusReveal: Renderable | undefined;
  const revealControl = (control: Renderable | undefined) => {
    let parent = control?.parent;
    while (parent && control) {
      if (parent instanceof ScrollBoxRenderable) {
        const margin = parent.viewport.height > 2 ? 1 : 0;
        const top = parent.viewport.y + margin;
        const bottom = parent.viewport.y + parent.viewport.height - margin;
        if (control.y < top) parent.scrollBy(control.y - top);
        else if (control.y + control.height > bottom)
          parent.scrollBy(control.y + control.height - bottom);
      }
      parent = parent.parent;
    }
  };
  const focus = (id: string) => {
    if (modal() && controls.get(id)?.layer !== "modal") return;
    setFocusId(id);
    const control = controls.get(id)?.control;
    control?.focus();
    revealControl(control);
    // Recheck against measured layout, not a field's stale pre-focus coordinates.
    pendingFocusReveal = control;
  };
  const closeModal = () => {
    setModal(null);
    setPaste("");
    queueMicrotask(() => focus(returnFocus));
  };
  const closeToComposer = () => {
    returnFocus = "composer";
    closeModal();
  };
  const openModal = (value: Modal) => {
    if (!modal()) returnFocus = focusId();
    setFormText("");
    setStatus("");
    setModal(value);
    queueMicrotask(() => {
      const target =
        value === "settings"
          ? "network-name"
          : value === "whois"
            ? "whois-nick"
            : value === "directory"
              ? "directory-filter"
              : ["join", "query", "switch", "search"].includes(value ?? "")
                ? "dialog-input"
                : "dialog-close";
      focus(target);
    });
  };
  const run = async (action: AppAction) => {
    if (
      action.type === "irc.request" &&
      (action.command.type === "list" || action.command.type === "whois")
    ) {
      const target = action.command.type === "list" ? "directory" : "whois";
      const needsOpen = modal() !== target || discoveryNetwork() !== action.networkId;
      setDiscoveryNetwork(action.networkId);
      if (action.command.type === "whois") setRequestedNick(action.command.nick);
      if (needsOpen) openModal(target);
    }
    const result = await props.app.dispatch(action, abort.signal);
    if (!result.ok) setStatus(result.error.message);
    return result;
  };
  const typing = createTypingReporter({
    report: (conversationId, active) => {
      void run({ type: "typing.set", conversationId, active });
    },
  });
  onCleanup(typing.dispose);
  const typingContext = (text: string) => ({
    ...(activeId() ? { conversationId: activeId()! } : {}),
    enabled: settings()?.user.sendTyping === true,
    available:
      network()?.phase === "ready" &&
      network()?.features.typing === true &&
      active()?.kind !== "status",
    focused: typingFocused() && focusId() === "composer" && !modal(),
    hasText: !!text.trim() && (literalDraft() || !text.trimStart().startsWith("/")),
  });
  createEffect(() => typing.configure(typingContext(timeline()?.draft ?? "")));
  const quit = async () => {
    if (props.onQuit) await props.onQuit();
    else {
      const result = await props.app.shutdown();
      if (!result.ok) setStatus(result.error.message);
      renderer.destroy();
    }
  };
  const activate = (id: ConversationId) => {
    void run({ type: "conversation.activate", conversationId: id });
    closeToComposer();
  };
  createEffect(() => {
    const value = timeline();
    if (!value || !composer) return;
    const changed = previousConversation !== value.conversationId;
    if (changed) {
      draftGuard = true;
      composer.setText(value.draft);
      composer.gotoBufferEnd();
      draftGuard = false;
    }
    if (changed) {
      previousConversation = value.conversationId;
      setRevealHistServ(false);
      setReply(undefined);
      setLiteralDraft(literalConversations.has(value.conversationId));
      historyIndex = 0;
      transcript?.scrollTo(transcript.scrollHeight);
      setAtBottom(true);
    }
  });
  const syncDraft = () => {
    if (draftGuard || !composer || !active()) return;
    const text = composer.plainText;
    if (text.length > 32_768) {
      setStatus("Draft limit is 32,768 characters. Remove some text before sending.");
      return;
    }
    typing.activity(typingContext(text));
    void run({ type: "draft.set", conversationId: active()!.id, text });
  };
  const send = async () => {
    if (modal() || sendBusy || !composer || !active()) return;
    const text = composer.plainText;
    if (!text.trim()) return;
    if (text.length > 32_768) {
      setStatus("Draft limit is 32,768 characters.");
      return;
    }
    const conversationId = active()!.id;
    const intent = literalDraft()
      ? {
          ok: true as const,
          value: {
            type: "action" as const,
            action: { type: "message.send" as const, conversationId, text, kind: "text" as const },
          },
        }
      : props.commands.parse(text, context());
    if (!intent.ok) {
      setStatus(intent.error.message);
      return;
    }
    switch (intent.value.type) {
      case "action": {
        typing.stop();
        sendBusy = true;
        const action = intent.value.action;
        const replyTo = reply();
        const result = await run(
          action.type === "message.send" && replyTo ? { ...action, replyTo } : action,
        );
        sendBusy = false;
        if (result.ok) {
          if (action.type === "message.send") typing.messageSent(conversationId);
          const previous = histories.get(conversationId) ?? [];
          histories.set(conversationId, [
            ...previous.slice(-49),
            { text, literal: literalDraft() },
          ]);
          if (histories.size > 32) {
            const oldest = histories.keys().next().value;
            if (oldest) histories.delete(oldest);
          }
          historyIndex = 0;
          // Do not erase edits made while the acceptance promise was pending.
          if (active()?.id === conversationId && composer.plainText === text) {
            composer.clear();
            void run({ type: "draft.set", conversationId, text: "" });
            setLiteralDraft(false);
            literalConversations.delete(conversationId);
            setReply(undefined);
          }
        }
        break;
      }
      case "help":
        setHelpCommand(intent.value.command);
        openModal("help");
        break;
      case "settings":
        openModal("settings");
        break;
      case "quit":
        openModal("quit");
        break;
    }
  };
  const insertPaste = () => {
    if (!composer || pasteConversation !== active()?.id) {
      setStatus("Conversation changed; paste cancelled.");
      closeModal();
      return;
    }
    // Even a pasted /command is a literal message, including after conversation switches.
    composer.insertText(paste());
    setLiteralDraft(true);
    if (active()) literalConversations.add(active()!.id);
    syncDraft();
    closeToComposer();
  };
  usePaste((event) => {
    if (modal() || focusId() !== "composer") return;
    event.preventDefault();
    const text = cleanPaste(new TextDecoder().decode(event.bytes));
    if (text.length + (composer?.plainText.length ?? 0) > 32_768) {
      setStatus("Paste exceeds the draft limit (32,768 characters).");
      return;
    }
    pasteConversation = active()?.id;
    if (text.includes("\n") || text.length > 512 || text.trimStart().startsWith("/")) {
      setPaste(text);
      openModal("paste");
    } else {
      composer?.insertText(text);
      setLiteralDraft(true);
      if (active()) literalConversations.add(active()!.id);
      syncDraft();
    }
  });
  const jumpLatest = async () => {
    if (active() && timeline()?.atLatest === false)
      await run({ type: "history.latest", conversationId: active()!.id });
    transcript?.scrollTo(transcript.scrollHeight);
  };
  const search = async () => {
    if (searching() || !formText().trim()) return;
    setSearching(true);
    const result = await props.app.search({ text: formText(), limit: 50 }, abort.signal);
    setSearching(false);
    if (!result.ok) setStatus(result.error.message);
    else setResults(result.value.items);
  };
  const complete = () => {
    if (!composer) return;
    // Native buffer offsets count cells; extracting the prefix converts safely to UTF-16.
    const cursor = composer.getTextRange(0, composer.cursorOffset).length;
    if (
      completionCycle?.output === composer.plainText &&
      completionCycle.cursor === cursor &&
      completionCycle.conversationId === activeId()
    )
      completionCycle.index = (completionCycle.index + 1) % completionCycle.choices.length;
    else
      completionCycle = {
        base: composer.plainText,
        output: "",
        cursor,
        choices: props.commands.complete(composer.plainText, cursor, context()),
        index: 0,
        conversationId: activeId(),
      };
    const completion = completionCycle.choices[completionCycle.index];
    if (!completion) {
      completionCycle = undefined;
      setStatus("No completions. Try /help for commands.");
      return;
    }
    const prefix = completionCycle.base.slice(0, completion.replace.start) + completion.insertText;
    const output = prefix + completionCycle.base.slice(completion.replace.end);
    composer.replaceText(output);
    composer.cursorOffset = composer.editBuffer.measureText(prefix);
    completionCycle.output = output;
    completionCycle.cursor = prefix.length;
    setStatus(
      `${completion.label}${completionCycle.choices.length > 1 ? ` · Tab cycles ${completionCycle.choices.length} choices` : ""}`,
    );
    syncDraft();
  };
  useKeyboard((event) => {
    if (event.ctrl && (event.name === "q" || event.name === "c")) {
      event.preventDefault();
      openModal("quit");
      return;
    }
    if (event.name === "escape") {
      event.preventDefault();
      if (modal()) closeModal();
      else {
        setReply(undefined);
        focus("composer");
      }
      return;
    }
    if (event.name === "tab") {
      event.preventDefault();
      if (!modal() && focusId() === "composer" && !event.shift) {
        complete();
        return;
      }
      const layer = modal() ? "modal" : "main";
      const ids = orderedControls(layer);
      const current = ids.indexOf(focusId());
      const next = ids[(current + (event.shift ? -1 : 1) + ids.length) % ids.length];
      if (next) focus(next);
      return;
    }
    if (modal()) {
      if (controls.get(focusId())?.layer !== "modal") {
        event.preventDefault();
        return;
      }
      if (event.name === "pageup" || event.name === "pagedown") {
        event.preventDefault();
        pendingFocusReveal = undefined;
        const viewport = renderer.root.findDescendantById("modal-scroll");
        if (viewport instanceof ScrollBoxRenderable)
          viewport.scrollBy(event.name === "pageup" ? -1 : 1, "viewport");
      } else if (
        modal() === "switch" &&
        focusId() === "dialog-input" &&
        (event.name === "up" || event.name === "down")
      ) {
        event.preventDefault();
        const count = filteredPalette().length;
        if (count)
          setPaletteIndex((index) => (index + (event.name === "up" ? -1 : 1) + count) % count);
        const target = renderer.root.findDescendantById(
          filteredPalette()[paletteIndex()]?.id ?? "",
        );
        if (target) revealControl(target);
      } else if (event.name === "return" && focusId() === "dialog-input") {
        event.preventDefault();
        if (modal() === "search") void search();
        else if (modal() === "join" || modal() === "query") void submitTarget();
        else if (modal() === "switch") filteredPalette()[paletteIndex()]?.run();
      }
      return;
    }
    if (event.name === "f1") {
      event.preventDefault();
      setHelpCommand(undefined);
      openModal("help");
    } else if (event.ctrl && (event.name === "k" || event.name === "p")) {
      event.preventDefault();
      openModal("switch");
    } else if (event.ctrl && event.name === "f") {
      event.preventDefault();
      setResults([]);
      openModal("search");
    } else if (event.ctrl && event.name === "j") {
      event.preventDefault();
      openModal("join");
    } else if (event.ctrl && event.name === ",") {
      event.preventDefault();
      openModal("settings");
    } else if (event.meta && (event.name === "up" || event.name === "down")) {
      event.preventDefault();
      const all = state().conversations;
      const index = all.findIndex((item) => item.id === active()?.id);
      const next = all[(index + (event.name === "up" ? -1 : 1) + all.length) % all.length];
      if (next) activate(next.id);
    } else if (event.name === "pageup" || event.name === "pagedown") {
      event.preventDefault();
      transcript?.scrollBy(event.name === "pageup" ? -1 : 1, "viewport");
    } else if (event.ctrl && event.name === "end") {
      event.preventDefault();
      void jumpLatest();
    } else if (
      event.ctrl &&
      (event.name === "up" || event.name === "down") &&
      composer &&
      active()
    ) {
      event.preventDefault();
      const items = histories.get(active()!.id) ?? [];
      if (!items.length) return;
      if (historyIndex === 0) {
        historyDraft = composer.plainText;
        historyLiteralDraft = literalDraft();
      }
      historyIndex = Math.min(
        items.length,
        Math.max(0, historyIndex + (event.name === "up" ? 1 : -1)),
      );
      const item = historyIndex ? items[items.length - historyIndex] : undefined;
      composer.replaceText(item ? item.text : historyDraft);
      setLiteralDraft(item ? item.literal : historyLiteralDraft);
      if (literalDraft()) literalConversations.add(active()!.id);
      else literalConversations.delete(active()!.id);
      composer.gotoBufferEnd();
      syncDraft();
    }
  });
  const submitTarget = async () => {
    const intent = props.commands.parse(
      `/${modal() === "query" ? "query" : "join"} ${formText()}`,
      context(),
    );
    if (!intent.ok) {
      setStatus(intent.error.message);
      return;
    }
    if (intent.value.type === "action") {
      const result = await run(intent.value.action);
      if (result.ok) closeToComposer();
    }
  };
  onResize(() => {
    captureAnchor();
    if (modal()) pendingFocusReveal = controls.get(focusId())?.control;
  });
  onFocus(() => {
    setTerminalFocused(true);
    setTypingFocused(true);
  });
  onBlur(() => {
    setTerminalFocused(false);
    setTypingFocused(false);
  });
  onMount(() => {
    focus("composer");
    const restoreAnchor = () => {
      if (pendingFocusReveal) {
        const control = pendingFocusReveal;
        pendingFocusReveal = undefined;
        if (renderer.currentFocusedRenderable === control) revealControl(control);
      }
      if (pendingReveal && transcript?.getRenderable(`message-${pendingReveal}`)) {
        transcript.scrollChildIntoView(`message-${pendingReveal}`);
        pendingReveal = undefined;
        pendingAnchor = undefined;
        setReveal(undefined);
      }
      if (!pendingAnchor || !transcript) return;
      const row = transcript.getRenderable(pendingAnchor.id);
      const offset = pendingAnchor.offset;
      pendingAnchor = undefined;
      if (row) transcript.scrollBy(row.y - transcript.viewport.y - offset);
    };
    renderer.on("frame", restoreAnchor);
    onCleanup(() => renderer.off("frame", restoreAnchor));
    const timer = setInterval(() => {
      if (!transcript || !active()) return;
      const bottom =
        transcript.scrollTop + transcript.viewport.height >= transcript.scrollHeight - 1;
      setAtBottom(bottom);
      const last = visibleMessages().at(-1)?.id;
      const key = `${active()!.id}:${terminalFocused()}:${bottom}:${last}:${modal()}:${timeline()?.atLatest}`;
      if (lastReport === key) return;
      lastReport = key;
      void run({
        type: "view.report",
        conversationId: active()!.id,
        focused: terminalFocused() && !modal(),
        atBottom: bottom && timeline()?.atLatest !== false,
        ...(bottom && timeline()?.atLatest !== false && last ? { lastVisibleMessageId: last } : {}),
      });
    }, 250);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(() => {
    const id = reveal();
    const mounted = visibleMessages();
    if (id && mounted.some((message) => message.id === id)) {
      pendingReveal = id;
      renderer.requestRender();
    }
  });
  const canRedact = (message: Message) => {
    const net = state().networks.find((item) => item.id === message.networkId);
    return (
      !!net &&
      net.phase === "ready" &&
      net.features.redaction &&
      !!message.serverId &&
      !message.redacted &&
      message.kind !== "event" &&
      activeId() === message.conversationId &&
      (message.source === "local" || message.sender.nick === net.nick)
    );
  };
  const redact = async () => {
    const message = messages().find((item) => item.id === selectedMessage()?.id);
    if (redacting() || !message || !canRedact(message)) {
      setStatus("This message can no longer be removed on this network.");
      return;
    }
    setRedacting(true);
    const result = await run({ type: "message.redact", messageId: message.id });
    setRedacting(false);
    if (result.ok) {
      closeModal();
      setStatus("Removal requested. Other clients or logs may still retain a copy.");
    }
  };
  const messageActions = () => {
    const selected = selectedMessage();
    const message = selected && (messages().find((item) => item.id === selected.id) ?? selected);
    if (!message) return null;
    const links = message.text.match(/https?:\/\/[^\s<>]+/gu) ?? [];
    return (
      <>
        <text fg={colors.muted}>
          {message.sender.nick} ·{" "}
          {new Date(message.serverTime ?? message.receivedAt).toLocaleString()}
        </text>
        <text selectable fg={colors.text}>
          {message.redacted ? "[message removed]" : message.text}
        </text>
        <Button
          id="copy-message"
          layer="modal"
          label="Copy message text"
          onPress={() => {
            void props.external
              .copyText(message.text, abort.signal)
              .then((result) => setStatus(result.ok ? "Copied." : result.error.message));
          }}
        />
        <Show when={network()?.features.replies && message.serverId && !message.redacted}>
          <Button
            id="reply-message"
            layer="modal"
            label="Reply to this message"
            onPress={() => {
              setReply(message.id);
              closeToComposer();
            }}
          />
        </Show>
        <Show when={network()?.features.reactions && message.serverId && !message.redacted}>
          <Button
            id="react-message"
            layer="modal"
            label="React +1"
            onPress={() => {
              void run({
                type: "message.react",
                messageId: message.id,
                value: "👍",
                remove: false,
              });
            }}
          />
        </Show>
        <Button
          id="message-whois"
          layer="modal"
          label={`Look up ${message.sender.nick}`}
          onPress={() => {
            void run({
              type: "irc.request",
              networkId: message.networkId,
              command: { type: "whois", nick: message.sender.nick },
            });
          }}
        />
        <Show when={canRedact(message)}>
          <Button
            id="redact-message"
            layer="modal"
            label="Remove my message…"
            onPress={() => {
              setSelectedMessage(message);
              openModal("redact");
            }}
          />
        </Show>
        <For each={links.slice(0, 8)}>
          {(url, index) => (
            <Button
              id={`url-${index()}`}
              layer="modal"
              label={`Open in browser: ${url}`}
              onPress={() => {
                void props.external
                  .openUrl(url, abort.signal)
                  .then((result) =>
                    setStatus(result.ok ? "Opened browser." : result.error.message),
                  );
              }}
            />
          )}
        </For>
        <text fg={colors.muted}>
          Opening a link shares it with your default browser. No automatic previews are fetched.
        </text>
      </>
    );
  };
  const showMembers = createMemo(
    () =>
      settings()?.tui.memberList === true &&
      active()?.kind === "channel" &&
      dimensions().width - sidebarWidth() >= 100,
  );
  const typingLabel = () => {
    const ids = timeline()?.typing ?? [];
    const nicks = ids
      .map((id) => timeline()?.members.find((member) => member.id === id)?.nick)
      .filter((nick): nick is string => !!nick);
    if (!nicks.length || nicks.length !== ids.length) return "Someone is typing…";
    if (nicks.length > 2) return "Several people are typing…";
    return `${nicks.join(" and ")} ${nicks.length === 1 ? "is" : "are"} typing…`;
  };
  const loadOlder = () => {
    if (active())
      void run({
        type: "history.load-older",
        conversationId: active()!.id,
        ...(timeline()?.olderCursor ? { cursor: timeline()!.olderCursor } : {}),
      });
  };
  const footerMessage = () =>
    status() ||
    [...operations()].reverse().find((operation) => operation.state === "failed")?.error?.message ||
    state().error?.message ||
    "";
  const footerHints = (): readonly (readonly [string, string])[] =>
    modal() === "switch"
      ? [
          ["↑↓", "select"],
          ["enter", "open"],
          ["esc", "close"],
        ]
      : modal() === "help" || modal() === "messages"
        ? [
            ["pgup pgdn", "scroll"],
            ["esc", "close"],
          ]
        : modal()
          ? [
              ["tab", "next"],
              ["enter", "choose"],
              ["esc", "close"],
            ]
          : [
              ["ctrl+k", "jump to…"],
              ["ctrl+f", "search"],
              ["f1", "help"],
              ["ctrl+q", "quit"],
            ];
  const paletteEntries = (): PaletteEntry[] => {
    const entries: PaletteEntry[] = state().conversations.map((item) => ({
      id: `switch-${item.id}`,
      label: item.name,
      group: "Conversations",
      ...(item.mentionCount
        ? { hint: `${item.mentionCount} mention${item.mentionCount === 1 ? "" : "s"}` }
        : item.unreadCount
          ? { hint: `${item.unreadCount} new` }
          : {}),
      run: () => activate(item.id),
    }));
    const now = (action: () => void) => () => {
      closeToComposer();
      action();
    };
    const conversation = active();
    entries.push(
      {
        id: "join",
        label: "Join a channel…",
        group: "Actions",
        hint: "ctrl+j",
        run: () => openModal("join"),
      },
      { id: "query", label: "Message someone…", group: "Actions", run: () => openModal("query") },
      {
        id: "search",
        label: "Search history…",
        group: "Actions",
        hint: "ctrl+f",
        run: () => {
          setResults([]);
          openModal("search");
        },
      },
    );
    if (conversation) {
      entries.push(
        {
          id: "message-picker",
          label: "Select a message…",
          group: conversation.name,
          run: () => openModal("messages"),
        },
        {
          id: "older",
          label: "Load older messages",
          group: conversation.name,
          run: now(loadOlder),
        },
        {
          id: "mute",
          label: conversation.muted ? `Unmute ${conversation.name}` : `Mute ${conversation.name}`,
          group: conversation.name,
          run: now(() => {
            void run({
              type: "conversation.mute",
              conversationId: conversation.id,
              muted: !conversation.muted,
            });
          }),
        },
        {
          id: "leave",
          label:
            conversation.kind === "channel"
              ? `Leave ${conversation.name}`
              : `Close ${conversation.name}`,
          group: conversation.name,
          run: now(() => {
            void run({ type: "conversation.close", conversationId: conversation.id });
          }),
        },
      );
      if (histServCount() > 0 || showHistServ())
        entries.push({
          id: "histserv-toggle",
          label: showHistServ() ? "Hide HistServ" : `Show HistServ (${histServCount()} hidden)`,
          group: conversation.name,
          run: now(() => void toggleHistServ()),
        });
    }
    for (const net of state().networks) {
      const ready = net.phase === "ready";
      entries.push({
        id: `connect-${net.id}`,
        label: `${net.phase === "disconnected" ? "Connect" : "Disconnect"} ${net.name}`,
        group: "Networks",
        run: now(() => {
          void run({
            type: net.phase === "disconnected" ? "network.connect" : "network.disconnect",
            networkId: net.id,
          });
        }),
      });
      if (ready)
        entries.push(
          {
            id: `browse-${net.id}`,
            label: `Browse channels on ${net.name}…`,
            group: "Networks",
            run: () => {
              void run({ type: "irc.request", networkId: net.id, command: { type: "list" } });
            },
          },
          {
            id: `people-${net.id}`,
            label: `Look up a person on ${net.name}…`,
            group: "Networks",
            run: () => {
              setDiscoveryNetwork(net.id);
              setRequestedNick("");
              openModal("whois");
            },
          },
        );
    }
    entries.push(
      {
        id: "add-network",
        label: "Add a network…",
        group: "Networks",
        run: () => openModal("settings"),
      },
      {
        id: "settings",
        label: "Settings",
        group: "OpenIRC",
        hint: "ctrl+,",
        run: () => openModal("settings"),
      },
      {
        id: "help",
        label: "Help: keys and commands",
        group: "OpenIRC",
        hint: "f1",
        run: () => {
          setHelpCommand(undefined);
          openModal("help");
        },
      },
      { id: "quit", label: "Quit", group: "OpenIRC", hint: "ctrl+q", run: () => openModal("quit") },
    );
    return entries;
  };
  const filteredPalette = createMemo(() => {
    const query = formText().trim().toLowerCase();
    const entries = modal() === "switch" ? paletteEntries() : [];
    return query
      ? entries.filter((entry) => `${entry.label} ${entry.group}`.toLowerCase().includes(query))
      : entries;
  });
  createEffect(() => {
    formText();
    setPaletteIndex(0);
  });
  createEffect(() => {
    const value = status();
    if (!value) return;
    // Transient feedback: fade back to the key legend once read.
    const timer = setTimeout(() => {
      if (status() === value) setStatus("");
    }, 8000);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <FocusContext.Provider
      value={{
        current: focusId,
        active: (layer) => layer === (modal() ? "modal" : "main"),
        set: focus,
        register(id, layer, control) {
          controls.set(id, { layer, control });
          return () => {
            if (controls.get(id)?.control === control) controls.delete(id);
          };
        },
      }}
    >
      <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.bg}>
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <scrollbox
            id="sidebar"
            width={sidebarWidth()}
            flexShrink={0}
            backgroundColor={colors.panel}
            contentOptions={{ flexDirection: "column", paddingTop: 1, paddingX: 1 }}
            scrollX={false}
          >
            <box height={2} flexShrink={0} paddingX={1}>
              <text height={1} wrapMode="none" truncate fg={colors.accent}>
                <b>openirc</b>
              </text>
            </box>
            <For each={state().networks}>
              {(net) => {
                const conversations = (kind: "channel" | "direct" | "status") =>
                  state().conversations.filter(
                    (item) => item.networkId === net.id && item.kind === kind,
                  );
                const status = () => conversations("status")[0];
                return (
                  <box flexDirection="column" flexShrink={0} paddingBottom={1}>
                    <ListItem
                      id={status() ? `conversation-${status()!.id}` : `network-${net.id}`}
                      prefix="●"
                      prefixColor={phaseColor(net.phase)}
                      label={net.name}
                      strong
                      {...(net.phase !== "ready"
                        ? { hint: phaseLabel(net.phase) }
                        : net.secure
                          ? {}
                          : { hint: "plaintext" })}
                      active={!!status() && active()?.id === status()!.id}
                      onPress={() => {
                        if (status()) activate(status()!.id);
                        else openModal("switch");
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
                            <text fg={colors.muted}>
                              {kind === "channel" ? "CHANNELS" : "DIRECT"}
                            </text>
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
                                active={active()?.id === conversation.id}
                                onPress={() => activate(conversation.id)}
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
          <box flexGrow={1} minWidth={0} flexDirection="column">
            <box
              id="conversation-header"
              height={2}
              flexShrink={0}
              paddingX={2}
              flexDirection="row"
              border={["bottom"]}
              borderColor={colors.border}
            >
              <text flexGrow={1} minWidth={0} height={1} wrapMode="none" truncate>
                <b>
                  <span style={{ fg: colors.text }}>{active()?.name ?? "Welcome to OpenIRC"}</span>
                </b>
                <span style={{ fg: colors.muted }}>
                  {"  "}
                  {active()?.kind === "direct"
                    ? "Nicknames can be reused. Verify accounts."
                    : active()?.kind === "status"
                      ? [
                          ["registering", "authenticating", "ready"].includes(
                            network()?.phase ?? "",
                          )
                            ? network()?.secure
                              ? "TLS"
                              : "plaintext"
                            : "",
                          phaseLabel(network()?.phase ?? "disconnected"),
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : active()?.topic || ""}
                </span>
              </text>
              <Show
                when={active()?.kind === "channel" && timeline()?.members.length && !showMembers()}
              >
                <text flexShrink={0} height={1} fg={colors.muted}>
                  {"  "}
                  {timeline()!.members.length}{" "}
                  {timeline()!.members.length === 1 ? "person" : "people"}
                </text>
              </Show>
            </box>
            <Show
              when={active()}
              fallback={
                <box flexGrow={1} paddingX={2} paddingTop={1} flexDirection="column" gap={1}>
                  <text fg={colors.accent}>
                    <b>Your next conversation starts here.</b>
                  </text>
                  <text fg={colors.text}>1. Add your IRC network.</text>
                  <text fg={colors.text}>2. Connect to it.</text>
                  <text fg={colors.text}>3. Join a channel or message a nickname.</text>
                  <text fg={colors.muted}>
                    Local history is {settings()?.user.history.enabled ? "enabled" : "disabled"}.
                    {settings()?.user.history.enabled
                      ? ` Messages are retained ${settings()?.user.history.retentionDays === null ? "indefinitely" : `for ${settings()?.user.history.retentionDays} days`}.`
                      : ""}{" "}
                    Review privacy in Settings before connecting.
                  </text>
                  <Button
                    id="welcome-setup"
                    label="Set up a network"
                    onPress={() => openModal("settings")}
                  />
                </box>
              }
            >
              <box flexDirection="row" flexGrow={1} minHeight={0}>
                <box flexGrow={1} minWidth={0} flexDirection="column">
                  <box id="transcript-frame" flexGrow={1} minHeight={0} flexDirection="column">
                    <scrollbox
                      id="transcript"
                      ref={(element) => (transcript = element)}
                      flexGrow={1}
                      minHeight={0}
                      scrollX={false}
                      stickyScroll
                      stickyStart="bottom"
                      contentOptions={{
                        flexDirection: "column",
                        // The scrollbar overlays the final cell; keep wrapped text clear of it.
                        paddingRight: 1,
                        gap: settings()?.tui.density === "compact" ? 0 : 1,
                      }}
                    >
                      <box flexDirection="row" flexShrink={0} paddingLeft={gutterWidth() + 1}>
                        <Button
                          id="older"
                          quiet
                          label={
                            timeline()?.loadingOlder
                              ? "loading older messages…"
                              : "↑ load older messages"
                          }
                          disabled={!!timeline()?.loadingOlder}
                          onPress={loadOlder}
                        />
                      </box>
                      <Show when={(timeline()?.messages.length ?? 0) > 300}>
                        <box paddingLeft={gutterWidth() + 2}>
                          <text fg={colors.muted}>
                            Showing the latest 300 messages to keep terminal layout bounded. Use
                            Search to reveal older context.
                          </text>
                        </box>
                      </Show>
                      <Show when={messages().length > 0 && visibleMessages().length === 0}>
                        <box paddingLeft={gutterWidth() + 2}>
                          <text wrapMode="word" fg={colors.muted}>
                            Only HistServ entries are loaded. Load older for chat.
                          </text>
                        </box>
                      </Show>
                      <For each={visibleMessages()}>
                        {(message, index) => {
                          const previous = () => visibleMessages()[index() - 1];
                          const unread = () => timeline()?.firstUnreadId === message.id;
                          return (
                            <MessageRow
                              message={message}
                              gutterWidth={gutterWidth()}
                              firstUnread={unread()}
                              continuation={
                                !unread() &&
                                continuesGroup(
                                  previous() && { ...previous()!, at: messageTime(previous()!) },
                                  { ...message, at: messageTime(message) },
                                )
                              }
                              {...(previous() &&
                              dayKey(messageTime(previous()!)) !== dayKey(messageTime(message))
                                ? { dayLabel: `── ${formatDay(messageTime(message))} ──` }
                                : {})}
                              onSelect={() => {
                                setSelectedMessage(message);
                                openModal("message");
                              }}
                            />
                          );
                        }}
                      </For>
                    </scrollbox>
                    <box
                      id="transcript-divider"
                      position="absolute"
                      left={gutterWidth()}
                      top={0}
                      width={1}
                      height="100%"
                      border={["left"]}
                      borderColor={colors.border}
                      zIndex={1}
                    />
                  </box>
                  <Show when={timeline()?.typing.length}>
                    <box height={1} flexShrink={0} paddingX={2}>
                      <text height={1} wrapMode="none" truncate fg={colors.muted}>
                        {typingLabel()}
                      </text>
                    </box>
                  </Show>
                  <Show when={reply()}>
                    <box height={1} flexShrink={0} paddingX={2}>
                      <text height={1} fg={colors.accent}>
                        ↳ Replying to a message · esc to cancel
                      </text>
                    </box>
                  </Show>
                  <box
                    id="composer-panel"
                    height={composerRows() + 2}
                    flexShrink={0}
                    marginX={1}
                    paddingX={1}
                    flexDirection="row"
                    border
                    borderStyle="rounded"
                    borderColor={
                      !modal() && focusId() === "composer" ? colors.accent : colors.border
                    }
                    {...(literalDraft() ? { title: " pasted text sends literally " } : {})}
                  >
                    <text width={2} flexShrink={0} fg={colors.accent}>
                      ›
                    </text>
                    <textarea
                      ref={(element) => {
                        composer = element;
                        controls.set("composer", { layer: "main", control: element });
                        onCleanup(() => {
                          if (composer === element) {
                            composer = undefined;
                            controls.delete("composer");
                          }
                        });
                      }}
                      height={composerRows()}
                      flexGrow={1}
                      minWidth={0}
                      focused={!modal() && focusId() === "composer"}
                      onMouseDown={() => focus("composer")}
                      initialValue={untrack(() => timeline()?.draft ?? "")}
                      placeholder={`Message ${active()?.name ?? ""}`}
                      wrapMode="word"
                      backgroundColor={colors.bg}
                      focusedBackgroundColor={colors.bg}
                      textColor={colors.text}
                      onContentChange={syncDraft}
                      keyBindings={[
                        { name: "return", action: "submit" },
                        { name: "return", shift: true, action: "newline" },
                      ]}
                      onSubmit={() => void send()}
                    />
                  </box>
                </box>
                <Show when={showMembers()}>
                  <scrollbox
                    id="members"
                    width={22}
                    flexShrink={0}
                    border={["left"]}
                    borderColor={colors.border}
                    contentOptions={{ flexDirection: "column", paddingX: 1 }}
                    scrollX={false}
                  >
                    <text height={1} flexShrink={0} fg={colors.muted}>
                      PEOPLE · {timeline()?.members.length ?? 0}
                    </text>
                    <For each={(timeline()?.members ?? []).slice(0, 200)}>
                      {(member) => (
                        <text
                          height={1}
                          flexShrink={0}
                          wrapMode="none"
                          truncate
                          fg={member.away ? colors.muted : nicknameColor(member.nick, theme())}
                        >
                          {member.prefixes[0] ?? " "}
                          {member.nick}
                        </text>
                      )}
                    </For>
                  </scrollbox>
                </Show>
              </box>
            </Show>
          </box>
        </box>
        <box
          id="status-bar"
          height={1}
          flexShrink={0}
          paddingX={2}
          flexDirection="row"
          backgroundColor={colors.panel}
        >
          <box flexGrow={1} minWidth={0}>
            <Show when={footerMessage()} fallback={<KeyHints hints={footerHints()} />}>
              <text height={1} wrapMode="none" truncate fg={colors.error}>
                {footerMessage()}
              </text>
            </Show>
          </box>
          <Show when={!atBottom() || timeline()?.atLatest === false}>
            <Button id="latest" quiet label="↓ latest" onPress={() => void jumpLatest()} />
          </Show>
          <Show when={network()}>
            <text flexShrink={0} height={1} fg={colors.muted}>
              {"  "}
              {network()!.nick}
              <span style={{ fg: phaseColor(network()!.phase) }}> ●</span>
            </text>
          </Show>
        </box>
        <Show when={modal()}>
          <Dialog
            title={
              modal() === "settings"
                ? "Settings · Add network"
                : modal() === "paste"
                  ? "Review paste — nothing has been sent"
                  : modal() === "message"
                    ? "Message actions"
                    : modal() === "quit"
                      ? "Disconnect and quit?"
                      : modal() === "switch"
                        ? "Jump to…"
                        : modal() === "redact"
                          ? "Remove message"
                          : modal() === "whois"
                            ? "Look up a person"
                            : modal() === "messages"
                              ? "Select a message"
                              : modal() === "query"
                                ? "Message someone"
                                : `${modal()!.charAt(0).toUpperCase()}${modal()!.slice(1)}`
            }
            compact={["switch", "join", "query", "quit", "redact"].includes(modal() ?? "")}
            width={dimensions().width}
            height={dimensions().height}
            onClose={closeModal}
          >
            <Show when={modal() === "settings"}>
              <Show
                when={settings()}
                fallback={
                  <text fg={colors.error}>
                    Settings are unavailable. Check the startup error before adding a network.
                  </text>
                }
              >
                <SettingsForm
                  app={props.app}
                  document={settings()!}
                  signal={abort.signal}
                  focus={(id) => {
                    returnFocus = id;
                    closeModal();
                  }}
                  status={setStatus}
                />
              </Show>
            </Show>
            <Show when={modal() === "help"}>
              <Show when={!helpCommand()}>
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
                        <text fg={colors.muted} wrapMode="none" truncate>
                          {description}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
              <box flexDirection="column" flexShrink={0}>
                <text fg={colors.accent}>
                  <b>Commands</b>
                </text>
                <For each={props.commands.help(helpCommand())}>
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
            </Show>
            <Show when={modal() === "join" || modal() === "query"}>
              <text fg={colors.muted}>
                Network: {network()?.name ?? "add a network in Settings first"}
              </text>
              <Field
                id="dialog-input"
                label={modal() === "join" ? "Channel name" : "Nickname"}
                value={formText()}
                onInput={setFormText}
                placeholder={modal() === "join" ? "#welcome" : "nickname"}
              />
              <Button
                id="target-submit"
                layer="modal"
                label={modal() === "join" ? "Join channel" : "Start conversation"}
                onPress={() => void submitTarget()}
              />
            </Show>
            <Show when={modal() === "switch"}>
              <Field
                id="dialog-input"
                label="Filter"
                hideLabel
                placeholder="Type a channel, person, or action…"
                value={formText()}
                onInput={setFormText}
              />
              <box flexDirection="column" flexShrink={0}>
                <For each={filteredPalette()}>
                  {(entry, index) => (
                    <>
                      <Show when={filteredPalette()[index() - 1]?.group !== entry.group}>
                        <box height={1} flexShrink={0} paddingX={1} marginTop={index() ? 1 : 0}>
                          <text fg={colors.muted}>{entry.group}</text>
                        </box>
                      </Show>
                      <ListItem
                        id={entry.id}
                        layer="modal"
                        label={entry.label}
                        {...(entry.hint ? { hint: entry.hint } : {})}
                        active={index() === paletteIndex()}
                        onPress={entry.run}
                      />
                    </>
                  )}
                </For>
                <Show when={!filteredPalette().length}>
                  <text fg={colors.muted}>Nothing matches. Try /join or /msg in the composer.</text>
                </Show>
              </box>
            </Show>
            <Show when={modal() === "search"}>
              <Field
                id="dialog-input"
                label="Search local history (all conversations)"
                value={formText()}
                onInput={setFormText}
              />
              <Button
                id="search-submit"
                layer="modal"
                label={searching() ? "Searching…" : "Search"}
                disabled={searching()}
                onPress={() => void search()}
              />
              <text fg={colors.muted}>Up to 50 results. Select one to reveal context.</text>
              <For each={results()}>
                {(message) => (
                  <Button
                    id={`result-${message.id}`}
                    layer="modal"
                    label={`${message.sender.nick}: ${message.text}`}
                    onPress={() => {
                      void run({ type: "history.reveal", messageId: message.id }).then((result) => {
                        if (result.ok) {
                          if (isHistServMessage(message)) setRevealHistServ(true);
                          setReveal(message.id);
                          closeToComposer();
                        }
                      });
                    }}
                  />
                )}
              </For>
            </Show>
            <Show when={modal() === "paste"}>
              <text fg={colors.muted}>
                This paste will be inserted into the draft as literal text, not executed as slash
                commands. You must still press Send.
              </text>
              <text selectable fg={colors.text}>
                {paste().slice(0, 4_000)}
                {paste().length > 4_000 ? "\n[preview truncated]" : ""}
              </text>
              <Button
                id="paste-insert"
                layer="modal"
                label="Insert into draft (do not send)"
                onPress={insertPaste}
              />
            </Show>
            <Show when={(modal() === "directory" || modal() === "whois") && discoveryNetwork()}>
              <DiscoveryPanel
                app={props.app}
                networkId={discoveryNetwork()!}
                networkName={
                  state().networks.find((item) => item.id === discoveryNetwork())?.name ??
                  "Selected network"
                }
                mode={modal() === "directory" ? "directory" : "whois"}
                requestedNick={requestedNick()}
                dispatch={async (action) => (await run(action)).ok}
                close={closeToComposer}
              />
            </Show>
            <Show when={modal() === "messages"}>
              <text fg={colors.muted}>
                Select a message for copy, person details, or supported reply/reaction/removal
                actions.
              </text>
              <For each={visibleMessages()}>
                {(message) => (
                  <Button
                    id={`pick-${message.id}`}
                    layer="modal"
                    label={`${message.sender.nick}: ${message.redacted ? "[message removed]" : message.text.slice(0, 100)}`}
                    onPress={() => {
                      setSelectedMessage(message);
                      openModal("message");
                    }}
                  />
                )}
              </For>
            </Show>
            <Show when={modal() === "message"}>{messageActions()}</Show>
            <Show when={modal() === "redact"}>
              <text fg={colors.error}>
                Remove your message from this conversation? This cannot be undone. Other clients,
                server history, exports, or logs may still retain a copy.
              </text>
              <Button
                id="redact-confirm"
                layer="modal"
                label={redacting() ? "Requesting removal…" : "Yes, remove my message"}
                disabled={
                  redacting() ||
                  !messages().some(
                    (message) => message.id === selectedMessage()?.id && canRedact(message),
                  )
                }
                onPress={() => void redact()}
              />
              <Button id="redact-cancel" layer="modal" label="Keep message" onPress={closeModal} />
            </Show>
            <Show when={modal() === "quit"}>
              <text fg={colors.text}>
                OpenIRC will close its connections and flush local history. It does not remain
                connected in the background.
              </text>
              <Button
                id="quit-confirm"
                layer="modal"
                label="Disconnect and quit"
                onPress={() => void quit()}
              />
            </Show>
            <Show when={status()}>
              <text fg={colors.error}>{status()}</text>
            </Show>
          </Dialog>
        </Show>
      </box>
    </FocusContext.Provider>
  );
}
