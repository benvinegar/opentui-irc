import { describe, expect, it } from "vitest";
import { entityId } from "../../src/contracts/common";
import type { ConfigEdit, JsonObject } from "../../src/contracts/control";
import type { SettingsDocument } from "../../src/contracts/settings";
import { parseConfigEdit, prepareConfigChange } from "../../src/control/config";
import { settings, profile } from "../fixtures/scenario";

function plan(value: unknown, document = settings) {
  const parsed = parseConfigEdit(value);
  if (!parsed.ok) throw new Error("Invalid test edit");
  return prepareConfigChange(document, parsed.value);
}
function success(value: unknown, document = settings) {
  const result = plan(value, document);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected test plan");
  return result.value;
}
function reject(value: unknown, document = settings) {
  const parsed = parseConfigEdit(value);
  const result = parsed.ok ? prepareConfigChange(document, parsed.value) : parsed;
  expect(result).toEqual({
    ok: false,
    error: {
      code: "invalid-input",
      message: "Configuration edit is invalid or exceeds supported limits.",
      retryable: false,
    },
  });
}
const protectedProfile = {
  ...profile,
  serverPassword: "env:IRC_SERVER",
  sasl: { mechanism: "PLAIN", account: "account", password: "env:IRC_PASSWORD", required: true },
  autoJoin: [{ channel: "#private", key: "env:CHANNEL_KEY" }, { channel: "#public" }],
};

