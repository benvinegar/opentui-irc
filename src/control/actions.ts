import type { AppAction, UserIrcCommand } from "../contracts/app";
import type { Result } from "../contracts/common";
import type { ControlError, ControlPermission, JsonObject } from "../contracts/control";
import { secretReference } from "../storage/validation";
import {
  boolean,
  choice,
  ControlFault,
  fail,
  fields,
  opaqueId,
  OPAQUE_ID_PATTERN,
  string,
} from "./validation";

type Shape = { readonly required: readonly string[]; readonly optional?: readonly string[] };
const SHAPES = {
  "network.connect": { required: ["networkId"] },
  "network.disconnect": { required: ["networkId"] },
  "network.reconnect": { required: ["networkId"] },
  "conversation.activate": { required: ["conversationId"] },
  "conversation.close": { required: ["conversationId"] },
  "conversation.join": { required: ["networkId", "channel"], optional: ["key"] },
  "conversation.query": { required: ["networkId", "nick"] },
  "conversation.mute": { required: ["conversationId", "muted"] },
  "draft.set": { required: ["conversationId", "text"] },
  "message.send": { required: ["conversationId", "text", "kind"], optional: ["replyTo"] },
  "message.react": { required: ["messageId", "value", "remove"] },
  "message.redact": { required: ["messageId"] },
  "typing.set": { required: ["conversationId", "active"], optional: ["paused"] },
  "history.load-older": { required: ["conversationId"], optional: ["cursor"] },
  "history.latest": { required: ["conversationId"] },
  "history.reveal": { required: ["messageId"] },
  "history.delete": { required: ["conversationId"] },
  "view.report": {
    required: ["conversationId", "focused", "atBottom"],
    optional: ["lastVisibleMessageId"],
  },
  "irc.request": { required: ["networkId", "command"] },
} as const satisfies Record<AppAction["type"], Shape>;

const COMMAND_SHAPES = {
  nick: { required: ["nick"] },
  away: { required: ["reason"] },
  whois: { required: ["nick"] },
  list: { required: [] },
  topic: { required: ["channel"], optional: ["text"] },
} as const satisfies Record<UserIrcCommand["type"], Shape>;

function ircCommand(value: unknown): UserIrcCommand {
  const base = fields(value, ["type"], ["nick", "reason", "channel", "text"]);
  const type = choice(base.type, ["nick", "away", "whois", "list", "topic"]);
  const spec: Shape = COMMAND_SHAPES[type];
  const command = fields(value, ["type", ...spec.required], spec.optional);
  switch (type) {
    case "nick":
    case "whois":
      return { type, nick: bounded(command.nick, nickProperty) };
    case "away":
      return {
        type,
        reason: command.reason === null ? null : bounded(command.reason, awayProperty),
      };
    case "list":
      return { type };
    case "topic":
      return {
        type,
        channel: bounded(command.channel, channelProperty),
        ...(command.text !== undefined ? { text: bounded(command.text, contentProperty) } : {}),
      };
  }
}

type ActionType = AppAction["type"];
type ActionOf<Type extends ActionType> = Extract<AppAction, { readonly type: Type }>;
type ActionFields = Record<string, unknown>;

const networkId = (action: ActionFields) => opaqueId<"network">(action.networkId);
const conversationId = (action: ActionFields) => opaqueId<"conversation">(action.conversationId);
const messageId = (action: ActionFields) => opaqueId<"message">(action.messageId);
function networkAction<Type extends "network.connect" | "network.disconnect" | "network.reconnect">(
  action: ActionFields,
  type: Type,
) {
  return { type, networkId: networkId(action) };
}
function conversationAction<
  Type extends "conversation.activate" | "conversation.close" | "history.latest" | "history.delete",
>(action: ActionFields, type: Type) {
  return { type, conversationId: conversationId(action) };
}
function messageAction<Type extends "message.redact" | "history.reveal">(
  action: ActionFields,
  type: Type,
) {
  return { type, messageId: messageId(action) };
}

