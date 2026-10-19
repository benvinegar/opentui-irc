import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../src/contracts/control";
import { configurationSchema } from "../../src/control/schema";
import { defaultTuiSettings, defaultUserSettings } from "../../src/storage/settings";
import { validTuiSettings, validUserSettings } from "../../src/storage/validation";
import { profile, settings } from "../fixtures/scenario";

function object(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredObject(value: JsonValue | undefined): JsonObject {
  if (!object(value)) throw new Error("Expected schema object");
  return value;
}
function definition(root: JsonObject, name: string): JsonObject {
  return requiredObject(requiredObject(root.$defs)[name]);
}
function resolve(root: JsonObject, shape: JsonObject): JsonObject {
  return typeof shape.$ref === "string"
    ? definition(root, shape.$ref.slice("#/$defs/".length))
    : shape;
}

// A dependency-free test interpreter for every assertion keyword used by our discovery schema.
// Runtime-only relational/string constraints are explicitly documented, not pretended to be JSON Schema.
function matches(root: JsonObject, value: unknown, shape: JsonObject): boolean {
  if (typeof shape.$ref === "string" && !matches(root, value, resolve(root, shape))) return false;
  if (shape.const !== undefined && value !== shape.const) return false;
  if (Array.isArray(shape.enum) && !shape.enum.includes(value)) return false;
  const typeMatches = (type: unknown) =>
    type === "null"
      ? value === null
      : type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? typeof value === "object" && value !== null && !Array.isArray(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : typeof value === type;
  if (
    shape.type !== undefined &&
    !(Array.isArray(shape.type) ? shape.type.some(typeMatches) : typeMatches(shape.type))
  )
    return false;
  if (
    Array.isArray(shape.anyOf) &&
    !shape.anyOf.some((branch: JsonValue) => object(branch) && matches(root, value, branch))
  )
    return false;
  if (
    object(shape.if) &&
    matches(root, value, shape.if) &&
    object(shape.then) &&
    !matches(root, value, shape.then)
  )
    return false;
  if (
    typeof value === "number" &&
    ((typeof shape.minimum === "number" && value < shape.minimum) ||
      (typeof shape.maximum === "number" && value > shape.maximum))
  )
    return false;
  if (typeof value === "string") {
    if (typeof shape.minLength === "number" && Array.from(value).length < shape.minLength)
      return false;
    if (typeof shape.maxLength === "number" && Array.from(value).length > shape.maxLength)
      return false;
    if (typeof shape.pattern === "string" && !new RegExp(shape.pattern, "u").test(value))
      return false;
    if (shape.format === "ipv6" && isIP(value) !== 6) return false;
  }
  if (Array.isArray(value)) {
    if (typeof shape.minItems === "number" && value.length < shape.minItems) return false;
    if (typeof shape.maxItems === "number" && value.length > shape.maxItems) return false;
    if (
      shape.uniqueItems === true &&
      new Set(value.map((item: unknown) => JSON.stringify(item))).size !== value.length
    )
      return false;
    const items = shape.items;
    if (object(items) && !value.every((item: unknown) => matches(root, item, items))) return false;
  } else if (typeof value === "object" && value !== null) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (typeof shape.maxProperties === "number" && keys.length > shape.maxProperties) return false;
    if (
      Array.isArray(shape.required) &&
      !shape.required.every(
        (key: JsonValue) => typeof key === "string" && Object.hasOwn(value, key),
      )
    )
      return false;
    for (const key of keys) {
      if (object(shape.propertyNames) && !matches(root, key, shape.propertyNames)) return false;
      const declared = object(shape.properties) && Object.hasOwn(shape.properties, key);
      const child =
        declared && object(shape.properties) ? shape.properties[key] : shape.additionalProperties;
      if (child === false || (object(child) && !matches(root, descriptors[key]?.value, child)))
        return false;
    }
  }
  return true;
}

const fullProfile = {
  ...profile,
  serverPassword: "env:IRC_SERVER_PASSWORD",
  sasl: {
    mechanism: "PLAIN",
    account: "user",
    password: "keychain:12345678-abcd-1234-abcd-123456789abc",
    required: true,
  },
  autoJoin: [{ channel: "#channel", key: "env:CHANNEL_KEY" }],
};

describe("configuration discovery schema", () => {
  it("is fresh, serializable JSON Schema for the complete revisioned document", () => {
    const schema = configurationSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(schema.required).toEqual(["revision", "user", "tui"]);
    expect(requiredObject(requiredObject(schema.properties).revision).readOnly).toBe(true);
    expect(matches(schema, settings, schema)).toBe(true);
    expect(
      matches(
        schema,
        {
          ...settings,
          user: {
            ...settings.user,
            networks: [fullProfile],
            history: {
              ...settings.user.history,
              excludedConversations: [
                { networkId: profile.id, kind: "status", name: "Status view" },
              ],
            },
          },
        },
        schema,
      ),
    ).toBe(true);
    const defs = requiredObject(schema.$defs);
    expect(Object.keys(defs)).toEqual(
      expect.arrayContaining([
        "user",
        "tui",
        "networkProfile",
        "endpoint",
        "identity",
        "sasl",
        "autoJoin",
        "historyExclusion",
        "history",
        "notifications",
        "secretReference",
      ]),
    );
    Object.assign(defs, { user: {} });
    expect(definition(configurationSchema(), "user").default).toEqual(defaultUserSettings());
  });
  it("publishes authoritative defaults, all accepted by both schema and runtime validators", () => {
    const schema = configurationSchema();
    const user = definition(schema, "user");
    const tui = definition(schema, "tui");
    expect(user.default).toEqual(defaultUserSettings());
    expect(tui.default).toEqual(defaultTuiSettings());
    expect(validUserSettings(user.default)).toBe(true);
    expect(validTuiSettings(tui.default)).toBe(true);
    expect(matches(schema, user.default, user)).toBe(true);
    expect(matches(schema, tui.default, tui)).toBe(true);
    function visit(shape: JsonObject): void {
      if (Object.hasOwn(shape, "default"))
        expect(matches(schema, shape.default, shape), String(shape.description)).toBe(true);
      for (const value of Object.values(shape)) {
        if (object(value)) visit(value);
        else if (Array.isArray(value)) for (const item of value) if (object(item)) visit(item);
      }
    }
    visit(schema);
    expect(definition(schema, "networkProfile")).not.toHaveProperty("default");
  });
  it("represents every current setting field and optional field with descriptions/effects", () => {
    const schema = configurationSchema();
    const specimens: Readonly<Record<string, unknown>> = {
      user: {
        ...settings.user,
        networks: [fullProfile],
        history: {
          ...settings.user.history,
          excludedConversations: [{ networkId: profile.id, kind: "channel", name: "#one" }],
        },
      },
      tui: { ...settings.tui },
    };
    function visit(value: unknown, raw: JsonObject): void {
      const shape = resolve(schema, raw);
      if (typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, requiredObject(shape.items));
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const properties = requiredObject(shape.properties);
      expect(Object.keys(properties).sort()).toEqual(Object.keys(descriptors).sort());
      expect(shape.additionalProperties).toBe(false);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const child = requiredObject(properties[key]);
        expect(typeof child.description, key).toBe("string");
        expect(Array.isArray(child["x-effects"]), key).toBe(true);
        if (key !== "keybindings") visit(descriptor.value, child);
      }
    }
    for (const [key, value] of Object.entries(specimens)) visit(value, definition(schema, key));
    expect(definition(schema, "networkProfile").required).not.toContain("serverPassword");
    expect(definition(schema, "networkProfile").required).not.toContain("sasl");
    expect(definition(schema, "autoJoin").required).not.toContain("key");
  });
  it("expresses primitive, array, object, secret and TLS constraints consistently", () => {
    const schema = configurationSchema();
    const user = definition(schema, "user");
    const tui = definition(schema, "tui");
    const variants = [
      { ...settings.user, extra: true },
      { ...settings.user, schemaVersion: 2 },
      { ...settings.user, sendTyping: "true" },
      ...[0, -1, 36501, 2.5, "30"].map((retentionDays) => ({
        ...settings.user,
        history: { ...settings.user.history, retentionDays },
      })),
      ...[
        [],
        Array.from({ length: 17 }, () => profile.endpoints[0]),
        [{ host: "user@host", port: 6697, tls: true }],
        [{ host: "host/path", port: 6697, tls: true }],
        [{ host: "host:6697", port: 6697, tls: true }],
        [{ host: "::invalid", port: 6697, tls: true }],
        [{ host: "localhost", port: 0, tls: true }],
        [{ host: "localhost", port: 65536, tls: true }],
        [{ host: "localhost", port: 6697.5, tls: true }],
      ].map((endpoints) => ({ ...settings.user, networks: [{ ...profile, endpoints }] })),
      { ...settings.user, networks: [{ ...profile, name: "  " }] },
      {
        ...settings.user,
        networks: [{ ...profile, identity: { ...profile.identity, realname: "bad\nname" } }],
      },
      { ...settings.user, networks: [{ ...profile, autoJoin: [{ channel: "missing-prefix" }] }] },
      { ...settings.user, networks: [{ ...profile, autoJoin: [{ channel: "#has space" }] }] },
      { ...settings.user, networks: [{ ...fullProfile, serverPassword: "plaintext" }] },
      {
        ...settings.user,
        networks: [{ ...fullProfile, sasl: { ...fullProfile.sasl, mechanism: "EXTERNAL" } }],
      },
      {
        ...settings.user,
        networks: [{ ...fullProfile, endpoints: [{ host: "localhost", port: 6667, tls: false }] }],
      },
      {
        ...settings.user,
        history: {
          ...settings.user.history,
          excludedConversations: [{ networkId: profile.id, kind: "direct", name: "bad name" }],
        },
      },
    ];
    for (const value of variants) {
      expect(matches(schema, value, user), JSON.stringify(value)).toBe(false);
      expect(validUserSettings(value)).toBe(false);
    }
    for (const value of [
      { ...settings.tui, theme: "blue" },
      { ...settings.tui, mouse: 1 },
      { ...settings.tui, density: "dense" },
      { ...settings.tui, sidebarWidth: 11 },
      { ...settings.tui, sidebarWidth: 81 },
      { ...settings.tui, keybindings: { "bad action": [] } },
      { ...settings.tui, keybindings: { send: Array(11).fill("Ctrl+Enter") } },
    ]) {
      expect(matches(schema, value, tui)).toBe(false);
      expect(validTuiSettings(value)).toBe(false);
    }
    for (const retentionDays of [null, 1, 36500])
      expect(
        matches(
          schema,
          { ...settings.user, history: { ...settings.user.history, retentionDays } },
          user,
        ),
      ).toBe(true);
    for (const host of ["localhost", "127.0.0.1", "::1", "2001:db8::1"])
      expect(
        matches(
          schema,
          {
            ...settings.user,
            networks: [{ ...profile, endpoints: [{ host, port: 6697, tls: true }] }],
          },
          user,
        ),
      ).toBe(true);
  });
  it("documents runtime effects, permissions and expressiveness limitations instead of false promises", () => {
    const schema = configurationSchema();
    const ui = requiredObject(definition(schema, "tui").properties);
    expect(requiredObject(ui.mouse)["x-effects"]).toEqual(["restart"]);
    expect(requiredObject(ui.keybindings)["x-effects"]).toEqual(["unsupported"]);
    const retention = requiredObject(
      requiredObject(definition(schema, "history").properties).retentionDays,
    );
    expect(retention["x-effects"]).toContain("destructive");
    const control = requiredObject(schema["x-control"]);
    expect(control.secrets).toContain("no resolve/get");
    expect(control.validation).toContain("storage/validation.ts is authoritative");
    expect(control.validation).toContain("UTF-16");
    expect(control.validation).toContain("foreign keys");
    expect(control.reconnect).toContain("never silently reconnect");
    for (const value of ["env:SECRET\n", "env:SECRET\r", "env:SECRET\t"])
      expect(matches(schema, value, definition(schema, "secretReference"))).toBe(false);
  });
});
