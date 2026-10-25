import { isIP } from "node:net";
import type { Message } from "../contracts/model";
import type { TuiSettings, UserSettings } from "../contracts/settings";
import type { ConversationRecord, ReadPosition, WorkspaceState } from "../contracts/storage";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function text(value: unknown, max = 65536): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        (code >= 32 && (code < 127 || code > 159) && (code < 0xd800 || code > 0xdfff))
      );
    })
  );
}
export function identifier(value: unknown): value is string {
  return text(value, 512) && value.length > 0 && !/[\s]/u.test(value);
}
function label(value: unknown): value is string {
  return text(value, 512) && value.trim().length > 0 && !/[\n\t]/u.test(value);
}
export function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function oneOf(value: unknown, options: readonly unknown[]): boolean {
  return options.includes(value);
}
function list<T>(value: unknown, guard: (item: unknown) => item is T, max = 10000): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(guard);
}
function unique(value: readonly string[]): boolean {
  return new Set(value).size === value.length;
}
export function secretReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(env:[A-Za-z_][A-Za-z0-9_]{0,255}|keychain:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(
      value,
    )
  );
}
function channel(value: unknown): value is string {
  return identifier(value) && /^[#&+!][^ ,:]+$/u.test(value);
}
export function validUserSettings(value: unknown): value is UserSettings {
  if (
    !record(value) ||
    !keys(value, ["schemaVersion", "networks", "history", "notifications", "sendTyping"]) ||
    value.schemaVersion !== 1 ||
    typeof value.sendTyping !== "boolean"
  )
    return false;
  if (!Array.isArray(value.networks) || value.networks.length > 100) return false;
  const ids: string[] = [];
  for (const network of value.networks) {
    if (
      !record(network) ||
      !keys(network, [
        "id",
        "name",
        "endpoints",
        "identity",
        "serverPassword",
        "sasl",
        "autoConnect",
        "autoJoin",
      ]) ||
      !identifier(network.id) ||
      !label(network.name) ||
      typeof network.autoConnect !== "boolean"
    )
      return false;
    ids.push(network.id);
    if (
      !Array.isArray(network.endpoints) ||
      network.endpoints.length < 1 ||
      network.endpoints.length > 16 ||
      !network.endpoints.every(
        (endpoint: unknown) =>
          record(endpoint) &&
          keys(endpoint, ["host", "port", "tls"]) &&
          identifier(endpoint.host) &&
          (isIP(endpoint.host) !== 0 || !/[/:@[\]]/u.test(endpoint.host)) &&
          integer(endpoint.port, 1, 65535) &&
          typeof endpoint.tls === "boolean",
      )
    )
      return false;
    const identity = network.identity;
    if (
      !record(identity) ||
      !keys(identity, ["nick", "alternateNicks", "username", "realname"]) ||
      !identifier(identity.nick) ||
      !identifier(identity.username) ||
      !text(identity.realname, 512) ||
      /[\n\t]/u.test(identity.realname) ||
      !list(identity.alternateNicks, identifier, 16) ||
      !unique([identity.nick, ...identity.alternateNicks])
    )
      return false;
    if (network.serverPassword !== undefined && !secretReference(network.serverPassword))
      return false;
    if (network.sasl !== undefined) {
      const sasl = network.sasl;
      if (
        !record(sasl) ||
        !keys(sasl, ["mechanism", "account", "password", "required"]) ||
        sasl.mechanism !== "PLAIN" ||
        !identifier(sasl.account) ||
        !secretReference(sasl.password) ||
        typeof sasl.required !== "boolean" ||
        !network.endpoints.every((endpoint: unknown) => record(endpoint) && endpoint.tls === true)
      )
        return false;
    }
    if (!Array.isArray(network.autoJoin) || network.autoJoin.length > 1000) return false;
    const channels: string[] = [];
    for (const join of network.autoJoin) {
      if (
        !record(join) ||
        !keys(join, ["channel", "key"]) ||
        !channel(join.channel) ||
        (join.key !== undefined && !secretReference(join.key))
      )
        return false;
      channels.push(join.channel);
    }
    if (!unique(channels)) return false;
  }
  if (!unique(ids)) return false;
  const history = value.history;
  if (
    !record(history) ||
    !keys(history, ["enabled", "retentionDays", "excludedConversations", "persistDrafts"]) ||
    typeof history.enabled !== "boolean" ||
    typeof history.persistDrafts !== "boolean" ||
    !(history.retentionDays === null || integer(history.retentionDays, 1, 36500)) ||
    !Array.isArray(history.excludedConversations) ||
    history.excludedConversations.length > 10000
  )
    return false;
  const exclusions: string[] = [];
  for (const exclusion of history.excludedConversations) {
    if (
      !record(exclusion) ||
      !keys(exclusion, ["networkId", "kind", "name"]) ||
      !identifier(exclusion.networkId) ||
      !ids.includes(exclusion.networkId) ||
      !oneOf(exclusion.kind, ["channel", "direct", "status"]) ||
      !(exclusion.kind === "status" ? label(exclusion.name) : identifier(exclusion.name))
    )
      return false;
    exclusions.push(JSON.stringify([exclusion.networkId, exclusion.kind, exclusion.name]));
  }
  const notifications = value.notifications;
  return (
    unique(exclusions) &&
    record(notifications) &&
    keys(notifications, ["desktop", "previews", "bell"]) &&
    typeof notifications.desktop === "boolean" &&
    typeof notifications.previews === "boolean" &&
    typeof notifications.bell === "boolean"
  );
}
export function validTuiSettings(value: unknown): value is TuiSettings {
  if (
    !record(value) ||
    !keys(value, [
      "schemaVersion",
      "theme",
      "mouse",
      "density",
      "memberList",
      "showHistServ",
      "sidebarWidth",
      "keybindings",
    ]) ||
    value.schemaVersion !== 1 ||
    !oneOf(value.theme, ["dark", "light", "high-contrast"]) ||
    !oneOf(value.density, ["comfortable", "compact"]) ||
    typeof value.mouse !== "boolean" ||
    typeof value.memberList !== "boolean" ||
    typeof value.showHistServ !== "boolean" ||
    !integer(value.sidebarWidth, 12, 80) ||
    !record(value.keybindings) ||
    Object.keys(value.keybindings).length > 200
  )
    return false;
  const bindings: string[] = [];
  for (const [action, shortcuts] of Object.entries(value.keybindings)) {
    if (!identifier(action) || !list(shortcuts, identifier, 10)) return false;
    bindings.push(...shortcuts.map((shortcut) => shortcut.toLowerCase()));
  }
  return unique(bindings);
}
export function validConversation(value: unknown): value is ConversationRecord {
  return (
    record(value) &&
    keys(value, ["id", "networkId", "kind", "name"]) &&
    identifier(value.id) &&
    identifier(value.networkId) &&
    oneOf(value.kind, ["channel", "direct", "status"]) &&
    (value.kind === "status" ? label(value.name) : identifier(value.name))
  );
}
export function validMessage(value: unknown): value is Message {
  if (
    !record(value) ||
    !keys(value, [
      "id",
      "conversationId",
      "networkId",
      "serverId",
      "sender",
      "kind",
      "text",
      "receivedAt",
      "serverTime",
      "source",
      "sendState",
      "replyTo",
      "reactions",
      "redacted",
    ]) ||
    !identifier(value.id) ||
    !identifier(value.conversationId) ||
    !identifier(value.networkId) ||
    (value.serverId !== undefined && !identifier(value.serverId)) ||
    !oneOf(value.kind, ["text", "action", "notice", "event"]) ||
    !text(value.text) ||
    !timestamp(value.receivedAt) ||
    (value.serverTime !== undefined && !timestamp(value.serverTime)) ||
    !oneOf(value.source, ["live", "playback", "local"]) ||
    (value.sendState !== undefined &&
      !oneOf(value.sendState, ["pending", "written", "echo-observed", "failed", "uncertain"])) ||
    typeof value.redacted !== "boolean"
  )
    return false;
  const sender = value.sender;
  if (
    !record(sender) ||
    !keys(sender, ["nick", "userId", "account"]) ||
    !identifier(sender.nick) ||
    (sender.userId !== undefined && !identifier(sender.userId)) ||
    (sender.account !== undefined && !identifier(sender.account))
  )
    return false;
  const reply = value.replyTo;
  if (
    reply !== undefined &&
    (!record(reply) ||
      !keys(reply, ["serverId", "localId"]) ||
      !identifier(reply.serverId) ||
      (reply.localId !== undefined && !identifier(reply.localId)))
  )
    return false;
  return (
    Array.isArray(value.reactions) &&
    value.reactions.length <= 1000 &&
    value.reactions.every(
      (reaction: unknown) =>
        record(reaction) &&
        keys(reaction, ["value", "count", "reactedBySelf"]) &&
        text(reaction.value, 128) &&
        reaction.value.length > 0 &&
        integer(reaction.count, 1, 1000000000) &&
        typeof reaction.reactedBySelf === "boolean",
    )
  );
}
export function validReadPosition(value: unknown): value is ReadPosition {
  return (
    record(value) &&
    keys(value, ["conversationId", "messageId", "readAt"]) &&
    identifier(value.conversationId) &&
    identifier(value.messageId) &&
    timestamp(value.readAt)
  );
}
export function validWorkspace(value: unknown): value is WorkspaceState {
  if (
    !record(value) ||
    !keys(value, ["activeConversationId", "conversationOrder", "mutedConversations", "drafts"]) ||
    (value.activeConversationId !== undefined && !identifier(value.activeConversationId)) ||
    !list(value.conversationOrder, identifier) ||
    !list(value.mutedConversations, identifier) ||
    !unique(value.conversationOrder) ||
    !unique(value.mutedConversations)
  )
    return false;
  if (!Array.isArray(value.drafts) || value.drafts.length > 10000) return false;
  const ids: string[] = [];
  for (const draft of value.drafts) {
    if (
      !record(draft) ||
      !keys(draft, ["conversationId", "text"]) ||
      !identifier(draft.conversationId) ||
      !text(draft.text)
    )
      return false;
    ids.push(draft.conversationId);
  }
  return unique(ids);
}
