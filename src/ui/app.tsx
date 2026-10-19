/* oxlint-disable no-control-regex -- Explicit terminal control rejection is a security boundary. */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
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
import type { Message, TimelineSnapshot } from "../contracts/model";
import type {
  CommandService,
  Completion,
  ExternalActions,
  InputContext,
} from "../contracts/services";
import { useReadable } from "./bridge";
import { Button, Dialog, Field, FocusContext, ThemeContext, usePalette } from "./primitives";
import { SettingsForm } from "./settings";
import { DiscoveryPanel } from "./discovery";
import { createTypingReporter } from "./typing";

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
  const [terminalFocused, setTerminalFocused] = createSignal(false);
  const [reveal, setReveal] = createSignal<MessageId>();
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
    hasText: !!text.trim(),
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
        typing.dispose();
        sendBusy = true;
        const action = intent.value.action;
        const replyTo = reply();
        const result = await run(
          action.type === "message.send" && replyTo ? { ...action, replyTo } : action,
        );
        sendBusy = false;
        if (result.ok) {
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
          setStatus("Accepted locally. Socket write and server echo are not delivery receipts.");
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
      } else if (event.name === "return" && focusId() === "dialog-input") {
        event.preventDefault();
        if (modal() === "search") void search();
        else if (modal() === "join" || modal() === "query") void submitTarget();
        else if (modal() === "switch") {
          const item = matchingConversations()[0];
          if (item) activate(item.id);
        }
      }
      return;
    }
    if (event.name === "f1") {
      event.preventDefault();
      setHelpCommand(undefined);
      openModal("help");
    } else if (event.ctrl && event.name === "k") {
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
  const matchingConversations = () =>
    state().conversations.filter((item) =>
      item.name.toLowerCase().includes(formText().toLowerCase()),
    );
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
      const last = messages().at(-1)?.id;
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
    const mounted = messages();
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
        <box
          height={3}
          flexShrink={0}
          paddingX={1}
          flexDirection="row"
          alignItems="center"
          justifyContent="space-between"
          backgroundColor={colors.panel}
        >
          <text fg={colors.accent}>
            <b>OpenIRC</b> a little closer to your community
          </text>
          <box flexDirection="row">
            <Button
              id="search"
              label="Search"
              onPress={() => {
                setResults([]);
                openModal("search");
              }}
            />
            <Button id="settings" label="Settings" onPress={() => openModal("settings")} />
            <Button
              id="help"
              label="Help"
              onPress={() => {
                setHelpCommand(undefined);
                openModal("help");
              }}
            />
            <Button id="quit" label="Quit" onPress={() => openModal("quit")} />
          </box>
        </box>
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <scrollbox
            width={dimensions().width < 65 ? 18 : (settings()?.tui.sidebarWidth ?? 26)}
            flexShrink={0}
            backgroundColor={colors.panel}
            contentOptions={{ flexDirection: "column", paddingX: 1 }}
            scrollX={false}
          >
            <For each={state().networks}>
              {(net) => (
                <>
                  <box height={2} paddingTop={1} flexShrink={0}>
                    <text fg={colors.accent}>
                      <b>{net.name}</b>
                    </text>
                  </box>
                  <text fg={net.phase === "ready" ? colors.green : colors.muted}>
                    {["registering", "authenticating", "ready"].includes(net.phase)
                      ? `${net.secure ? "TLS" : "Plaintext"} · `
                      : ""}
                    {net.phase}
                  </text>
                  <Show when={net.lastError}>
                    <text fg={colors.error}>{net.lastError?.message}</text>
                  </Show>
                  <Button
                    id={`connect-${net.id}`}
                    label={net.phase === "disconnected" ? "Connect" : "Disconnect"}
                    onPress={() => {
                      void run({
                        type:
                          net.phase === "disconnected" ? "network.connect" : "network.disconnect",
                        networkId: net.id,
                      });
                    }}
                  />
                  <Button
                    id={`browse-${net.id}`}
                    label="Browse channels"
                    disabled={net.phase !== "ready"}
                    onPress={() => {
                      void run({
                        type: "irc.request",
                        networkId: net.id,
                        command: { type: "list" },
                      });
                    }}
                  />
                  <Button
                    id={`people-${net.id}`}
                    label="Look up a person"
                    disabled={net.phase !== "ready"}
                    onPress={() => {
                      setDiscoveryNetwork(net.id);
                      setRequestedNick("");
                      openModal("whois");
                    }}
                  />
                  <For each={["channel", "direct", "status"] as const}>
                    {(kind) => (
                      <>
                        <text fg={colors.muted}>
                          {kind === "channel"
                            ? "CHANNELS"
                            : kind === "direct"
                              ? "DIRECT MESSAGES"
                              : "NETWORK"}
                        </text>
                        <For
                          each={state().conversations.filter(
                            (item) => item.networkId === net.id && item.kind === kind,
                          )}
                        >
                          {(conversation) => (
                            <Button
                              id={`conversation-${conversation.id}`}
                              label={`${conversation.name}${conversation.mentionCount ? ` !${conversation.mentionCount}` : conversation.unreadCount ? ` (${conversation.unreadCount})` : ""}${conversation.muted ? " [muted]" : ""}`}
                              active={active()?.id === conversation.id}
                              onPress={() => activate(conversation.id)}
                            />
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </>
              )}
            </For>
            <box height={1} />
            <Button id="join" label="+ Join channel" onPress={() => openModal("join")} />
            <Button id="query" label="+ Message someone" onPress={() => openModal("query")} />
            <Button id="add-network" label="+ Add network" onPress={() => openModal("settings")} />
            <Button id="switch" label="Switch [Ctrl+K]" onPress={() => openModal("switch")} />
          </scrollbox>
          <box flexGrow={1} minWidth={0} flexDirection="column">
            <box
              height={4}
              flexShrink={0}
              paddingX={2}
              paddingTop={1}
              border={false}
              backgroundColor={colors.raised}
            >
              <text fg={colors.text}>
                <b>{active()?.name ?? "Welcome to OpenIRC"}</b>{" "}
                {network()?.nick ? `as ${network()!.nick}` : ""}
              </text>
              <text fg={colors.muted}>
                {active()?.topic ||
                  (active()
                    ? `${network()?.name ?? ""} · ${network()?.phase ?? "disconnected"}`
                    : "Add a network, connect securely, and join a channel.")}
              </text>
              <Show when={active()?.kind === "direct"}>
                <text fg={colors.muted}>Nicknames can be reused. Verify accounts.</text>
              </Show>
            </box>
            <Show
              when={active()}
              fallback={
                <box flexGrow={1} padding={3} flexDirection="column" gap={1}>
                  <text fg={colors.accent}>
                    <b>Your next conversation starts here.</b>
                  </text>
                  <text fg={colors.text}>1. Add your IRC network in Settings.</text>
                  <text fg={colors.text}>2. Choose Connect beside the network.</text>
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
              <box height={1} flexShrink={0} flexDirection="row">
                <Button
                  id="older"
                  label={timeline()?.loadingOlder ? "Loading…" : "Load older"}
                  disabled={!!timeline()?.loadingOlder}
                  onPress={() => {
                    if (active())
                      void run({
                        type: "history.load-older",
                        conversationId: active()!.id,
                        ...(timeline()?.olderCursor ? { cursor: timeline()!.olderCursor } : {}),
                      });
                  }}
                />
                <Button
                  id="mute"
                  label={active()?.muted ? "Unmute" : "Mute"}
                  onPress={() => {
                    if (active())
                      void run({
                        type: "conversation.mute",
                        conversationId: active()!.id,
                        muted: !active()!.muted,
                      });
                  }}
                />
                <Button
                  id="leave"
                  label="Close"
                  onPress={() => {
                    if (active())
                      void run({ type: "conversation.close", conversationId: active()!.id });
                  }}
                />
                <Button
                  id="message-picker"
                  label="Messages…"
                  onPress={() => openModal("messages")}
                />
              </box>
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
                  paddingX: 2,
                  gap: settings()?.tui.density === "compact" ? 0 : 1,
                }}
              >
                <Show when={(timeline()?.messages.length ?? 0) > 300}>
                  <text fg={colors.muted}>
                    Showing the latest 300 messages to keep terminal layout bounded. Use Search to
                    reveal older context.
                  </text>
                </Show>
                <For each={messages()}>
                  {(message) => (
                    <box
                      id={`message-${message.id}`}
                      flexDirection="column"
                      flexShrink={0}
                      onMouseUp={() => {
                        setSelectedMessage(message);
                        openModal("message");
                      }}
                    >
                      <Show when={timeline()?.firstUnreadId === message.id}>
                        <text fg={colors.accent}>──────── New messages ────────</text>
                      </Show>
                      <text fg={colors.muted}>
                        <b>{message.sender.nick}</b>{" "}
                        {new Date(message.serverTime ?? message.receivedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {message.source === "playback" ? " · history" : ""}
                        {message.sendState ? ` · ${message.sendState}` : ""}
                      </text>
                      <Show when={message.replyTo}>
                        <text fg={colors.muted}>
                          ↳ reply to {message.replyTo?.localId ?? "earlier message"}
                        </text>
                      </Show>
                      <text
                        selectable
                        fg={
                          message.kind === "event"
                            ? colors.muted
                            : message.sendState === "failed" || message.sendState === "uncertain"
                              ? colors.error
                              : colors.text
                        }
                      >
                        {message.redacted
                          ? "[message removed]"
                          : `${message.kind === "action" ? "* " : ""}${message.text}`}
                      </text>
                      <Show when={message.reactions.length}>
                        <text fg={colors.accent}>
                          {message.reactions
                            .map((reaction) => `${reaction.value} ${reaction.count}`)
                            .join("  ")}
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </scrollbox>
              <Show when={!atBottom() || timeline()?.atLatest === false}>
                <Button
                  id="latest"
                  label="Jump to latest [Ctrl+End]"
                  onPress={() => void jumpLatest()}
                />
              </Show>
              <Show when={settings()?.tui.memberList && dimensions().width > 100}>
                <text fg={colors.muted}>
                  People:{" "}
                  {timeline()
                    ?.members.slice(0, 30)
                    .map((member) => member.nick)
                    .join(", ")}
                </text>
              </Show>
              <Show when={timeline()?.typing.length}>
                <text fg={colors.muted}>Someone is typing…</text>
              </Show>
              <Show when={reply()}>
                <text fg={colors.accent}>Replying to a message · Esc to cancel</text>
              </Show>
              <box
                height={6}
                flexShrink={0}
                paddingX={1}
                paddingTop={1}
                backgroundColor={colors.panel}
                flexDirection="column"
              >
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
                  height={3}
                  flexGrow={1}
                  focused={!modal() && focusId() === "composer"}
                  onMouseDown={() => focus("composer")}
                  initialValue={untrack(() => timeline()?.draft ?? "")}
                  placeholder="Write a message… /help for commands"
                  wrapMode="word"
                  backgroundColor={colors.raised}
                  focusedBackgroundColor={colors.raised}
                  textColor={colors.text}
                  onContentChange={syncDraft}
                  keyBindings={[
                    { name: "return", action: "submit" },
                    { name: "return", shift: true, action: "newline" },
                  ]}
                  onSubmit={() => void send()}
                />
                <box height={1} flexDirection="row" justifyContent="space-between">
                  <text fg={colors.muted}>
                    {literalDraft() ? "Pasted text sends literally · " : ""}Enter send · Shift+Enter
                    newline · Tab complete
                  </text>
                  <Button id="send" label="Send" onPress={() => void send()} />
                </box>
              </box>
            </Show>
          </box>
        </box>
        <box height={2} flexShrink={0} paddingX={1} backgroundColor={colors.panel}>
          <text
            fg={
              status() || operations().some((operation) => operation.state === "failed")
                ? colors.error
                : colors.muted
            }
          >
            {status() ||
              [...operations()].reverse().find((operation) => operation.state === "failed")?.error
                ?.message ||
              state().error?.message ||
              "Ctrl+K switch · Ctrl+F search · Ctrl+J join · F1 help · Ctrl+Q quit"}
          </text>
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
                      : `${modal()?.toUpperCase()}`
            }
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
              <text fg={colors.muted}>
                Tab moves focus (in composer: complete; Shift+Tab leaves). Alt+Up/Down switches
                conversation. Ctrl+Up/Down recalls sent inputs. PgUp/PgDown scrolls. Mouse: click a
                message for copy, links, and supported actions.
              </text>
              <For each={props.commands.help(helpCommand())}>
                {(entry) => (
                  <text fg={colors.text}>
                    <b>{entry.usage}</b> {entry.description}
                  </text>
                )}
              </For>
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
                label="Find a conversation"
                value={formText()}
                onInput={setFormText}
              />
              <For each={matchingConversations()}>
                {(item) => (
                  <Button
                    id={`switch-${item.id}`}
                    layer="modal"
                    label={item.name}
                    onPress={() => activate(item.id)}
                  />
                )}
              </For>
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
              <For each={messages()}>
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
