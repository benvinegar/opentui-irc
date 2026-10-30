import { describe, expect, it } from "vitest";
import { entityId } from "../../src/contracts/common";
import type { UserDetails } from "../../src/contracts/discovery";
import type {
  ConnectionPhase,
  ConversationView,
  Message,
  NetworkView,
  UserView,
} from "../../src/contracts/model";
import {
  compactDialog,
  conversationSubtitle,
  dialogTitle,
  footerHints,
  memberRole,
  messageTime,
  modalFocusTarget,
  personCardLines,
  phaseLabel,
  searchSummary,
  typingLabel,
  type Modal,
} from "../../src/ui/shell-labels";

const ALL_MODALS = [
  "settings",
  "help",
  "join",
  "query",
  "switch",
  "search",
  "paste",
  "message",
  "messages",
  "directory",
  "whois",
  "person",
  "redact",
  "quit",
] as const;

const networkId = entityId<"network">("network-test");

const network = (phase: ConnectionPhase, secure = true): NetworkView => ({
  id: networkId,
  name: "Test",
  phase,
  nick: "me",
  secure,
  authenticated: false,
  features: {
    history: false,
    replies: false,
    reactions: false,
    typing: false,
    readMarkers: false,
    redaction: false,
    multiline: false,
  },
});

const conversation = (kind: ConversationView["kind"], topic = ""): ConversationView => ({
  id: entityId<"conversation">(`conversation-${kind}`),
  networkId,
  kind,
  name: kind === "channel" ? "#test" : "someone",
  topic,
  joined: true,
  unreadCount: 0,
  mentionCount: 0,
  muted: false,
});

const member = (id: string, nick: string): UserView => ({
  id: entityId<"user">(id),
  nick,
  away: false,
  prefixes: [],
});

describe("shell labels", () => {
  it("prefers server time for messages", () => {
    const message: Message = {
      id: entityId<"message">("message-1"),
      conversationId: entityId<"conversation">("conversation-1"),
      networkId,
      sender: { nick: "alice" },
      kind: "text",
      text: "hi",
      receivedAt: 200,
      source: "live",
      reactions: [],
      redacted: false,
    };
    expect(messageTime(message)).toBe(200);
    expect(messageTime({ ...message, serverTime: 100 })).toBe(100);
  });

  it("names every connection phase", () => {
    expect(phaseLabel("ready")).toBe("connected");
    expect(phaseLabel("disconnected")).toBe("offline");
    expect(phaseLabel("reconnecting")).toBe("reconnecting…");
    for (const phase of ["connecting", "registering", "authenticating"] as const)
      expect(phaseLabel(phase)).toBe("connecting…");
  });

  it("focuses each modal's first useful control", () => {
    expect(Object.fromEntries(ALL_MODALS.map((modal) => [modal, modalFocusTarget(modal)]))).toEqual(
      {
        settings: "network-name",
        help: "dialog-close",
        join: "dialog-input",
        query: "dialog-input",
        switch: "dialog-input",
        search: "dialog-input",
        paste: "dialog-close",
        message: "copy-message",
        messages: "dialog-close",
        directory: "directory-filter",
        whois: "whois-nick",
        person: "person-message",
        redact: "redact-cancel",
        quit: "quit-confirm",
      },
    );
    expect(modalFocusTarget(null)).toBe("dialog-close");
  });

  it("titles every dialog, capitalizing those without a custom title", () => {
    expect(Object.fromEntries(ALL_MODALS.map((modal) => [modal, dialogTitle(modal)]))).toEqual({
      settings: "Settings · Add network",
      help: "Help",
      join: "Join",
      query: "Message someone",
      switch: "Jump to…",
      search: "Search",
      paste: "Review paste — nothing has been sent",
      message: "Message",
      messages: "Select a message",
      directory: "Directory",
      whois: "Look up a person",
      person: "Person",
      redact: "Remove message",
      quit: "Disconnect and quit?",
    });
  });

  it("uses compact dialogs only for short confirmations and pickers", () => {
    expect(ALL_MODALS.filter(compactDialog)).toEqual(["join", "query", "switch", "redact", "quit"]);
    expect(compactDialog(null)).toBe(false);
  });

  it("shows the key legend for each layer", () => {
    const keys = (modal: Modal, submenu = false) =>
      footerHints(modal, submenu).map(([key, label]) => `${key} ${label}`);
    expect(keys(null)).toEqual(["ctrl+k jump to…", "ctrl+f search", "f1 help", "ctrl+q quit"]);
    expect(keys("switch")).toEqual(["↑↓ select", "enter open", "esc close"]);
    expect(keys("message")).toEqual(["↑↓ select", "letter shortcut", "esc close"]);
    expect(keys("message", true)).toEqual(["↑↓ select", "letter shortcut", "esc back"]);
    expect(keys("person")).toEqual(["↑↓ select", "letter shortcut", "esc close"]);
    expect(keys("help")).toEqual(["pgup pgdn scroll", "esc close"]);
    expect(keys("messages")).toEqual(["pgup pgdn scroll", "esc close"]);
    for (const modal of ["settings", "join", "search", "paste", "directory", "quit"] as const)
      expect(keys(modal)).toEqual(["tab next", "enter choose", "esc close"]);
  });

  it("subtitles conversations with a DM warning, the topic, or connection security", () => {
    expect(conversationSubtitle(undefined, undefined)).toBe("");
    expect(conversationSubtitle(conversation("direct"), network("ready"))).toBe(
      "Nicknames can be reused. Verify accounts.",
    );
    expect(conversationSubtitle(conversation("channel", "Welcome!"), network("ready"))).toBe(
      "Welcome!",
    );
    expect(conversationSubtitle(conversation("channel"), network("ready"))).toBe("");
    const status = conversation("status");
    expect(conversationSubtitle(status, network("ready"))).toBe("TLS · connected");
    expect(conversationSubtitle(status, network("ready", false))).toBe("plaintext · connected");
    expect(conversationSubtitle(status, network("registering"))).toBe("TLS · connecting…");
    expect(conversationSubtitle(status, network("authenticating", false))).toBe(
      "plaintext · connecting…",
    );
    expect(conversationSubtitle(status, network("connecting"))).toBe("connecting…");
    expect(conversationSubtitle(status, network("reconnecting"))).toBe("reconnecting…");
    expect(conversationSubtitle(status, undefined)).toBe("offline");
  });

  it("names channel roles from their highest prefix", () => {
    expect(["~", "&", "@", "%", "+"].map(memberRole)).toEqual([
      "owner",
      "admin",
      "op",
      "half-op",
      "voice",
    ]);
    expect(memberRole(undefined)).toBe("");
    expect(memberRole("!")).toBe("");
  });

  it("describes who is typing without guessing at unknown members", () => {
    const members = [member("u1", "alice"), member("u2", "bob"), member("u3", "carol")];
    const ids = (...values: string[]) => values.map((value) => entityId<"user">(value));
    expect(typingLabel([], members)).toBe("Someone is typing…");
    expect(typingLabel(ids("u1"), members)).toBe("alice is typing…");
    expect(typingLabel(ids("u1", "u2"), members)).toBe("alice and bob are typing…");
    expect(typingLabel(ids("u1", "u2", "u3"), members)).toBe("Several people are typing…");
    expect(typingLabel(ids("u1", "unknown"), members)).toBe("Someone is typing…");
  });

  it("summarizes search progress and capped results", () => {
    expect(searchSummary(true, 3)).toBe("Searching…");
    expect(searchSummary(false, 0)).toBe("Up to 50 results from local history.");
    expect(searchSummary(false, 1)).toBe("1 result · enter to reveal in context");
    expect(searchSummary(false, 2)).toBe("2 results · enter to reveal in context");
    expect(searchSummary(false, 50)).toBe("50+ results · enter to reveal in context");
  });
});

