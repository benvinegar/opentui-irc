import type { AppAction, UserIrcCommand } from "../contracts/app";
import type { Result } from "../contracts/common";
import type { ControlError, ControlPermission, JsonObject } from "../contracts/control";
import { boolean, choice, ControlFault, fields, opaqueId, string } from "./validation";

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
  "typing.set": { required: ["conversationId", "active"] },
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
      return { type, nick: string(command.nick, 512) };
    case "away":
      return { type, reason: command.reason === null ? null : string(command.reason, 4096) };
    case "list":
      return { type };
    case "topic":
      return {
        type,
        channel: string(command.channel, 512),
        ...(command.text !== undefined ? { text: string(command.text) } : {}),
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
            channel: string(action.channel, 512),
            ...(action.key !== undefined ? { key: opaqueId<"secret-ref">(action.key) } : {}),
          },
        };
      case "conversation.query":
        return { ok: true, value: { type, networkId: network(), nick: string(action.nick, 512) } };
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
            text: string(action.text),
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
            value: string(action.value, 64),
            remove: boolean(action.remove),
          },
        };
      case "message.redact":
      case "history.reveal":
        return { ok: true, value: { type, messageId: message() } };
      case "typing.set":
        return {
          ok: true,
          value: { type, conversationId: conversation(), active: boolean(action.active) },
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
const identifierProperty: JsonObject = { type: "string", minLength: 1, maxLength: 512 };
function propertiesFor(shape: Shape): JsonObject {
  return Object.fromEntries(
    [...shape.required, ...(shape.optional ?? [])].map((name) => [
      name,
      ["muted", "remove", "active", "focused", "atBottom"].includes(name)
        ? { type: "boolean" }
        : name === "kind"
          ? { enum: ["text", "action", "notice"] }
          : name === "reason"
            ? { type: ["string", "null"], maxLength: 4096 }
            : name === "cursor"
              ? { type: "string", minLength: 1, maxLength: 16384 }
              : name.endsWith("Id") || ["replyTo", "key"].includes(name)
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
      properties: { type: { const: type }, ...propertiesFor(spec) },
    })),
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: Object.entries(SHAPES).map(([type, spec]) => ({
      type: "object",
      additionalProperties: false,
      required: ["type", ...spec.required],
      properties: {
        type: { const: type },
        ...propertiesFor(spec),
        ...(type === "irc.request" ? { command: commandSchema } : {}),
      },
    })),
  };
}