/** Fields are validated in property order, which fixes the first reported error. */
const ACTION_PARSERS: {
  readonly [Type in ActionType]: (action: ActionFields, type: Type) => ActionOf<Type>;
} = {
  "network.connect": networkAction,
  "network.disconnect": networkAction,
  "network.reconnect": networkAction,
  "conversation.activate": conversationAction,
  "conversation.close": conversationAction,
  "history.latest": conversationAction,
  "history.delete": conversationAction,
  "conversation.join": (action, type) => ({
    type,
    networkId: networkId(action),
    channel: bounded(action.channel, channelProperty),
    ...(action.key !== undefined ? { key: secretKey(action.key) } : {}),
  }),
  "conversation.query": (action, type) => ({
    type,
    networkId: networkId(action),
    nick: bounded(action.nick, queryNickProperty),
  }),
  "conversation.mute": (action, type) => ({
    type,
    conversationId: conversationId(action),
    muted: boolean(action.muted),
  }),
  "draft.set": (action, type) => ({
    type,
    conversationId: conversationId(action),
    text: string(action.text),
  }),
  "message.send": (action, type) => ({
    type,
    conversationId: conversationId(action),
    text: bounded(action.text, messageProperty),
    kind: choice(action.kind, ["text", "action", "notice"]),
    ...(action.replyTo !== undefined ? { replyTo: opaqueId<"message">(action.replyTo) } : {}),
  }),
  "message.react": (action, type) => ({
    type,
    messageId: messageId(action),
    value: bounded(action.value, reactionProperty),
    remove: boolean(action.remove),
  }),
  "message.redact": messageAction,
  "history.reveal": messageAction,
  "typing.set": (action, type) => ({
    type,
    conversationId: conversationId(action),
    active: boolean(action.active),
    ...(action.paused !== undefined ? { paused: boolean(action.paused) } : {}),
  }),
  "history.load-older": (action, type) => ({
    type,
    conversationId: conversationId(action),
    ...(action.cursor !== undefined ? { cursor: opaqueId<"cursor">(action.cursor, 16384) } : {}),
  }),
  "view.report": (action, type) => ({
    type,
    conversationId: conversationId(action),
    focused: boolean(action.focused),
    atBottom: boolean(action.atBottom),
    ...(action.lastVisibleMessageId !== undefined
      ? { lastVisibleMessageId: opaqueId<"message">(action.lastVisibleMessageId) }
      : {}),
  }),
  "irc.request": (action, type) => ({
    type,
    networkId: networkId(action),
    command: ircCommand(action.command),
  }),
};
function parseTypedAction<Type extends ActionType>(
  type: Type,
  action: ActionFields,
): ActionOf<Type> {
  const parse = ACTION_PARSERS[type];
  return parse(action, type);
}

export function parseAppAction(value: unknown): Result<AppAction, ControlError> {
  try {
    const base = fields(
      value,
      ["type"],
      [
        ...new Set(
          Object.values(SHAPES).flatMap((shape: Shape) => [
            ...shape.required,
            ...(shape.optional ?? []),
          ]),
        ),
      ],
    );
    const type = choice(base.type, Object.keys(SHAPES) as AppAction["type"][]);
    const spec: Shape = SHAPES[type];
    const action = fields(value, ["type", ...spec.required], spec.optional);
    return { ok: true, value: parseTypedAction(type, action) };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof ControlFault
          ? cause.detail
          : { code: "invalid-input", message: "Invalid application action.", retryable: false },
    };
  }
}

/** Rights each action requires. This is a security boundary: keep every entry explicit. */
const ACTION_PERMISSIONS = {
  "message.send": ["send-messages"],
  "message.react": ["send-messages"],
  "typing.set": ["send-messages"],
  "draft.set": ["send-messages"],
  "message.redact": ["send-messages", "destructive"],
  "history.delete": ["destructive"],
  "history.load-older": ["read-messages"],
  "history.latest": ["read-messages"],
  "history.reveal": ["read-messages"],
  "view.report": ["read-messages"],
  "conversation.activate": ["inspect"],
  "conversation.mute": ["configure"],
  "irc.request": ["network"],
  "network.connect": ["network"],
  "network.disconnect": ["network"],
  "network.reconnect": ["network"],
  "conversation.join": ["network"],
  "conversation.query": ["network"],
  "conversation.close": ["network"],
} as const satisfies Record<ActionType, readonly ControlPermission[]>;