describe("config edit parsing", () => {
  it("clones patches, replacements and unset arrays without mutating callers", () => {
    const original = {
      section: "user",
      patch: { history: { retentionDays: null } },
      unset: ["networks.0.sasl"],
    };
    const parsed = parseConfigEdit(original);
    expect(parsed).toEqual({ ok: true, value: original });
    original.patch.history.retentionDays = null;
    original.unset.push("notifications.bell");
    if (!parsed.ok || !("unset" in parsed.value)) throw new Error("Expected parsed unset");
    expect(parsed.value.unset).toEqual(["networks.0.sasl"]);
    const replacement = { section: "tui", value: { theme: "dark" } };
    const clone = parseConfigEdit(replacement);
    replacement.value.theme = "light";
    expect(clone).toEqual({ ok: true, value: { section: "tui", value: { theme: "dark" } } });
  });
  it.each([
    null,
    [],
    true,
    {},
    { section: "revision", patch: {} },
    { section: "user" },
    { section: "user", patch: {}, value: {} },
    { section: "user", value: {}, unset: [] },
    { section: "user", patch: [] },
    { section: "user", patch: null },
    { section: "tui", patch: {}, surprise: "secret" },
    { section: "tui", patch: {}, unset: [1] },
    { section: "tui", patch: {}, unset: "mouse" },
    ...[
      "",
      ".theme",
      "history..enabled",
      "__proto__.polluted",
      "constructor",
      "prototype.x",
      "x.",
    ].map((path) => ({ section: "user", patch: {}, unset: [path] })),
    { section: "tui", patch: {}, unset: ["mouse", "mouse"] },
  ])("rejects invalid envelopes safely: %#", (value) => {
    expect(parseConfigEdit(value).ok).toBe(false);
  });
  it("rejects non-JSON objects, prototypes, accessors, sparse arrays, cycles and nonfinite values", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "theme", {
      enumerable: true,
      get() {
        calls++;
        return "dark";
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const inherited: unknown = Object.create({ theme: "dark" });
    const hidden = Object.defineProperty({}, "secret", { value: "not-json" });
    const symbol = { [Symbol("secret")]: "not-json" };
    const customArray = Object.assign([1], { extra: true });
    for (const patch of [
      accessor,
      cycle,
      inherited,
      hidden,
      symbol,
      new Date(),
      { x: undefined },
      { x: NaN },
      { x: Infinity },
      { x: 1n },
      { x: () => 1 },
      { x: Array(3) },
      { x: customArray },
    ]) {
      expect(parseConfigEdit({ section: "tui", patch }).ok).toBe(false);
    }
    expect(calls).toBe(0);
  });
  it("rejects prototype keys at every depth without pollution", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const patch: unknown = JSON.parse(`{"networks":[{"identity":{"${key}":{"polluted":true}}}]}`);
      expect(parseConfigEdit({ section: "user", patch }).ok).toBe(false);
      expect(parseConfigEdit({ section: "tui", patch: { keybindings: { [key]: [] } } }).ok).toBe(
        false,
      );
    }
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("bounds bytes, depth, node counts and unset counts", () => {
    expect(parseConfigEdit({ section: "user", patch: { value: "😀".repeat(300000) } }).ok).toBe(
      false,
    );
    expect(parseConfigEdit({ section: "user", patch: { value: "x".repeat(1048577) } }).ok).toBe(
      false,
    );
    let deep: unknown = {};
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(parseConfigEdit({ section: "user", patch: deep }).ok).toBe(false);
    expect(
      parseConfigEdit({
        section: "user",
        patch: { nodes: Array.from({ length: 100001 }, () => null) },
      }).ok,
    ).toBe(false);
    expect(
      parseConfigEdit({
        section: "user",
        patch: {},
        unset: Array.from({ length: 1001 }, (_, i) => `key${i}`),
      }).ok,
    ).toBe(false);
  });
});

describe("pure configuration plans", () => {
  it("deep patches objects, treats null literally, preserves siblings, and reports the CAS base without IO", () => {
    const before = structuredClone(settings);
    const result = success({
      section: "user",
      patch: { history: { retentionDays: null }, notifications: { bell: true } },
    });
    expect(result.change).toEqual({
      section: "user",
      value: {
        ...settings.user,
        history: { ...settings.user.history, retentionDays: null },
        notifications: { ...settings.user.notifications, bell: true },
      },
    });
    expect(result.baseRevision).toBe(settings.revision);
    expect(result.requiredPermissions).toEqual(["configure"]);
    expect(result.changed).toBe(true);
    expect(settings).toEqual(before);
    const revision = entityId<"config-revision">("other-cas-base");
    expect(success({ section: "tui", patch: {} }, { ...settings, revision }).baseRevision).toBe(
      revision,
    );
    reject({ section: "user", patch: { history: { enabled: null } } });
  });
  it("replaces arrays instead of merging elements or joining by ID", () => {
    const networks = [{ ...profile, autoJoin: [] }];
    const result = success({ section: "user", patch: { networks } });
    expect(result.change.value).toMatchObject({ networks });
    expect(result.reconnectNetworkIds).toEqual([profile.id]);
    expect(result.effects).toContainEqual(
      expect.objectContaining({ path: "user.networks.0.autoJoin", effect: "reconnect" }),
    );
    networks[0]!.name = "mutated caller input";
    expect(result.change.value).toMatchObject({ networks: [{ name: profile.name }] });
    reject({ section: "user", patch: { networks: [{ id: profile.id, name: "incomplete" }] } });
    expect(success({ section: "user", patch: { networks: [] } }).change.value).toMatchObject({
      networks: [],
    });
  });
  it("supports whole-section replacements, not partial replacements/default injection", () => {
    const replacement = { ...settings.tui, theme: "light" };
    const result = success({ section: "tui", value: replacement });
    expect(result.change).toEqual({ section: "tui", value: replacement });
    replacement.theme = "high-contrast";
    expect(result.change.value).toMatchObject({ theme: "light" });
    reject({ section: "tui", value: { theme: "light" } });
    reject({ section: "user", value: {} });
  });
  it("unsets optional properties through arrays while preserving siblings", () => {
    const base = success({ section: "user", patch: { networks: [protectedProfile] } }).change;
    if (base.section !== "user") throw new Error("Expected user section");
    const document = { ...settings, user: base.value };
    const result = success(
      {
        section: "user",
        patch: {},
        unset: ["networks.0.sasl", "networks.0.serverPassword", "networks.0.autoJoin.0.key"],
      },
      document,
    );
    expect(result.change.value).toMatchObject({
      networks: [{ ...profile, autoJoin: [{ channel: "#private" }, { channel: "#public" }] }],
    });
    if (result.change.section !== "user") throw new Error("Expected user");
    expect(result.change.value.networks[0]).not.toHaveProperty("sasl");
    expect(result.change.value.networks[0]).not.toHaveProperty("serverPassword");
    expect(result.reconnectNetworkIds).toEqual([profile.id]);
    expect(document.user.networks[0]?.sasl).toBeDefined();
  });
  it.each([
    "history.enabled",
    "history",
    "networks.0.identity.nick",
    "networks.0",
    "networks.0.identity",
    "networks.1.sasl",
    "networks.-1.sasl",
    "networks.00.name",
    "networks.length",
    "history.unknown",
    "networks.0.sasl",
    "theme",
  ])("rejects required, unknown or invalid unset paths: %s", (path) => {
    reject({ section: "user", patch: {}, unset: [path] });
  });
  it("rejects unknown paths even if unset hides them, and rejects invalid nested fields", () => {
    reject({
      section: "user",
      patch: { history: { surprise: true } },
      unset: ["history.surprise"],
    });
    reject({
      section: "user",
      patch: { networks: [{ ...profile, surprise: true }] },
      unset: ["networks.0.surprise"],
    });
    for (const patch of [
      { unknown: true },
      { notifications: { token: "secret" } },
      { history: { retentionDays: 0 } },
      { schemaVersion: 2 },
      { history: { retentionDays: 1.5 } },
      { sendTyping: "yes" },
      { networks: [{ ...profile, endpoints: [{ host: "localhost", port: "6697", tls: true }] }] },
      { networks: [{ ...profile, identity: { ...profile.identity, nick: "white space" } }] },
    ])
      reject({ section: "user", patch });
    reject({ section: "tui", patch: { sidebarWidth: 81 } });
    reject({ section: "tui", patch: { sidebarWidth: 11 } });
  });
  it("validates foreign keys and cross-field uniqueness using the storage validator", () => {
    reject({ section: "user", patch: { networks: [profile, profile] } });
    reject({
      section: "user",
      patch: { networks: [{ ...profile, autoJoin: [{ channel: "#one" }, { channel: "#one" }] }] },
    });
    reject({
      section: "user",
      patch: {
        networks: [
          {
            ...profile,
            identity: { ...profile.identity, alternateNicks: [profile.identity.nick] },
          },
        ],
      },
    });
    reject({
      section: "user",
      patch: {
        history: { excludedConversations: [{ networkId: "missing", kind: "channel", name: "#a" }] },
      },
    });
  });
  it("rejects plaintext secrets and unsafe hosts/authentication without echoing values", () => {
    for (const host of [
      "irc://user:credential@example.com",
      "example.com:6697",
      "[::1]",
      "host/path",
      "user@host",
      "has space",
    ])
      reject({
        section: "user",
        patch: { networks: [{ ...profile, endpoints: [{ host, port: 6697, tls: true }] }] },
      });
    for (const host of ["localhost", "127.0.0.1", "::1", "2001:db8::1"])
      expect(
        plan({
          section: "user",
          patch: { networks: [{ ...profile, endpoints: [{ host, port: 6697, tls: true }] }] },
        }).ok,
      ).toBe(true);
    for (const password of [
      "env:IRC_PASSWORD\n",
      "env:IRC_PASSWORD\r",
      "env:IRC_PASSWORD\t",
      "env:IRC_PASSWORD\u0000",
      "env:IRC_PASSWORD\ud800",
      "password-must-not-echo",
      "env:BAD NAME",
      "env:",
      "keychain:password",
      "file:/secrets/password",
      null,
      { value: "password" },
    ]) {
      reject({ section: "user", patch: { networks: [{ ...profile, serverPassword: password }] } });
      reject({
        section: "user",
        patch: {
          networks: [{ ...protectedProfile, sasl: { ...protectedProfile.sasl, password } }],
        },
      });
      reject({
        section: "user",
        patch: { networks: [{ ...profile, autoJoin: [{ channel: "#secret", key: password }] }] },
      });
    }
    reject({
      section: "user",
      patch: {
        networks: [
          { ...protectedProfile, endpoints: [{ host: "localhost", port: 6667, tls: false }] },
        ],
      },
    });
    reject({
      section: "user",
      patch: {
        networks: [
          { ...protectedProfile, sasl: { ...protectedProfile.sasl, mechanism: "EXTERNAL" } },
        ],
      },
    });
    expect(
      plan({
        section: "user",
        patch: {
          networks: [
            {
              ...protectedProfile,
              serverPassword: "keychain:12345678-abcd-1234-abcd-123456789abc",
            },
          ],
        },
      }).ok,
    ).toBe(true);
  });
  it("bounds final merged pretty-printed configuration, not only the patch", () => {
    const makeProfile = (index: number) => ({
      ...profile,
      id: `id-${index}`,
      autoJoin: Array.from({ length: 1000 }, (_, j) => ({ channel: `#${j}-${"x".repeat(490)}` })),
    });
    reject({
      section: "user",
      patch: { networks: [makeProfile(0), makeProfile(1), makeProfile(2)] },
    });
    const largeEdit = { section: "user", patch: { networks: [makeProfile(0), makeProfile(1)] } };
    expect(parseConfigEdit(largeEdit).ok).toBe(true);
    reject(largeEdit); // Compact request fits; pretty-printed persistence would not.
    const many = Array.from({ length: 1000 }, (_, i) => ({ channel: `#${i}-${"x".repeat(490)}` }));
    const initial = success({
      section: "user",
      patch: { networks: [{ ...profile, autoJoin: many }] },
    }).change;
    if (initial.section !== "user") throw new Error("Expected user section");
    reject(
      {
        section: "user",
        patch: {
          history: {
            excludedConversations: Array.from({ length: 1000 }, (_, index) => ({
              networkId: profile.id,
              kind: "direct",
              name: `${index}-${"x".repeat(490)}`,
            })),
          },
        },
      },
      { ...settings, user: initial.value },
    );
  });
  it("revalidates typed edits, since casts/external callers do not make JSON trustworthy", () => {
    const edit: ConfigEdit = {
      section: "tui",
      patch: { keybindings: { constructor: ["Ctrl+X"] } },
    };
    expect(prepareConfigChange(settings, edit).ok).toBe(false);
  });
});

describe("effect and permission planning", () => {
  it("HistServ visibility is a validated immediate configure-only preference", () => {
    const result = success({ section: "tui", patch: { showHistServ: true } });
    expect(result.effects.map(({ path, effect }) => [path, effect])).toEqual([
      ["tui.showHistServ", "immediate"],
    ]);
    expect(result.requiredPermissions).toEqual(["configure"]);
    expect(result.reconnectNetworkIds).toEqual([]);
    expect(
      prepareConfigChange(settings, { section: "tui", patch: { showHistServ: "yes" } }).ok,
    ).toBe(false);
  });
  it("classifies live UI fields and restart-only mouse support", () => {
    const result = success({
      section: "tui",
      patch: {
        theme: "light",
        density: "compact",
        memberList: true,
        showHistServ: true,
        sidebarWidth: 32,
        mouse: false,
      },
    });
    expect(result.effects.map(({ path, effect }) => [path, effect])).toEqual([
      ["tui.theme", "immediate"],
      ["tui.density", "immediate"],
      ["tui.memberList", "immediate"],
      ["tui.showHistServ", "immediate"],
      ["tui.sidebarWidth", "immediate"],
      ["tui.mouse", "restart"],
    ]);
    expect(result.requiredPermissions).toEqual(["configure"]);
  });
  it("reports no-op plans with key-order-insensitive equality", () => {
    const reversed = Object.fromEntries(Object.entries(settings.tui).reverse());
    for (const edit of [
      { section: "user", patch: {} },
      { section: "tui", value: reversed },
    ]) {
      const result = success(edit);
      expect(result.changed).toBe(false);
      expect(result.effects).toEqual([]);
      expect(result.reconnectNetworkIds).toEqual([]);
    }
  });
  it("requires network permission for all additions, removals and autoConnect changes", () => {
    const second = { ...profile, id: "second", autoConnect: true };
    for (const networks of [[], [profile, second], [{ ...profile, autoConnect: true }], [second]]) {
      const result = success({ section: "user", patch: { networks } });
      expect(result.requiredPermissions).toEqual(["configure", "network"]);
      expect(result.effects.some((effect) => effect.effect === "network")).toBe(true);
      expect(result.reconnectNetworkIds).toEqual([]);
    }
    const added = success({ section: "user", patch: { networks: [profile, second] } });
    expect(added.effects[0]?.description).toContain("connect immediately");
    const removed = success({ section: "user", patch: { networks: [] } });
    expect(removed.effects[0]?.description).toContain("disconnects");
    expect(removed.effects[0]?.description).toContain("history is retained");
  });
  it.each([
    ["endpoints", [{ host: "different.example", port: 6697, tls: true }]],
    ["identity", { ...profile.identity, nick: "changed" }],
    ["serverPassword", "env:NEW_PASSWORD"],
    ["sasl", protectedProfile.sasl],
    ["autoJoin", [{ channel: "#new" }]],
  ])(
    "reports explicit reconnect IDs for existing %s changes, without network permission or IO",
    (key, value) => {
      const result = success({
        section: "user",
        patch: { networks: [{ ...profile, [key]: value }] },
      });
      expect(result.reconnectNetworkIds).toEqual([profile.id]);
      expect(result.requiredPermissions).toEqual(["configure"]);
      expect(result.effects).toEqual([
        {
          path: `user.networks.0.${key}`,
          effect: "reconnect",
          description:
            "Applies on the next explicit connection; this edit never reconnects automatically.",
        },
      ]);
    },
  );
  it("deduplicates reconnect IDs and detects profile order/display-only changes", () => {
    const result = success({
      section: "user",
      patch: { networks: [{ ...protectedProfile, name: "Updated name" }] },
    });
    expect(result.reconnectNetworkIds).toEqual([profile.id]);
    expect(result.effects.filter((effect) => effect.effect === "reconnect")).toHaveLength(3);
    expect(result.effects.some(({ effect }) => effect === "immediate")).toBe(true);
    const second = { ...profile, id: entityId<"network">("second") };
    const document = { ...settings, user: { ...settings.user, networks: [profile, second] } };
    const reordered = success(
      { section: "user", patch: { networks: [second, profile] } },
      document,
    );
    expect(reordered.changed).toBe(true);
    expect(reordered.effects).toEqual([
      {
        path: "user.networks",
        effect: "immediate",
        description: "Update the saved profile order.",
      },
    ]);
  });
  it("requires destructive consent for shorter retention including indefinite to finite", () => {
    const indefinite = {
      ...settings,
      user: { ...settings.user, history: { ...settings.user.history, retentionDays: null } },
    };
    for (const [document, days] of [
      [settings, 1],
      [indefinite, 30],
    ] as const) {
      const result = success(
        { section: "user", patch: { history: { retentionDays: days } } },
        document,
      );
      expect(result.requiredPermissions).toEqual(["configure", "destructive"]);
      expect(result.effects[0]).toMatchObject({
        path: "user.history.retentionDays",
        effect: "destructive",
      });
    }
    for (const days of [30, 60, null])
      expect(
        success({ section: "user", patch: { history: { retentionDays: days } } })
          .requiredPermissions,
      ).toEqual(["configure"]);
    const combined = success({
      section: "user",
      patch: { networks: [], history: { retentionDays: 1 } },
    });
    expect(combined.requiredPermissions).toEqual(["configure", "network", "destructive"]);
  });
  it("explains history exclusions/disable behavior without claiming implicit deletion", () => {
    const result = success({
      section: "user",
      patch: {
        history: {
          enabled: false,
          persistDrafts: true,
          excludedConversations: [{ networkId: profile.id, kind: "channel", name: "#private" }],
        },
        notifications: { bell: true, desktop: true, previews: true },
        sendTyping: true,
      },
    });
    expect(result.effects).toHaveLength(7);
    expect(result.effects.every(({ effect }) => effect === "immediate")).toBe(true);
    expect(
      result.effects.find(({ path }) => path === "user.history.enabled")?.description,
    ).toContain("existing history is retained");
    expect(result.requiredPermissions).toEqual(["configure"]);
  });
  it("rejects changed nonempty reserved keybindings; preserves legacy maps on unrelated edits", () => {
    const unsupported = plan({ section: "tui", patch: { keybindings: { send: ["Ctrl+Enter"] } } });
    expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const document: SettingsDocument = {
      ...settings,
      tui: { ...settings.tui, keybindings: { send: ["Ctrl+Enter"] } },
    };
    expect(
      success({ section: "tui", patch: { theme: "light" } }, document).change.value,
    ).toMatchObject({ keybindings: document.tui.keybindings });
    expect(
      success({ section: "tui", value: { ...document.tui, theme: "light" } }, document).changed,
    ).toBe(true);
    expect(
      plan({ section: "tui", patch: { keybindings: { send: ["Enter"] } } }, document),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(
      success({ section: "tui", patch: {}, unset: ["keybindings.send"] }, document).change.value,
    ).toMatchObject({ keybindings: {} });
    const invalid: JsonObject = { first: ["Ctrl+X"], second: ["ctrl+x"] };
    reject({ section: "tui", patch: { keybindings: invalid } });
  });
});