describe("person card lines", () => {
  const details: UserDetails = {
    nick: "Alice",
    username: "alice",
    hostname: "example.test",
    realname: "Alice Example",
    account: "alice-account",
    channels: ["#one", "#two"],
    awayReason: "lunch",
  };

  it("says details are unavailable while offline", () => {
    expect(personCardLines("alice", { state: "ready", details }, false)).toEqual([
      ["Offline · details unavailable", "muted"],
    ]);
  });

  it("shows failures only when no matching details exist", () => {
    const error = { code: "network" as const, message: "No such nick.", retryable: false };
    expect(personCardLines("alice", { state: "failed", error }, true)).toEqual([
      ["No such nick.", "error"],
    ]);
    expect(personCardLines("alice", { state: "failed" }, true)).toEqual([
      ["No details available.", "error"],
    ]);
    expect(personCardLines("alice", { state: "failed", error, details }, true)).toHaveLength(5);
  });

  it("waits for a reply about the same nickname", () => {
    expect(personCardLines("alice", undefined, true)).toEqual([["Looking up…", "muted"]]);
    expect(personCardLines("alice", { state: "loading" }, true)).toEqual([
      ["Looking up…", "muted"],
    ]);
    expect(personCardLines("bob", { state: "ready", details }, true)).toEqual([
      ["Looking up…", "muted"],
    ]);
  });

  it("lists every reported detail, matching the nickname case-insensitively", () => {
    expect(personCardLines("ALICE", { state: "ready", details }, true)).toEqual([
      ["alice@example.test", "muted"],
      ['"Alice Example"', "text"],
      ["account: alice-account", "muted"],
      ["away: lunch", "text"],
      ["in #one #two", "muted"],
    ]);
  });

  it("marks omitted details instead of inventing them", () => {
    const sparse = (overrides: Partial<UserDetails>) =>
      personCardLines(
        "alice",
        { state: "ready", details: { nick: "alice", channels: [], ...overrides } },
        true,
      );
    expect(sparse({})).toEqual([["not identified", "muted"]]);
    expect(sparse({ username: "alice" })[0]).toEqual(["alice@?", "muted"]);
    expect(sparse({ hostname: "example.test" })[0]).toEqual(["?@example.test", "muted"]);
  });
});
