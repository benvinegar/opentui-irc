/* oxlint-disable no-control-regex -- Explicit terminal control rejection is a security boundary. */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  onBlur,
  onFocus,
  onResize,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import {
  ScrollBoxRenderable,
  type Renderable,
  type Selection,
  type TextareaRenderable,
} from "@opentui/core";
import type { AppAction, AppApi } from "../contracts/app";
import type { ConversationId, MessageId, NetworkId } from "../contracts/common";
import type { Message, TimelineSnapshot } from "../contracts/model";
import type { DiscoverySnapshot } from "../contracts/discovery";
import type {
  CommandService,
  Completion,
  ExternalActions,
  InputContext,
} from "../contracts/services";
import { useReadable } from "./bridge";
import { Dialog, FocusContext, Splitter, ThemeContext, usePalette } from "./primitives";
import { SettingsForm } from "./settings";
import {
  CommandPalette,
  MessagePicker,
  PasteReview,
  QuitConfirm,
  RedactConfirm,
  SearchPanel,
  TargetForm,
  type PaletteEntry,
} from "./dialogs";
import { MessageMenu, PersonCard, REACTIONS, type MenuEntry, type MenuPage } from "./popovers";
import {
  ConversationHeader,
  HelpPanel,
  MemberList,
  Sidebar,
  StatusBar,
  Welcome,
} from "./shell-panels";
import { DiscoveryPanel } from "./discovery";
import { createTypingReporter } from "./typing";
import { keyStep, runKeyBinding, type KeyBinding, type KeyPress } from "./keys";
import {
  conversationSubtitle,
  compactDialog,
  dialogTitle,
  footerHints,
  messageTime,
  memberRole,
  modalFocusTarget,
  personCardLines,
  typingLabel,
  type Modal,
} from "./shell-labels";
import { formatMessageTime, transcriptGutterWidth } from "./transcript-style";
import { Composer, Transcript } from "./conversation";
import { isHistServMessage } from "../contracts/presentation";

