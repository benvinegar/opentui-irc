import { entityId } from "../../src/contracts/common";
import type { AppSnapshot, FeatureSet, Message, TimelineSnapshot } from "../../src/contracts/model";
import type { NetworkProfile, SettingsDocument } from "../../src/contracts/settings";

export const networkId = entityId<"network">("fixture-network");
export const conversationId = entityId<"conversation">("fixture-channel");
export const messageId = entityId<"message">("fixture-message");

export const basicFeatures: FeatureSet = {
  history: false,
  replies: false,
  reactions: false,
  typing: false,
  readMarkers: false,
  redaction: false,
  multiline: false,
};

export const profile: NetworkProfile = {
  id: networkId,
  name: "Local test network",
  endpoints: [{ host: "localhost", port: 6697, tls: true }],
  identity: {
    nick: "newcomer",
    alternateNicks: ["newcomer_"],
    username: "openirc",
    realname: "OpenIRC user",
  },
  autoConnect: false,
  autoJoin: [{ channel: "#welcome" }],
};

export const settings: SettingsDocument = {
  revision: entityId<"config-revision">("fixture-revision-1"),
  user: {
    schemaVersion: 1,
    networks: [profile],
    history: { enabled: true, retentionDays: 30, excludedConversations: [], persistDrafts: false },
    notifications: { desktop: false, previews: false, bell: false },
    sendTyping: false,
  },
  tui: {
    schemaVersion: 1,
    theme: "dark",
    mouse: true,
    density: "comfortable",
    memberList: false,
    sidebarWidth: 24,
    keybindings: {},
  },
};

export const welcomeMessage: Message = {
  id: messageId,
  conversationId,
  networkId,
  sender: { nick: "guide" },
  kind: "text",
  text: "Welcome to OpenIRC!",
  receivedAt: 1_700_000_000_000,
  source: "live",
  reactions: [],
  redacted: false,
};

export const appSnapshot: AppSnapshot = {
  revision: 1,
  boot: "ready",
  activeConversationId: conversationId,
  networks: [
    {
      id: networkId,
      name: profile.name,
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
      features: basicFeatures,
    },
  ],
  conversations: [
    {
      id: conversationId,
      networkId,
      kind: "channel",
      name: "#welcome",
      topic: "Start here",
      joined: true,
      unreadCount: 0,
      mentionCount: 0,
      muted: false,
    },
  ],
};

export const timelineSnapshot: TimelineSnapshot = {
  conversationId,
  messages: [welcomeMessage],
  members: [],
  typing: [],
  loadingOlder: false,
  draft: "",
};
