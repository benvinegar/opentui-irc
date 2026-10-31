import { describe, expect, it, vi } from "vitest";
import type {
  ControlMethod,
  ControlPermission,
  ControlRequest,
  JsonObject,
} from "../../src/contracts/control";
import { ALL_CONTROL_PERMISSIONS, DEFAULT_CONTROL_PERMISSIONS } from "../../src/contracts/control";
import { entityId } from "../../src/contracts/common";
import type { SettingsDocument } from "../../src/contracts/settings";
import { createControlService } from "../../src/control/service";
import { createFakeApp } from "../fakes/app";
import { conversationId, messageId, networkId, settings } from "../fixtures/scenario";
import { harness } from "../app/harness";

let sequence = 0;
const signal = () => new AbortController().signal;
const request = (
  method: ControlMethod,
  params: JsonObject = {},
  permissions: readonly ControlPermission[] = DEFAULT_CONTROL_PERMISSIONS,
): ControlRequest => ({
  version: 1,
  id: `service-edge-${++sequence}`,
  method,
  params,
  permissions,
});
function fakeService(permissions: readonly ControlPermission[] = DEFAULT_CONTROL_PERMISSIONS) {
  const fake = createFakeApp();
  const h = harness();
  const service = createControlService({
    app: fake.app,
    settings: h.deps.settings,
    secrets: h.deps.secrets,
    permissions,
  });
  return { fake, h, service };
}
function offlineService(permissions: readonly ControlPermission[] = ALL_CONTROL_PERMISSIONS) {
  const h = harness();
  return {
    h,
    service: createControlService({
      settings: h.deps.settings,
      secrets: h.deps.secrets,
      permissions,
    }),
  };
}
const themeEdit = (theme: string) => ({
  edit: { section: "tui", patch: { theme } },
  expectedRevision: settings.revision,
});