export interface UiOptions {
  readonly app: AppApi;
  readonly commands: CommandService;
  readonly external: ExternalActions;
  readonly onQuit?: () => void | Promise<void>;
}
const cleanPaste = (value: string) =>
  value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");

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
  // Many terminals report focus only on change (or never), so start unknown/conservative and
  // treat real keyboard/mouse input as evidence that the user is looking at this client.
  const [terminalFocused, setTerminalFocused] = createSignal(false);
  const noteAttention = () => setTerminalFocused(true);
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
  const truncatedWindow = () => (timeline()?.messages.length ?? 0) > 300;
  const onlyHistServ = () => messages().length > 0 && visibleMessages().length === 0;
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
  // Live widths while a divider is dragged; persisted to tui settings on release.
  const [dragWidths, setDragWidths] = createSignal<{
    sidebar?: number;
    members?: number;
    author?: number;
  }>({});
  const sidebarWidth = createMemo(() => {
    const dragged = dragWidths().sidebar;
    const preferred = dragged ?? settings()?.tui.sidebarWidth ?? 26;
    const cap = Math.max(12, Math.floor(dimensions().width * 0.45));
    // Small terminals shrink the saved width unless the user is resizing right now.
    const fit =
      dragged !== undefined
        ? preferred
        : dimensions().width < 65
          ? Math.min(16, preferred)
          : dimensions().width < 100
            ? Math.min(20, preferred)
            : preferred;
    return Math.max(12, Math.min(cap, fit));
  });
  const memberWidth = createMemo(() =>
    Math.max(
      12,
      Math.min(
        60,
        Math.floor(dimensions().width * 0.4),
        dragWidths().members ?? settings()?.tui.memberListWidth ?? 22,
      ),
    ),
  );
  const [resizing, setResizing] = createSignal<"sidebar" | "members" | "author">();
  let transcriptFrame: Renderable | undefined;
  const followResize = (x: number) => {
    const target = resizing();
    if (target === "sidebar")
      setDragWidths((widths) => ({ ...widths, sidebar: Math.min(80, Math.max(12, x)) }));
    else if (target === "members")
      setDragWidths((widths) => ({
        ...widths,
        members: Math.min(60, Math.max(12, dimensions().width - x - 1)),
      }));
    else if (target === "author" && transcriptFrame)
      setDragWidths((widths) => ({
        ...widths,
        author: Math.min(40, Math.max(8, x - transcriptFrame!.x)),
      }));
  };
  const finishResize = () => {
    const target = resizing();
    if (!target) return;
    ignoreClicksUntil = Date.now() + 300;
    setResizing(undefined);
    if (target === "sidebar") void saveWidth("sidebarWidth", sidebarWidth());
    else if (target === "members") void saveWidth("memberListWidth", memberWidth());
    else void saveWidth("authorColumnWidth", gutterWidth());
  };
  const saveWidth = async (
    key: "sidebarWidth" | "memberListWidth" | "authorColumnWidth",
    value: number,
  ) => {
    const document = settings();
    if (!document || document.tui[key] === value) {
      setDragWidths({});
      return;
    }
    const result = await props.app.saveSettings(
      { section: "tui", value: { ...document.tui, [key]: value } },
      document.revision,
      abort.signal,
    );
    if (!result.ok) setStatus(result.error.message);
    setDragWidths({});
  };
  const gutterWidth = createMemo(() => {
    const available = dimensions().width - sidebarWidth();
    const chosen = dragWidths().author ?? settings()?.tui.authorColumnWidth;
    // A dragged or saved width wins, but never takes more than half the conversation.
    if (chosen !== undefined && chosen !== null)
      return Math.max(8, Math.min(chosen, Math.floor(available / 2)));
    return transcriptGutterWidth(
      available,
      Math.max(0, ...visibleMessages().map((message) => Bun.stringWidth(message.sender.nick))),
    );
  });
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
  // Dialog presses and divider drags end with a mouse-up on whatever lies beneath; ignore it.
  let ignoreClicksUntil = 0;
  const clicksBlocked = () => !!modal() || !!resizing() || Date.now() < ignoreClicksUntil;
  const closeModal = () => {
    ignoreClicksUntil = Date.now() + 300;
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
    queueMicrotask(() => focus(modalFocusTarget(value)));
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
    report: (conversationId, state) => {
      void run({
        type: "typing.set",
        conversationId,
        active: state === "active",
        ...(state === "paused" ? { paused: true } : {}),
      });
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
  /** Literal drafts (pastes, recalled pastes) are messages even when they start with "/". */
  const parseDraft = (text: string, conversationId: ConversationId) =>
    literalDraft()
      ? {
          ok: true as const,
          value: {
            type: "action" as const,
            action: { type: "message.send" as const, conversationId, text, kind: "text" as const },
          },
        }
      : props.commands.parse(text, context());
  /** Bounded per-conversation recall for ctrl+↑↓. */
  const rememberSent = (conversationId: ConversationId, text: string) => {
    const previous = histories.get(conversationId) ?? [];
    histories.set(conversationId, [...previous.slice(-49), { text, literal: literalDraft() }]);
    if (histories.size > 32) {
      const oldest = histories.keys().next().value;
      if (oldest) histories.delete(oldest);
    }
    historyIndex = 0;
  };
  const sendAction = async (action: AppAction, conversationId: ConversationId, text: string) => {
    typing.stop();
    sendBusy = true;
    const replyTo = reply();
    const result = await run(
      action.type === "message.send" && replyTo ? { ...action, replyTo } : action,
    );
    sendBusy = false;
    if (!result.ok) return;
    if (action.type === "message.send") typing.messageSent(conversationId);
    rememberSent(conversationId, text);
    // Do not erase edits made while the acceptance promise was pending.
    if (active()?.id === conversationId && composer?.plainText === text) {
      composer.clear();
      void run({ type: "draft.set", conversationId, text: "" });
      setLiteralDraft(false);
      literalConversations.delete(conversationId);
      setReply(undefined);
    }
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
    const intent = parseDraft(text, conversationId);
    if (!intent.ok) {
      setStatus(intent.error.message);
      return;
    }
    switch (intent.value.type) {
      case "action":
        await sendAction(intent.value.action, conversationId, text);
        break;
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
  const openHelp = () => {
    setHelpCommand(undefined);
    openModal("help");
  };
  const openSearch = () => {
    setResults([]);
    openModal("search");
  };
  /** Esc backs out of a submenu, closes a modal, or cancels a reply. */
  const dismiss = () => {
    if (modal() === "message" && menuPage() !== "main") choose("main", "copy-message");
    else if (modal()) closeModal();
    else {
      setReply(undefined);
      focus("composer");
    }
  };
  const cycleFocus = (step: -1 | 1) => {
    const ids = orderedControls(modal() ? "modal" : "main");
    const current = ids.indexOf(focusId());
    const next = ids[(current + step + ids.length) % ids.length];
    if (next) focus(next);
  };
  /** Arrow keys walk dialog lists; single-line fields have no vertical cursor movement. */
  const walkDialog = (step: -1 | 1) => {
    const ids = orderedControls("modal").filter((id) => id !== "dialog-close");
    const current = ids.indexOf(focusId());
    const next = ids[current < 0 ? 0 : (current + step + ids.length) % ids.length];
    if (next) focus(next);
  };
  const scrollModal = (step: -1 | 1) => {
    pendingFocusReveal = undefined;
    const viewport = renderer.root.findDescendantById("modal-scroll");
    if (viewport instanceof ScrollBoxRenderable) viewport.scrollBy(step, "viewport");
  };
  const movePaletteSelection = (step: -1 | 1) => {
    const count = filteredPalette().length;
    if (count) setPaletteIndex((index) => (index + step + count) % count);
    const target = renderer.root.findDescendantById(filteredPalette()[paletteIndex()]?.id ?? "");
    if (target) revealControl(target);
  };
  const submitDialogInput = () => {
    if (modal() === "search") void search();
    else if (modal() === "join" || modal() === "query") void submitTarget();
    else if (modal() === "switch") filteredPalette()[paletteIndex()]?.run();
  };
  /** Popover letters run their entry; on the react page, 1–6 pick a reaction. */
  const runPopoverShortcut = (event: KeyPress) => {
    const reaction =
      modal() === "message" && menuPage() === "react" && /^[1-6]$/u.test(event.name)
        ? REACTIONS[Number(event.name) - 1]
        : undefined;
    const shortcut =
      popoverOpen() && !event.ctrl && !event.meta
        ? (modal() === "person" ? personMenu() : messageMenu()).find(
            (entry) => entry.key === event.name,
          )
        : undefined;
    if (!reaction && !shortcut) return false;
    event.preventDefault();
    if (reaction) react(reaction);
    else shortcut!.run();
    return true;
  };
  const activateNeighbour = (step: -1 | 1) => {
    const all = state().conversations;
    const index = all.findIndex((item) => item.id === active()?.id);
    const next = all[(index + step + all.length) % all.length];
    if (next) activate(next.id);
  };
  /** Ctrl+↑ steps back through messages sent here; the unsent draft is restored at the end. */
  const recallHistory = (step: -1 | 1) => {
    const conversation = active();
    if (!composer || !conversation) return;
    const items = histories.get(conversation.id) ?? [];
    if (!items.length) return;
    if (historyIndex === 0) {
      historyDraft = composer.plainText;
      historyLiteralDraft = literalDraft();
    }
    historyIndex = Math.min(items.length, Math.max(0, historyIndex + step));
    const item = historyIndex ? items[items.length - historyIndex] : undefined;
    composer.replaceText(item ? item.text : historyDraft);
    setLiteralDraft(item ? item.literal : historyLiteralDraft);
    if (literalDraft()) literalConversations.add(conversation.id);
    else literalConversations.delete(conversation.id);
    composer.gotoBufferEnd();
    syncDraft();
  };
  // Binding tables run in order; the first match wins and consumes the key.
  const globalKeys: readonly KeyBinding[] = [
    { name: ["q", "c"], ctrl: true, run: () => openModal("quit") },
    { name: ["escape"], run: dismiss },
    {
      name: ["tab"],
      run: (event) => {
        if (!modal() && focusId() === "composer" && !event.shift) complete();
        else cycleFocus(event.shift ? -1 : 1);
      },
    },
  ];
  const modalKeys: readonly KeyBinding[] = [
    { name: ["pageup", "pagedown"], run: (event) => scrollModal(keyStep(event.name)) },
    {
      name: ["up", "down"],
      when: () => modal() === "switch" && focusId() === "dialog-input",
      run: (event) => movePaletteSelection(keyStep(event.name)),
    },
    {
      name: ["up", "down"],
      when: () => modal() !== "settings",
      run: (event) => walkDialog(keyStep(event.name)),
    },
    {
      name: ["left", "right"],
      when: () => popoverOpen(),
      run: (event) => walkDialog(keyStep(event.name)),
    },
    { name: ["return"], when: () => focusId() === "dialog-input", run: submitDialogInput },
  ];
  const mainKeys: readonly KeyBinding[] = [
    { name: ["f1"], run: openHelp },
    { name: ["k", "p"], ctrl: true, run: () => openModal("switch") },
    { name: ["f"], ctrl: true, run: openSearch },
    { name: ["j"], ctrl: true, run: () => openModal("join") },
    { name: [","], ctrl: true, run: () => openModal("settings") },
    { name: ["up", "down"], meta: true, run: (event) => activateNeighbour(keyStep(event.name)) },
    {
      name: ["pageup", "pagedown"],
      run: (event) => transcript?.scrollBy(keyStep(event.name), "viewport"),
    },
    { name: ["end"], ctrl: true, run: () => void jumpLatest() },
    {
      name: ["up", "down"],
      ctrl: true,
      when: () => !!composer && !!active(),
      // Up recalls older messages.
      run: (event) => recallHistory(event.name === "up" ? 1 : -1),
    },
  ];
  useKeyboard((event) => {
    noteAttention();
    if (runKeyBinding(event, globalKeys)) return;
    if (!modal()) {
      runKeyBinding(event, mainKeys);
      return;
    }
    // Keys never reach the main layer behind a modal.
    if (controls.get(focusId())?.layer !== "modal") {
      event.preventDefault();
      return;
    }
    if (!runPopoverShortcut(event)) runKeyBinding(event, modalKeys);
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
    // Drag-selecting text copies it on release; a plain click opens the message menu.
    const copySelection = (selection: Selection | null) => {
      const text = selection?.getSelectedText() ?? "";
      if (!text.trim() || modal()) return;
      void props.external
        .copyText(text, abort.signal)
        .then((result) =>
          setStatus(
            result.ok
              ? `Copied ${[...text].length} character${[...text].length === 1 ? "" : "s"}.`
              : result.error.message,
          ),
        );
    };
    renderer.on("selection", copySelection);
    onCleanup(() => renderer.off("selection", copySelection));
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
  // Message menu and person card: small popovers anchored where they were opened.
  const [anchor, setAnchor] = createSignal({ x: 0, y: 0 });
  const [menuPage, setMenuPage] = createSignal<MenuPage>("main");
  const [person, setPerson] = createSignal<{ networkId: NetworkId; nick: string }>();
  const [personInfo, setPersonInfo] = createSignal<DiscoverySnapshot["user"]>();
  const popoverOpen = () => modal() === "message" || modal() === "person";
  /** Keyboard openings anchor beside the message's nickname, or mid-screen when it is hidden. */
  const anchorFor = (message: Message) => {
    const nick = renderer.root.findDescendantById(`nick-${message.id}`);
    const frame = renderer.root.findDescendantById("transcript-frame");
    if (nick && frame && nick.y >= frame.y && nick.y < frame.y + frame.height)
      return { x: frame.x + gutterWidth() + 2, y: nick.y };
    return {
      x: Math.floor(dimensions().width / 2) - 14,
      y: Math.floor(dimensions().height / 3),
    };
  };
  const openMessageMenu = (message: Message, point?: { x: number; y: number }) => {
    setSelectedMessage(message);
    setMenuPage("main");
    setAnchor(point ?? anchorFor(message));
    openModal("message");
  };
  const openPerson = (networkId: NetworkId, nick: string, point: { x: number; y: number }) => {
    setPerson({ networkId, nick });
    setAnchor(point);
    openModal("person");
    if (state().networks.find((item) => item.id === networkId)?.phase === "ready")
      void props.app.dispatch(
        { type: "irc.request", networkId, command: { type: "whois", nick } },
        abort.signal,
      );
  };
  createEffect(() => {
    const target = person();
    if (!target || modal() !== "person") return;
    const model = props.app.discovery(target.networkId);
    setPersonInfo(undefined);
    if (!model.ok) return;
    const read = () => setPersonInfo(model.value.getSnapshot().user);
    read();
    onCleanup(model.value.subscribe(read));
  });
  const choose = (page: MenuPage, first: string) => {
    setMenuPage(page);
    queueMicrotask(() => focus(first));
  };
  const finish = (message?: string) => {
    closeToComposer();
    if (message) setStatus(message);
  };
  const currentMessage = () => {
    const selected = selectedMessage();
    return selected && (messages().find((item) => item.id === selected.id) ?? selected);
  };
  const messageLinks = () => currentMessage()?.text.match(/https?:\/\/[^\s<>]+/gu) ?? [];
  const openLink = (url: string) => {
    void props.external
      .openUrl(url, abort.signal)
      .then((result) => finish(result.ok ? "Opened browser." : result.error.message));
  };
  const messageMenu = createMemo((): readonly MenuEntry[] => {
    const message = currentMessage();
    if (!message) return [];
    const links = messageLinks();
    if (menuPage() === "links")
      return links.slice(0, 9).map((url, index) => ({
        id: `url-${index}`,
        icon: "↗",
        label: url,
        key: String(index + 1),
        run: () => openLink(url),
      }));
    const live = !!message.serverId && !message.redacted;
    const entries: MenuEntry[] = [
      {
        id: "copy-message",
        icon: "□",
        label: "Copy text",
        key: "c",
        run: () => {
          void props.external
            .copyText(message.text, abort.signal)
            .then((result) => finish(result.ok ? "Copied." : result.error.message));
        },
      },
    ];
    if (network()?.features.replies && live)
      entries.push({
        id: "reply-message",
        icon: "↩",
        label: "Reply",
        key: "r",
        run: () => {
          setReply(message.id);
          closeToComposer();
        },
      });
    if (network()?.features.reactions && live)
      entries.push({
        id: "react-message",
        icon: "♥",
        label: "React",
        key: "e",
        more: true,
        run: () => choose("react", "react-0"),
      });
    if (links.length === 1)
      entries.push({
        id: "url-0",
        icon: "↗",
        label: "Open link",
        key: "o",
        run: () => openLink(links[0]!),
      });
    else if (links.length > 1)
      entries.push({
        id: "open-links",
        icon: "↗",
        label: "Open link",
        key: "o",
        more: true,
        run: () => choose("links", "url-0"),
      });
    if (message.kind !== "event")
      entries.push({
        id: "message-about",
        icon: "@",
        label: `About ${message.sender.nick}`,
        key: "a",
        run: () => openPerson(message.networkId, message.sender.nick, anchor()),
      });
    if (canRedact(message))
      entries.push({
        id: "redact-message",
        icon: "×",
        label: "Remove mine…",
        key: "d",
        run: () => {
          setSelectedMessage(message);
          openModal("redact");
        },
      });
    return entries;
  });
  const react = (value: string) => {
    const message = currentMessage();
    if (!message) return;
    const mine = message.reactions?.some((item) => item.value === value && item.reactedBySelf);
    void run({ type: "message.react", messageId: message.id, value, remove: !!mine });
    closeToComposer();
  };
  const personMenu = (): readonly MenuEntry[] => {
    const target = person();
    if (!target) return [];
    return [
      {
        id: "person-message",
        icon: "@",
        label: "Message",
        key: "m",
        run: () => {
          closeToComposer();
          void run({ type: "conversation.query", networkId: target.networkId, nick: target.nick });
        },
      },
      {
        id: "person-copy",
        icon: "□",
        label: "Copy nickname",
        key: "c",
        run: () => {
          void props.external
            .copyText(target.nick, abort.signal)
            .then((result) => finish(result.ok ? "Copied." : result.error.message));
        },
      },
    ];
  };
  /** Card lines from the latest matching WHOIS reply; the network may omit any of them. */
  const personLines = createMemo(() => {
    const target = person();
    if (!target) return [];
    const net = state().networks.find((item) => item.id === target.networkId);
    return personCardLines(target.nick, personInfo(), net?.phase === "ready");
  });
  const personRole = () =>
    memberRole(
      timeline()?.members.find(
        (member) => member.nick.toLowerCase() === person()?.nick.toLowerCase(),
      )?.prefixes[0],
    );
  const showMembers = createMemo(
    () =>
      settings()?.tui.memberList === true &&
      active()?.kind === "channel" &&
      dimensions().width - sidebarWidth() >= 90,
  );
  const sortedMembers = createMemo(() =>
    [...(timeline()?.members ?? [])]
      .sort(
        (a, b) =>
          Number(!a.prefixes.length) - Number(!b.prefixes.length) ||
          a.nick.localeCompare(b.nick, undefined, { sensitivity: "base" }),
      )
      .slice(0, 200),
  );
  const headerName = () => active()?.name ?? "Welcome to opentui-irc";
  const headerPeople = () =>
    active()?.kind === "channel" && !showMembers() ? (timeline()?.members.length ?? 0) : 0;
  const composerFocused = () => !modal() && focusId() === "composer";
  const typingNotice = () =>
    timeline()?.typing.length
      ? typingLabel(timeline()?.typing ?? [], timeline()?.members ?? [])
      : "";
  const behind = () => !atBottom() || timeline()?.atLatest === false;
  const networkName = (id: NetworkId) => state().networks.find((item) => item.id === id)?.name;
  const discoveryMode = () => {
    const value = modal();
    return value === "directory" || value === "whois" ? value : undefined;
  };
  const conversationName = (id: ConversationId) =>
    state().conversations.find((item) => item.id === id)?.name;
  /** Opens a search result in its conversation, briefly showing HistServ if it is one. */
  const revealResult = (message: Message) => {
    void run({ type: "history.reveal", messageId: message.id }).then((result) => {
      if (!result.ok) return;
      if (isHistServMessage(message)) setRevealHistServ(true);
      setReveal(message.id);
      closeToComposer();
    });
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
        run: openSearch,
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
        group: "opentui-irc",
        hint: "ctrl+,",
        run: () => openModal("settings"),
      },
      {
        id: "help",
        label: "Help: keys and commands",
        group: "opentui-irc",
        hint: "f1",
        run: openHelp,
      },
      {
        id: "quit",
        label: "Quit",
        group: "opentui-irc",
        hint: "ctrl+q",
        run: () => openModal("quit"),
      },
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
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={colors.bg}
        onMouseDown={noteAttention}
        onMouseDrag={(event) => {
          if (resizing()) followResize(event.x);
        }}
        onMouseDragEnd={finishResize}
        onMouseUp={finishResize}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <Sidebar
            networks={state().networks}
            conversations={state().conversations}
            activeId={active()?.id}
            width={sidebarWidth()}
            activate={activate}
            browse={() => openModal("switch")}
          />
          <Splitter
            id="sidebar-splitter"
            active={resizing() === "sidebar"}
            onStart={() => setResizing("sidebar")}
          />
          <box flexGrow={1} minWidth={0} flexDirection="column">
            <ConversationHeader
              name={headerName()}
              subtitle={conversationSubtitle(active(), network())}
              people={headerPeople()}
              maxNameWidth={Math.max(8, dimensions().width - sidebarWidth() - 5)}
            />
            <Show
              when={active()}
              fallback={
                <Welcome history={settings()?.user.history} setup={() => openModal("settings")} />
              }
            >
              <box flexDirection="row" flexGrow={1} minHeight={0}>
                <box flexGrow={1} minWidth={0} flexDirection="column">
                  <Transcript
                    messages={visibleMessages()}
                    gutterWidth={gutterWidth()}
                    timeline={timeline()}
                    spaced={settings()?.tui.density !== "compact"}
                    truncated={truncatedWindow()}
                    onlyHistServ={onlyHistServ()}
                    resizingRail={resizing() === "author"}
                    frameRef={(element) => (transcriptFrame = element)}
                    scrollRef={(element) => (transcript = element)}
                    loadOlder={loadOlder}
                    select={(message, point) => {
                      // A drag selected text: the release copies it instead.
                      if (clicksBlocked() || renderer.getSelection()?.getSelectedText()) return;
                      openMessageMenu(message, point);
                    }}
                    nick={(message, point) => {
                      if (!clicksBlocked())
                        openPerson(message.networkId, message.sender.nick, point);
                    }}
                    startRailDrag={() => setResizing("author")}
                  />
                  <Composer
                    typing={typingNotice()}
                    replying={!!reply()}
                    rows={composerRows()}
                    focused={composerFocused()}
                    literal={literalDraft()}
                    placeholder={`Message ${active()?.name ?? ""}`}
                    initialDraft={timeline()?.draft ?? ""}
                    textareaRef={(element) => {
                      composer = element;
                      controls.set("composer", { layer: "main", control: element });
                      onCleanup(() => {
                        if (composer === element) {
                          composer = undefined;
                          controls.delete("composer");
                        }
                      });
                    }}
                    focus={() => focus("composer")}
                    change={syncDraft}
                    submit={() => void send()}
                  />
                </box>
                <Show when={showMembers()}>
                  <Splitter
                    id="members-splitter"
                    active={resizing() === "members"}
                    onStart={() => setResizing("members")}
                  />
                  <MemberList
                    members={sortedMembers()}
                    total={timeline()?.members.length ?? 0}
                    width={memberWidth()}
                    pick={(nick, point) => {
                      const net = network();
                      if (net && !clicksBlocked()) openPerson(net.id, nick, point);
                    }}
                  />
                </Show>
              </box>
            </Show>
          </box>
        </box>
        <StatusBar
          message={footerMessage()}
          hints={footerHints(modal(), modal() === "message" && menuPage() !== "main")}
          width={dimensions().width}
          network={network()}
          behind={behind()}
          jumpLatest={() => void jumpLatest()}
        />
        <Show when={modal() === "message" && currentMessage()}>
          <MessageMenu
            anchor={anchor()}
            screenWidth={dimensions().width}
            screenHeight={dimensions().height}
            title={`${currentMessage()!.sender.nick} · ${formatMessageTime(messageTime(currentMessage()!))}`}
            page={menuPage()}
            entries={messageMenu()}
            links={messageLinks()}
            react={react}
            onClose={closeModal}
          />
        </Show>
        <Show when={modal() === "person" && person()}>
          <PersonCard
            anchor={anchor()}
            screenWidth={dimensions().width}
            screenHeight={dimensions().height}
            nick={person()!.nick}
            role={personRole()}
            lines={personLines()}
            entries={personMenu()}
            onClose={closeModal}
          />
        </Show>
        <Show when={modal() && !popoverOpen()}>
          <Dialog
            title={dialogTitle(modal()!)}
            compact={compactDialog(modal())}
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
              <HelpPanel commands={props.commands} command={helpCommand()} />
            </Show>
            <Show when={modal() === "join" || modal() === "query"}>
              <TargetForm
                kind={modal() === "query" ? "query" : "join"}
                networkName={network()?.name}
                value={formText()}
                onInput={setFormText}
                submit={() => void submitTarget()}
              />
            </Show>
            <Show when={modal() === "switch"}>
              <CommandPalette
                filter={formText()}
                onFilter={setFormText}
                entries={filteredPalette()}
                selected={paletteIndex()}
              />
            </Show>
            <Show when={modal() === "search"}>
              <SearchPanel
                query={formText()}
                onQuery={setFormText}
                searching={searching()}
                results={results()}
                search={() => void search()}
                conversationName={conversationName}
                reveal={revealResult}
              />
            </Show>
            <Show when={modal() === "paste"}>
              <PasteReview text={paste()} insert={insertPaste} />
            </Show>
            <Show when={discoveryMode() && discoveryNetwork()}>
              <DiscoveryPanel
                app={props.app}
                networkId={discoveryNetwork()!}
                networkName={networkName(discoveryNetwork()!) ?? "Selected network"}
                mode={discoveryMode()!}
                requestedNick={requestedNick()}
                dispatch={async (action) => (await run(action)).ok}
                close={closeToComposer}
              />
            </Show>
            <Show when={modal() === "messages"}>
              <MessagePicker
                messages={visibleMessages()}
                pick={(message) => openMessageMenu(message)}
              />
            </Show>
            <Show when={modal() === "redact"}>
              <RedactConfirm
                busy={redacting()}
                allowed={messages().some(
                  (message) => message.id === selectedMessage()?.id && canRedact(message),
                )}
                confirm={() => void redact()}
                cancel={closeModal}
              />
            </Show>
            <Show when={modal() === "quit"}>
              <QuitConfirm quit={() => void quit()} />
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
