import type { ConfigRevision, NetworkId, Result } from "../contracts/common";
import type {
  ConfigEdit,
  ConfigEffect,
  ControlError,
  ControlPermission,
  JsonObject,
  JsonValue,
} from "../contracts/control";
import type {
  NetworkProfile,
  SettingsChange,
  SettingsDocument,
  TuiSettings,
  UserSettings,
} from "../contracts/settings";
import { text, validTuiSettings, validUserSettings } from "../storage/validation";
import { configurationSchema } from "./schema";

export interface ConfigPlan {
  readonly change: SettingsChange;
  readonly baseRevision: ConfigRevision;
  readonly effects: readonly ConfigEffect[];
  readonly requiredPermissions: readonly ControlPermission[];
  readonly reconnectNetworkIds: readonly NetworkId[];
  readonly changed: boolean;
}

const MAX_BYTES = 1024 * 1024;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();
class InvalidEdit extends Error {}
function invalid(): never {
  throw new InvalidEdit();
}
function failure(
  code: "invalid-input" | "unsupported" = "invalid-input",
): Result<never, ControlError> {
  return {
    ok: false,
    error: {
      code,
      message:
        code === "unsupported"
          ? "Custom keybindings are reserved and are not supported by the UI."
          : "Configuration edit is invalid or exceeds supported limits.",
      retryable: false,
    },
  };
}
function object(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function fits(value: JsonValue, pretty = false): boolean {
  return encoder.encode(JSON.stringify(value, null, pretty ? 2 : undefined)).length <= MAX_BYTES;
}

type Descriptors = { readonly [key: string]: PropertyDescriptor };
/** Only own, enumerable data properties are copied; accessors are never invoked. */
function dataValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (!descriptor || !descriptor.enumerable || !own(descriptor, "value")) invalid();
  const value: unknown = descriptor.value;
  return value;
}

/** Copy only bounded, plain JSON data; never invoke accessors/toJSON or inherit properties. */
function cloneJson(input: unknown): JsonValue {
  let nodes = 0;
  let units = 0;
  const ancestors = new Set<object>();
  function copyString(value: string): string {
    units += value.length;
    if (units > MAX_BYTES || !text(value, MAX_BYTES) || /[\n\t]/u.test(value)) invalid();
    return value;
  }
  function copyArray(
    value: readonly unknown[],
    names: readonly (string | symbol)[],
    descriptors: Descriptors,
    depth: number,
  ): JsonValue[] {
    if (value.length > 100000 || names.length !== value.length + 1) invalid();
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index++)
      items.push(copy(dataValue(descriptors[String(index)]), depth + 1));
    return items;
  }
  function copyObject(
    names: readonly (string | symbol)[],
    descriptors: Descriptors,
    depth: number,
  ): JsonObject {
    const properties: Record<string, JsonValue> = {};
    for (const name of names) {
      if (typeof name !== "string" || forbidden.has(name)) invalid();
      units += name.length;
      if (units > MAX_BYTES) invalid();
      properties[name] = copy(dataValue(descriptors[name]), depth + 1);
    }
    return properties;
  }
  function copy(value: unknown, depth: number): JsonValue {
    if (++nodes > 100000 || depth > 32) invalid();
    if (typeof value === "string") return copyString(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || ancestors.has(value)) invalid();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) &&
      prototype !== null
    )
      invalid();
    ancestors.add(value);
    const names = Reflect.ownKeys(value);
    if (names.length > 100000) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Array.isArray(value)
      ? copyArray(value, names, descriptors, depth)
      : copyObject(names, descriptors, depth);
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (!fits(result)) invalid();
  return result;
}
function pathParts(path: string): string[] {
  if (path.length === 0 || path.length > 2048) invalid();
  const parts = path.split(".");
  if (parts.length > 32 || parts.some((part) => !part || forbidden.has(part))) invalid();
  return parts;
}

export function parseConfigEdit(value: unknown): Result<ConfigEdit, ControlError> {
  try {
    const edit = cloneJson(value);
    if (!object(edit) || (edit.section !== "user" && edit.section !== "tui")) return failure();
    const section = edit.section;
    if (own(edit, "value")) {
      if (
        Object.keys(edit).some((key) => key !== "section" && key !== "value") ||
        !object(edit.value)
      )
        return failure();
      return { ok: true, value: { section, value: edit.value } };
    }
    if (
      Object.keys(edit).some((key) => !["section", "patch", "unset"].includes(key)) ||
      !object(edit.patch)
    )
      return failure();
    if (!own(edit, "unset")) return { ok: true, value: { section, patch: edit.patch } };
    if (!Array.isArray(edit.unset) || edit.unset.length > 1000) return failure();
    const unset: string[] = [];
    for (const path of edit.unset) {
      if (typeof path !== "string") return failure();
      pathParts(path);
      unset.push(path);
    }
    if (new Set(unset).size !== unset.length) return failure();
    return { ok: true, value: { section, patch: edit.patch, unset } };
  } catch {
    return failure();
  }
}