describe("control service permission boundary", () => {
  const guarded: readonly [ControlMethod, JsonObject][] = [
    ["status", {}],
    ["config.get", {}],
    ["config.plan", themeEdit("light")],
    ["config.apply", themeEdit("light")],
    ["config.reload", { dryRun: true }],
    ["networks.list", {}],
    ["conversations.list", {}],
    ["operations.list", {}],
    ["discovery.get", { networkId }],
    ["secrets.store", { value: "input-password" }],
    ["timeline.get", { conversationId }],
    ["history.search", { text: "private" }],
    ["app.shutdown", { confirm: true }],
    ["action.dispatch", { action: { type: "conversation.activate", conversationId } }],
  ];
  it("denies every guarded method when the caller declares no intent", async () => {
    const { fake, h, service } = fakeService(ALL_CONTROL_PERMISSIONS);
    const dispatch = vi.spyOn(fake.app, "dispatch");
    const save = vi.spyOn(fake.app, "saveSettings");
    const store = vi.spyOn(fake.app, "storeSecret");
    const load = vi.spyOn(h.deps.settings, "load");
    for (const [method, params] of guarded)
      expect(await service(request(method, params, []), signal()), method).toMatchObject({
        ok: false,
        error: { code: "permission-denied" },
      });
    expect(dispatch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("denies every guarded method when the server grants nothing, even with full intent", async () => {
    const { fake, service } = fakeService([]);
    const dispatch = vi.spyOn(fake.app, "dispatch");
    for (const [method, params] of guarded)
      expect(
        await service(request(method, params, ALL_CONTROL_PERMISSIONS), signal()),
        method,
      ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps capabilities and schema public but reports the server's actual grant", async () => {
    const { service } = fakeService(["inspect"]);
    expect(await service(request("capabilities", {}, []), signal())).toMatchObject({
      ok: true,
      result: { mode: "live", permissions: ["inspect"] },
    });
    expect(await service(request("config.schema", {}, []), signal())).toMatchObject({ ok: true });
    expect(await service(request("config.schema", { extra: true }, []), signal())).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  });
  it("requires network rights for IRC requests and send rights only for topic writes", async () => {
    const { fake, service } = fakeService(ALL_CONTROL_PERMISSIONS);
    const read = {
      type: "irc.request",
      networkId,
      command: { type: "topic", channel: "#welcome" },
    };
    const write = {
      ...read,
      command: { type: "topic", channel: "#welcome", text: "new topic" },
    };
    expect(
      await service(request("action.dispatch", { action: read }, ["inspect"]), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(request("action.dispatch", { action: write }, ["network"]), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(request("action.dispatch", { action: read }, ["network"]), signal()),
    ).toMatchObject({ ok: true });
    expect(
      await service(
        request("action.dispatch", { action: write }, ["network", "send-messages"]),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    expect(fake.actions).toHaveLength(2);
  });
});

describe("control service offline mode", () => {
  it("advertises offline mode and refuses live-only methods without touching history", async () => {
    const { service } = offlineService();
    expect(await service(request("capabilities", {}, []), signal())).toMatchObject({
      ok: true,
      result: { mode: "offline" },
    });
    expect(await service(request("status"), signal())).toMatchObject({
      ok: true,
      result: { running: false, boot: "offline", revision: 0, networks: [] },
    });
    for (const [method, params] of [
      ["conversations.list", {}],
      ["operations.list", {}],
      ["discovery.get", { networkId }],
      ["timeline.get", { conversationId }],
      ["history.search", { text: "x" }],
      ["app.shutdown", { confirm: true }],
      ["action.dispatch", { action: { type: "network.connect", networkId } }],
    ] as const)
      expect(
        await service(request(method, params, ALL_CONTROL_PERMISSIONS), signal()),
        method,
      ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("reports reload as offline without applying anything", async () => {
    const { service } = offlineService();
    expect(await service(request("config.reload", {}), signal())).toMatchObject({
      ok: true,
      result: { applied: false, revision: settings.revision, mode: "offline" },
    });
  });
  it("saves offline config changes directly through the repository", async () => {
    const { service, h } = offlineService();
    const response = await service(request("config.apply", themeEdit("light")), signal());
    expect(response).toMatchObject({ ok: true, result: { applied: true } });
    expect(response.ok && JSON.stringify(response.result)).not.toContain("operationId");
    const stored = await h.deps.settings.load(signal());
    expect(stored.ok && stored.value.tui.theme).toBe("light");
  });
  it("stores secrets through the offline provider and rejects empty or oversized input", async () => {
    const { service, h } = offlineService();
    const store = vi.spyOn(h.deps.secrets, "store");
    for (const value of ["", "é".repeat(40000)])
      expect(await service(request("secrets.store", { value }), signal())).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    expect(store).not.toHaveBeenCalled();
    const response = await service(request("secrets.store", { value: "input-password" }), signal());
    expect(response).toMatchObject({ ok: true });
    expect(JSON.stringify(response)).not.toContain("input-password");
    expect(store).toHaveBeenCalledOnce();
  });
});

describe("control service live configuration edges", () => {
  it("reports a no-op apply without saving", async () => {
    const { fake, service } = fakeService();
    const save = vi.spyOn(fake.app, "saveSettings");
    expect(await service(request("config.apply", themeEdit("dark")), signal())).toMatchObject({
      ok: true,
      result: { applied: false, revision: settings.revision, plan: { changed: false } },
    });
    expect(save).not.toHaveBeenCalled();
  });
  it("returns the app's settings operation for a live save", async () => {
    const { service } = fakeService();
    const response = await service(request("config.apply", themeEdit("light")), signal());
    expect(response).toMatchObject({ ok: true, result: { applied: true } });
    expect(response.ok && JSON.stringify(response.result)).toContain("fake-settings-");
  });
  it("fails safely when live settings are not ready before or after saving", async () => {
    const notReady = fakeService();
    notReady.fake.settings.publish(null);
    const save = vi.spyOn(notReady.fake.app, "saveSettings");
    expect(
      await notReady.service(request("config.apply", themeEdit("light")), signal()),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(save).not.toHaveBeenCalled();

    const vanished = fakeService();
    vi.spyOn(vanished.fake.app, "saveSettings").mockImplementation(async () => {
      vanished.fake.settings.publish(null);
      return { ok: true, value: entityId<"operation">("saved") };
    });
    expect(
      await vanished.service(request("config.apply", themeEdit("light")), signal()),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("applies a non-dry-run reload and validates the dryRun flag", async () => {
    const { fake, service } = fakeService();
    const reload = vi.spyOn(fake.app, "reloadSettings");
    expect(await service(request("config.reload", { dryRun: "yes" }), signal())).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
    expect(
      await service(
        request("config.reload", { dryRun: false, expectedRevision: settings.revision }),
        signal(),
      ),
    ).toMatchObject({ ok: true, result: { applied: true, revision: settings.revision } });
    expect(reload).toHaveBeenCalledOnce();
  });
  it("does not reload when cancelled while reading the live base", async () => {
    const { fake, service } = fakeService();
    const reload = vi.spyOn(fake.app, "reloadSettings");
    const controller = new AbortController();
    const snapshot = fake.settings.getSnapshot;
    vi.spyOn(fake.settings, "getSnapshot").mockImplementation(() => {
      controller.abort();
      return snapshot();
    });
    expect(
      await service(
        request("config.reload", { expectedRevision: settings.revision }),
        controller.signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(reload).not.toHaveBeenCalled();
  });
  it("fails safely when the repository returns a malformed document", async () => {
    const { fake, h, service } = fakeService();
    const malformed = { ...settings, user: [] } as unknown as SettingsDocument;
    vi.spyOn(h.deps.settings, "load").mockResolvedValue({ ok: true, value: malformed });
    const reload = vi.spyOn(fake.app, "reloadSettings");
    expect(await service(request("config.reload", { dryRun: true }), signal())).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("control service live read edges", () => {
  it("forwards every validated search filter to the app", async () => {
    const { fake, service } = fakeService(ALL_CONTROL_PERMISSIONS);
    const search = vi.spyOn(fake.app, "search");
    const params = {
      text: "Welcome",
      limit: 5,
      networkId,
      conversationId,
      sender: "guide",
      after: 1,
      before: 2_000_000_000_000,
      cursor: "cursor-1",
    };
    expect(
      await service(request("history.search", params, ALL_CONTROL_PERMISSIONS), signal()),
    ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledWith(params, expect.anything());
    for (const invalid of [{ limit: 0 }, { limit: 101 }, { after: -1 }, { sender: 7 }])
      expect(
        await service(
          request("history.search", { text: "x", ...invalid }, ALL_CONTROL_PERMISSIONS),
          signal(),
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(search).toHaveBeenCalledOnce();
  });
  it("omits error codes from healthy metadata and reports network/app error codes only", async () => {
    const { fake, service } = fakeService();
    fake.operations.publish([{ id: entityId<"operation">("op"), state: "completed" }]);
    const operations = await service(request("operations.list"), signal());
    expect(operations).toMatchObject({ ok: true, result: [{ id: "op", state: "completed" }] });
    expect(JSON.stringify(operations)).not.toContain("errorCode");
    const discovery = await service(request("discovery.get", { networkId }), signal());
    expect(discovery).toMatchObject({
      ok: true,
      result: { networkId, directory: { state: "idle" }, user: { state: "idle" } },
    });
    expect(JSON.stringify(discovery)).not.toContain("errorCode");
    const error = { code: "network" as const, message: "private remote text", retryable: true };
    fake.state.publish({
      ...fake.state.getSnapshot(),
      error,
      networks: fake.state
        .getSnapshot()
        .networks.map((network) => ({ ...network, lastError: error })),
    });
    const status = await service(request("status"), signal());
    expect(status).toMatchObject({
      ok: true,
      result: { running: true, errorCode: "network", networks: [{ errorCode: "network" }] },
    });
    expect(JSON.stringify(status)).not.toContain("private remote text");
  });
  it("returns timelines with read rights and hides app error text from dispatch failures", async () => {
    const { fake, service } = fakeService(ALL_CONTROL_PERMISSIONS);
    expect(
      await service(request("timeline.get", { conversationId }, ["read-messages"]), signal()),
    ).toMatchObject({ ok: true, result: { conversationId } });
    vi.spyOn(fake.app, "dispatch").mockResolvedValue({
      ok: false,
      error: { code: "network", message: "private body", retryable: false },
    });
    const response = await service(
      request(
        "action.dispatch",
        { action: { type: "message.send", conversationId, text: "hello", kind: "text" } },
        ["send-messages"],
      ),
      signal(),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "network", retryable: false },
    });
    expect(JSON.stringify(response)).not.toContain("private body");
  });
  it("converts unexpected adapter exceptions into a static internal error", async () => {
    const { fake, service } = fakeService(ALL_CONTROL_PERMISSIONS);
    vi.spyOn(fake.app, "dispatch").mockRejectedValue(new Error("stack with private text"));
    const response = await service(
      request("action.dispatch", { action: { type: "history.reveal", messageId } }, [
        "read-messages",
      ]),
      signal(),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(response)).not.toContain("private text");
  });
  it("accepts a confirmed shutdown only from a live app with destructive authority", async () => {
    const { service } = fakeService(ALL_CONTROL_PERMISSIONS);
    expect(
      await service(request("app.shutdown", { confirm: false }, ["destructive"]), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(request("app.shutdown", { confirm: true }, ["destructive"]), signal()),
    ).toMatchObject({ ok: true, result: { accepted: true } });
  });
  it("cancels an admitted request that is aborted before it starts executing", async () => {
    const { fake, service } = fakeService();
    const dispatch = vi.spyOn(fake.app, "dispatch");
    const controller = new AbortController();
    const pending = service(
      request("action.dispatch", { action: { type: "network.connect", networkId } }, ["network"]),
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