export function permissionsForAction(action: AppAction): readonly ControlPermission[] {
  // Topic writes publish text, so they need send rights beyond other IRC requests.
  if (
    action.type === "irc.request" &&
    action.command.type === "topic" &&
    action.command.text !== undefined
  )
    return ["network", "send-messages"];
  return [...ACTION_PERMISSIONS[action.type]];
}

const stringProperty: JsonObject = { type: "string", maxLength: 65536 };
const identifierProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: OPAQUE_ID_PATTERN,
};
const nickProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\s\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff,:]+$",
};
const queryNickProperty: JsonObject = { ...nickProperty, maxLength: 100 };
const channelProperty: JsonObject = {
  type: "string",
  minLength: 2,
  maxLength: 200,
  pattern: "^[#&+!][^\\s\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff,:]+$",
};
const reactionProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[^\\s\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]+$",
};
const contentProperty: JsonObject = { ...stringProperty, pattern: "^[^\\r\\n\\u0000]*$" };
const awayProperty: JsonObject = { ...contentProperty, maxLength: 4096 };
const messageProperty: JsonObject = {
  ...stringProperty,
  minLength: 1,
  pattern: "^(?=[\\s\\S]*\\S)[^\\r\\u0000\\u0001]*$",
};
const secretProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 260,
  pattern:
    "^(env:[A-Za-z_][A-Za-z0-9_]{0,255}|keychain:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$",
  description: "Secret reference only, never plaintext or a resolved credential.",
};
/** Schema and input parser share bounds/patterns; app/session still own contextual validation. */
function bounded(value: unknown, shape: JsonObject): string {
  const text = string(value, typeof shape.maxLength === "number" ? shape.maxLength : 65536);
  if (
    (typeof shape.minLength === "number" && text.length < shape.minLength) ||
    (typeof shape.pattern === "string" && !new RegExp(shape.pattern, "u").test(text))
  )
    fail("invalid-input", "Action text does not match the documented constraints.");
  return text;
}
function secretKey(value: unknown) {
  const reference = bounded(value, secretProperty);
  if (!secretReference(reference)) fail("invalid-input", "A valid secret reference is required.");
  return opaqueId<"secret-ref">(reference);
}
function propertiesFor(shape: Shape, type: string): JsonObject {
  return Object.fromEntries(
    [...shape.required, ...(shape.optional ?? [])].map((name) => [
      name,
      ["muted", "remove", "active", "paused", "focused", "atBottom"].includes(name)
        ? { type: "boolean" }
        : name === "kind"
          ? { enum: ["text", "action", "notice"] }
          : name === "reason"
            ? { ...awayProperty, type: ["string", "null"] }
            : name === "cursor"
              ? { ...identifierProperty, maxLength: 16384 }
              : name === "nick"
                ? type === "conversation.query"
                  ? queryNickProperty
                  : nickProperty
                : name === "channel"
                  ? channelProperty
                  : name === "value"
                    ? reactionProperty
                    : name === "key"
                      ? secretProperty
                      : name === "text"
                        ? type === "message.send"
                          ? messageProperty
                          : type === "topic"
                            ? contentProperty
                            : stringProperty
                        : name.endsWith("Id") || name === "replyTo"
                          ? identifierProperty
                          : stringProperty,
    ]),
  );
}
export function actionSchema(): JsonObject {
  const commandSchema = {
    oneOf: Object.entries(COMMAND_SHAPES).map(([type, spec]) => ({
      type: "object",
      additionalProperties: false,
      required: ["type", ...spec.required],
      properties: { type: { type: "string", const: type }, ...propertiesFor(spec, type) },
    })),
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "opentui-irc AppAction",
    description:
      "All supported typed actions. Rights require both server grant and request intent. Destructive actions also require confirm:true. IRC away/nick publish presence/identity under network permission; topic writes require send-messages too.",
    "x-runtime-validation":
      "Bounds use UTF-16 code units at runtime (schema lengths count code points). App/session enforce current network capabilities, channel prefixes, connection state, membership, reply targets and ownership. No raw IRC or command batches. Actions do not return message/draft bodies.",
    oneOf: Object.entries(SHAPES).map(([type, spec]) => ({
      type: "object",
      additionalProperties: false,
      required: ["type", ...spec.required],
      properties: {
        type: { type: "string", const: type },
        ...propertiesFor(spec, type),
        ...(type === "irc.request" ? { command: commandSchema } : {}),
      },
    })),
  };
}