const schema = configurationSchema();
function resolveSchema(value: JsonObject): JsonObject {
  if (typeof value.$ref !== "string") return value;
  const definitions = schema.$defs;
  const target = object(definitions) ? definitions[value.$ref.slice("#/$defs/".length)] : undefined;
  if (!object(target)) invalid();
  return target;
}
/** Reject unknown patch paths even if a later unset would otherwise hide them. */
function knownPatch(patch: JsonObject, shape: JsonObject): void {
  const resolved = resolveSchema(shape);
  const properties = resolved.properties;
  for (const [key, value] of Object.entries(patch)) {
    const child =
      object(properties) && own(properties, key) ? properties[key] : resolved.additionalProperties;
    if (!object(child)) invalid();
    knownValue(value, child);
  }
}
function knownValue(value: JsonValue, shape: JsonObject): void {
  if (object(value)) knownPatch(value, shape);
  else if (Array.isArray(value)) {
    const items = resolveSchema(shape).items;
    if (object(items)) for (const item of value) knownValue(item, items);
  }
}
function merge(base: JsonObject, patch: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key];
    result[key] = object(value) && object(before) ? merge(before, value) : value;
  }
  return result;
}
/** Persistent deletion: arrays may be traversed, never spliced/partially patched. */
function unsetPath(value: JsonValue, parts: readonly string[]): JsonValue {
  const [key, ...rest] = parts;
  if (key === undefined) invalid();
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length || rest.length === 0)
      invalid();
    return value.map((item: JsonValue, index: number) =>
      index === Number(key) ? unsetPath(item, rest) : item,
    );
  }
  if (!object(value) || !own(value, key)) invalid();
  const result: Record<string, JsonValue> = { ...value };
  if (rest.length === 0) delete result[key];
  else result[key] = unsetPath(result[key]!, rest);
  return result;
}
function equal(left: unknown, right: unknown): boolean {
  // Canonical key order is irrelevant to configuration equality; array order is significant.
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item: unknown, index: number) => equal(item, right[index]))
    );
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const a = Object.getOwnPropertyDescriptors(left);
  const b = Object.getOwnPropertyDescriptors(right);
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => own(b, key) && equal(a[key]?.value, b[key]?.value))
  );
}
function networkEffects(
  before: readonly NetworkProfile[],
  after: readonly NetworkProfile[],
  effects: ConfigEffect[],
  reconnectIds: NetworkId[],
): void {
  const previous = new Map(before.map((network) => [network.id, network]));
  const next = new Set(after.map((network) => network.id));
  for (let index = 0; index < before.length; index++) {
    if (!next.has(before[index]!.id))
      effects.push({
        path: `user.networks.${index}`,
        effect: "network",
        description:
          "Removing a profile disconnects it and removes its live conversation views; saved history is retained.",
      });
  }
  for (let index = 0; index < after.length; index++) {
    const network = after[index]!;
    const old = previous.get(network.id);
    const path = `user.networks.${index}`;
    if (!old) {
      effects.push({
        path,
        effect: "network",
        description: network.autoConnect
          ? "Adding an autoConnect profile may connect immediately."
          : "Adding a network profile; it remains disconnected until requested.",
      });
      continue;
    }
    if (old.autoConnect !== network.autoConnect)
      effects.push({
        path: `${path}.autoConnect`,
        effect: "network",
        description:
          "Changes future startup behavior; does not immediately connect or disconnect an existing profile.",
      });
    if (old.name !== network.name)
      effects.push({
        path: `${path}.name`,
        effect: "immediate",
        description: "Update the network display label.",
      });
    let reconnect = false;
    for (const key of ["endpoints", "identity", "serverPassword", "sasl", "autoJoin"] as const) {
      if (equal(old[key], network[key])) continue;
      reconnect = true;
      effects.push({
        path: `${path}.${key}`,
        effect: "reconnect",
        description:
          "Applies on the next explicit connection; this edit never reconnects automatically.",
      });
    }
    if (reconnect) reconnectIds.push(network.id);
  }
  if (
    before.length === after.length &&
    before.every((network) => next.has(network.id)) &&
    !equal(
      before.map((network) => network.id),
      after.map((network) => network.id),
    )
  )
    effects.push({
      path: "user.networks",
      effect: "immediate",
      description: "Update the saved profile order.",
    });
}

const TUI_KEYS = [
  "theme",
  "density",
  "memberList",
  "showHistServ",
  "sidebarWidth",
  "memberListWidth",
  "authorColumnWidth",
  "mouse",
  "keybindings",
] as const;
const HISTORY_KEYS = [
  "enabled",
  "retentionDays",
  "excludedConversations",
  "persistDrafts",
] as const;
const NOTIFICATION_KEYS = ["desktop", "previews", "bell"] as const;

