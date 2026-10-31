import { createApp } from "../../src/app/create-app";
import type { AppAction, AppApi, OperationView } from "../../src/contracts/app";
import type { ConversationId, OperationId, Result } from "../../src/contracts/common";
import type { FeatureSet, Message } from "../../src/contracts/model";
import type { ProtocolSupport } from "../../src/contracts/protocol";
import type { ChatEnvelope, SessionPayload } from "../../src/contracts/session";
import type { SettingsDocument } from "../../src/contracts/settings";
import { networkId, settings } from "../fixtures/scenario";
import { harness, settle } from "./harness";

export const signal = () => new AbortController().signal;
export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export const allFeatures: FeatureSet = {
  history: true,
  replies: true,
  reactions: true,
  typing: true,
  readMarkers: true,
  redaction: true,
  multiline: false,
};
export const noFeatures: FeatureSet = {
  history: false,
  replies: false,
  reactions: false,
  typing: false,
  readMarkers: false,
  redaction: false,
  multiline: false,
};
export function protocol(capabilities: ProtocolSupport["capabilities"] = {}): ProtocolSupport {
  return {
    casemapping: "rfc1459",
    channelTypes: "#&",
    prefixModes: "ov",
    prefixSymbols: "@+",
    channelModeGroups: ["b", "k", "l", "imnt"],
    capabilities,
  };
}

/** Every app created through these helpers is shut down by `shutdownAll` in afterEach. */
const apps: AppApi[] = [];
export async function shutdownAll() {
  for (const app of apps.splice(0)) await app.shutdown();
}

export interface BootOptions {
  readonly config?: SettingsDocument;
  readonly configure?: (h: ReturnType<typeof harness>) => void;
}
export async function boot({ config = settings, configure }: BootOptions = {}) {
  const h = harness(config);
  configure?.(h);
  const app = value(await createApp(h.deps, signal()));
  apps.push(app);
  const dispatch = (action: AppAction) => app.dispatch(action, signal());
  const operation = (id: OperationId): OperationView | undefined =>
    app.operations.getSnapshot().find((entry) => entry.id === id);
  const timeline = (id: ConversationId) => value(app.timeline(id)).getSnapshot();
  const find = (name: string) => app.state.getSnapshot().conversations.find((c) => c.name === name);
  const status = () =>
    app.state
      .getSnapshot()
      .conversations.find((c) => c.kind === "status" && c.networkId === networkId)!;
  return { ...h, h, app, dispatch, operation, timeline, find, status };
}

export interface ConnectOptions extends BootOptions {
  readonly features?: FeatureSet;
  readonly capabilities?: ProtocolSupport["capabilities"];
  /** Skip the support event so the app uses its built-in identifier defaults. */
  readonly withoutSupport?: boolean;
}
export async function connect(options: ConnectOptions = {}) {
  const booted = await boot(options);
  value(await booted.dispatch({ type: "network.connect", networkId }));
  await settle();
  const session = booted.h.session(networkId);
  const emit = async (payload: SessionPayload) => {
    session.emit(payload);
    await settle();
  };
  if (!options.withoutSupport)
    session.emit({
      type: "support",
      features: options.features ?? allFeatures,
      support: protocol(options.capabilities),
    });
  session.emit({
    type: "state",
    phase: "ready",
    nick: "newcomer",
    secure: true,
    authenticated: false,
  });
  await emit({
    type: "membership",
    channel: "#welcome",
    change: { kind: "join", nick: "newcomer", prefixes: [] },
  });
  const conversationId = booted.find("#welcome")!.id;
  value(await booted.dispatch({ type: "conversation.activate", conversationId }));
  const chat = (message: Partial<ChatEnvelope> & { serverId?: string }) =>
    emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "guide" },
        kind: "text",
        text: "hello",
        receivedAt: 1_700_000_002_000,
        source: "live",
        ...message,
      },
    });
  const messages = (id: ConversationId = conversationId): readonly Message[] =>
    booted.timeline(id).messages;
  const byServerId = (serverId: string, id: ConversationId = conversationId) =>
    messages(id).find((message) => message.serverId === serverId);
  const statusText = () => booted.timeline(booted.status().id).messages.map((m) => m.text);
  const network = () => booted.app.state.getSnapshot().networks.find((n) => n.id === networkId)!;
  return {
    ...booted,
    session,
    emit,
    conversationId,
    chat,
    messages,
    byServerId,
    statusText,
    network,
  };
}
