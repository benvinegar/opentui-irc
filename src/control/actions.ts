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
    const network = () => opaqueId<"network">(action.networkId);
    const conversation = () => opaqueId<"conversation">(action.conversationId);
    const message = () => opaqueId<"message">(action.messageId);
    switch (type) {
      case "network.connect":
      case "network.disconnect":
      case "network.reconnect":
        return { ok: true, value: { type, networkId: network() } };
      case "conversation.activate":
      case "conversation.close":
      case "history.latest":
      case "history.delete":
        return { ok: true, value: { type, conversationId: conversation() } };
      case "conversation.join":
        return {
          ok: true,
          value: {
            type,
            networkId: network(),
            channel: bounded(action.channel, channelProperty),
            ...(action.key !== undefined ? { key: secretKey(action.key) } : {}),
          },
        };
      case "conversation.query":
        return {
          ok: true,
          value: { type, networkId: network(), nick: bounded(action.nick, queryNickProperty) },
        };
      case "conversation.mute":
        return {
          ok: true,
          value: { type, conversationId: conversation(), muted: boolean(action.muted) },
        };
      case "draft.set":
        return {
          ok: true,
          value: { type, conversationId: conversation(), text: string(action.text) },
        };
      case "message.send":
        return {
          ok: true,
          value: {
            type,
            conversationId: conversation(),
            text: bounded(action.text, messageProperty),
            kind: choice(action.kind, ["text", "action", "notice"]),
            ...(action.replyTo !== undefined
              ? { replyTo: opaqueId<"message">(action.replyTo) }
              : {}),
          },
        };
      case "message.react":
        return {
          ok: true,
          value: {
            type,
            messageId: message(),
            value: bounded(action.value, reactionProperty),
            remove: boolean(action.remove),
          },
        };
      case "message.redact":
      case "history.reveal":
        return { ok: true, value: { type, messageId: message() } };
      case "typing.set":
        return {
          ok: true,
          value: {
            type,
            conversationId: conversation(),
            active: boolean(action.active),
            ...(action.paused !== undefined ? { paused: boolean(action.paused) } : {}),
          },
        };
      case "history.load-older":
        return {
          ok: true,
          value: {
            type,
            conversationId: conversation(),
            ...(action.cursor !== undefined
              ? { cursor: opaqueId<"cursor">(action.cursor, 16384) }
              : {}),
          },
        };
      case "view.report":
        return {
          ok: true,
          value: {
            type,
            conversationId: conversation(),
            focused: boolean(action.focused),
            atBottom: boolean(action.atBottom),
            ...(action.lastVisibleMessageId !== undefined
              ? { lastVisibleMessageId: opaqueId<"message">(action.lastVisibleMessageId) }
              : {}),
          },
        };
      case "irc.request":
        return {
          ok: true,
          value: { type, networkId: network(), command: ircCommand(action.command) },
        };
    }
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

export function permissionsForAction(action: AppAction): readonly ControlPermission[] {
  switch (action.type) {
    case "message.send":
    case "message.react":
    case "typing.set":
    case "draft.set":
      return ["send-messages"];
    case "message.redact":
      return ["send-messages", "destructive"];
    case "history.delete":
      return ["destructive"];
    case "history.load-older":
    case "history.latest":
    case "history.reveal":
    case "view.report":
      return ["read-messages"];
    case "conversation.activate":
      return ["inspect"];
    case "conversation.mute":
      return ["configure"];
    case "irc.request":
      return action.command.type === "topic" && action.command.text !== undefined
        ? ["network", "send-messages"]
        : ["network"];
    case "network.connect":
    case "network.disconnect":
    case "network.reconnect":
    case "conversation.join":
    case "conversation.query":
    case "conversation.close":
      return ["network"];
  }
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