function tuiEffect(key: (typeof TUI_KEYS)[number]): ConfigEffect {
  const path = `tui.${key}`;
  if (key === "mouse")
    return { path, effect: "restart", description: "Restart to update renderer mouse support." };
  return {
    path,
    effect: "immediate",
    description:
      key === "keybindings"
        ? "Clear reserved shortcut settings; no runtime keybindings are changed."
        : "Update the live terminal UI.",
  };
}
function tuiEffects(old: TuiSettings, value: TuiSettings): ConfigEffect[] {
  return TUI_KEYS.filter((key) => !equal(old[key], value[key])).map(tuiEffect);
}
function historyEffect(
  key: (typeof HISTORY_KEYS)[number],
  old: UserSettings["history"],
  value: UserSettings["history"],
): ConfigEffect {
  const path = `user.history.${key}`;
  const shortened =
    key === "retentionDays" &&
    value.retentionDays !== null &&
    (old.retentionDays === null || value.retentionDays < old.retentionDays);
  if (shortened)
    return {
      path,
      effect: "destructive",
      description:
        "Shortened retention may prune stored history; requires destructive permission and explicit confirmation.",
    };
  return {
    path,
    effect: "immediate",
    description:
      key === "persistDrafts"
        ? "Update draft persistence; disabling clears persisted drafts."
        : "Update history policy; existing history is retained except for retention pruning.",
  };
}
function userEffects(
  old: UserSettings,
  value: UserSettings,
  effects: ConfigEffect[],
  reconnectIds: NetworkId[],
): void {
  networkEffects(old.networks, value.networks, effects, reconnectIds);
  for (const key of HISTORY_KEYS) {
    if (!equal(old.history[key], value.history[key]))
      effects.push(historyEffect(key, old.history, value.history));
  }
  for (const key of NOTIFICATION_KEYS) {
    if (old.notifications[key] !== value.notifications[key])
      effects.push({
        path: `user.notifications.${key}`,
        effect: "immediate",
        description: "Update notification policy where supported by the platform.",
      });
  }
  if (old.sendTyping !== value.sendTyping)
    effects.push({
      path: "user.sendTyping",
      effect: "immediate",
      description: "Update typing publication where negotiated with the server.",
    });
}
function requiredPermissionsFor(effects: readonly ConfigEffect[]): ControlPermission[] {
  const requiredPermissions: ControlPermission[] = ["configure"];
  if (effects.some((effect) => effect.effect === "network")) requiredPermissions.push("network");
  if (effects.some((effect) => effect.effect === "destructive"))
    requiredPermissions.push("destructive");
  return requiredPermissions;
}
/** Apply a parsed edit to a copied section, rejecting unknown patch paths first. */
function editedSection(base: JsonObject, input: ConfigEdit): JsonValue {
  const shape = { $ref: `#/$defs/${input.section}` };
  if ("value" in input) {
    knownPatch(input.value, shape);
    return input.value;
  }
  knownPatch(input.patch, shape);
  let next: JsonValue = merge(base, input.patch);
  for (const path of input.unset ?? []) next = unsetPath(next, pathParts(path));
  return next;
}
function settingsChange(
  section: ConfigEdit["section"],
  next: JsonValue,
): SettingsChange | undefined {
  if (section === "user" && validUserSettings(next)) return { section: "user", value: next };
  if (section === "tui" && validTuiSettings(next)) return { section: "tui", value: next };
  return undefined;
}

/** Pure plan only. Caller must enforce permissions/confirmation and CAS against baseRevision at save. */
export function prepareConfigChange(
  document: SettingsDocument,
  edit: ConfigEdit,
): Result<ConfigPlan, ControlError> {
  const parsed = parseConfigEdit(edit);
  if (!parsed.ok) return parsed;
  try {
    const input = parsed.value;
    const base = cloneJson(document[input.section]);
    if (!object(base)) return failure();
    const next = editedSection(base, input);
    if (!fits(next, true)) return failure();
    const change = settingsChange(input.section, next);
    if (!change) return failure();
    const reconnectNetworkIds: NetworkId[] = [];
    const changed = !equal(base, next);
    let effects: ConfigEffect[] = [];
    if (change.section === "tui") {
      const keybindings = change.value.keybindings;
      if (!equal(document.tui.keybindings, keybindings) && Object.keys(keybindings).length > 0)
        return failure("unsupported");
      effects = tuiEffects(document.tui, change.value);
    } else userEffects(document.user, change.value, effects, reconnectNetworkIds);
    return {
      ok: true,
      value: {
        change,
        baseRevision: document.revision,
        effects,
        requiredPermissions: requiredPermissionsFor(effects),
        reconnectNetworkIds,
        changed,
      },
    };
  } catch {
    return failure();
  }
}
