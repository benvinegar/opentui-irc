import { isIP } from "node:net";
import type { Message } from "../contracts/model";
import type { TuiSettings, UserSettings } from "../contracts/settings";
import type { ConversationRecord, ReadPosition, WorkspaceState } from "../contracts/storage";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
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
function endpoint(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    keys(value, ["host", "port", "tls"]) &&
    identifier(value.host) &&
    (isIP(value.host) !== 0 || !/[/:@[\]]/u.test(value.host)) &&
    integer(value.port, 1, 65535) &&
    typeof value.tls === "boolean"
  );
}
function identity(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["nick", "alternateNicks", "username", "realname"]) &&
    identifier(value.nick) &&
    identifier(value.username) &&
    text(value.realname, 512) &&
    !/[\n\t]/u.test(value.realname) &&
    list(value.alternateNicks, identifier, 16) &&
    unique([value.nick, ...value.alternateNicks])
  );
}
/** SASL PLAIN sends the password in the clear, so every endpoint must use TLS. */
function sasl(value: unknown, endpoints: readonly unknown[]): boolean {
  return (
    record(value) &&
    keys(value, ["mechanism", "account", "password", "required"]) &&
    value.mechanism === "PLAIN" &&
    identifier(value.account) &&
    secretReference(value.password) &&
    typeof value.required === "boolean" &&
    endpoints.every((item) => record(item) && item.tls === true)
  );
}
function autoJoin(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const channels: string[] = [];
  for (const join of value) {
    if (
      !record(join) ||
      !keys(join, ["channel", "key"]) ||
      !channel(join.channel) ||
      (join.key !== undefined && !secretReference(join.key))
    )
      return false;
    channels.push(join.channel);
  }
  return unique(channels);
}
function network(value: unknown): value is Record<string, unknown> & { id: string } {
  return (
    record(value) &&
    keys(value, [
      "id",
      "name",
      "endpoints",
      "identity",
      "serverPassword",
      "sasl",
      "autoConnect",
      "autoJoin",
    ]) &&
    identifier(value.id) &&
    label(value.name) &&
    typeof value.autoConnect === "boolean" &&
    list(value.endpoints, endpoint, 16) &&
    value.endpoints.length >= 1 &&
    identity(value.identity) &&
    (value.serverPassword === undefined || secretReference(value.serverPassword)) &&
    (value.sasl === undefined || sasl(value.sasl, value.endpoints)) &&
    autoJoin(value.autoJoin)
  );
}
function exclusion(
  value: unknown,
  networkIds: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    keys(value, ["networkId", "kind", "name"]) &&
    identifier(value.networkId) &&
    networkIds.includes(value.networkId) &&
    oneOf(value.kind, ["channel", "direct", "status"]) &&
    (value.kind === "status" ? label(value.name) : identifier(value.name))
  );
}
function history(value: unknown, networkIds: readonly string[]): boolean {
  if (
    !record(value) ||
    !keys(value, ["enabled", "retentionDays", "excludedConversations", "persistDrafts"]) ||
    typeof value.enabled !== "boolean" ||
    typeof value.persistDrafts !== "boolean" ||
    !(value.retentionDays === null || integer(value.retentionDays, 1, 36500)) ||
    !Array.isArray(value.excludedConversations) ||
    value.excludedConversations.length > 10000
  )
    return false;
  const exclusions: string[] = [];
  for (const item of value.excludedConversations) {
    if (!exclusion(item, networkIds)) return false;
    exclusions.push(JSON.stringify([item.networkId, item.kind, item.name]));
  }
  return unique(exclusions);
}
function notifications(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["desktop", "previews", "bell"]) &&
    typeof value.desktop === "boolean" &&
    typeof value.previews === "boolean" &&
    typeof value.bell === "boolean"
  );
}
export function validUserSettings(value: unknown): value is UserSettings {
  if (
    !record(value) ||
    !keys(value, ["schemaVersion", "networks", "history", "notifications", "sendTyping"]) ||
    value.schemaVersion !== 1 ||
    typeof value.sendTyping !== "boolean" ||
    !list(value.networks, network, 100)
  )
    return false;
  const ids = value.networks.map((item) => item.id);
  return unique(ids) && history(value.history, ids) && notifications(value.notifications);
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
      "memberListWidth",
      "authorColumnWidth",
      "keybindings",
    ]) ||
    value.schemaVersion !== 1 ||
    !oneOf(value.theme, ["dark", "light", "high-contrast"]) ||
    !oneOf(value.density, ["comfortable", "compact"]) ||
    typeof value.mouse !== "boolean" ||
    typeof value.memberList !== "boolean" ||
    typeof value.showHistServ !== "boolean" ||
    !integer(value.sidebarWidth, 12, 80) ||
    !integer(value.memberListWidth, 12, 60) ||
    !(value.authorColumnWidth === null || integer(value.authorColumnWidth, 8, 40)) ||
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
function sender(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["nick", "userId", "account"]) &&
    identifier(value.nick) &&
    (value.userId === undefined || identifier(value.userId)) &&
    (value.account === undefined || identifier(value.account))
  );
}
function replyTarget(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["serverId", "localId"]) &&
    identifier(value.serverId) &&
    (value.localId === undefined || identifier(value.localId))
  );
}
function reaction(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    keys(value, ["value", "count", "reactedBySelf"]) &&
    text(value.value, 128) &&
    value.value.length > 0 &&
    integer(value.count, 1, 1000000000) &&
    typeof value.reactedBySelf === "boolean"
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
  return (
    sender(value.sender) &&
    (value.replyTo === undefined || replyTarget(value.replyTo)) &&
    list(value.reactions, reaction, 1000)
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
