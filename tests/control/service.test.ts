import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app";
import type { AppApi } from "../../src/contracts/app";
import type { Result } from "../../src/contracts/common";
import type { SettingsDocument } from "../../src/contracts/settings";
import type {
  ControlMethod,
  ControlPermission,
  ControlRequest,
  JsonObject,
} from "../../src/contracts/control";
import { ALL_CONTROL_PERMISSIONS, DEFAULT_CONTROL_PERMISSIONS } from "../../src/contracts/control";
import { entityId } from "../../src/contracts/common";
import { createControlService } from "../../src/control/service";
import { createFakeApp } from "../fakes/app";
import { appSnapshot, conversationId, networkId, messageId, settings } from "../fixtures/scenario";
import { harness } from "../app/harness";

let sequence = 0;
const signal = () => new AbortController().signal;
const request = (
  method: ControlMethod,
  params: JsonObject = {},
  permissions: readonly ControlPermission[] = DEFAULT_CONTROL_PERMISSIONS,
): ControlRequest => ({
  version: 1,
  id: `control-test-${++sequence}`,
  method,
  params,
  permissions,
});
const apps: AppApi[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
});
async function setup(permissions: readonly ControlPermission[] = DEFAULT_CONTROL_PERMISSIONS) {
  const h = harness();
  const created = await createApp(h.deps, signal());
  if (!created.ok) throw new Error(created.error.message);
  apps.push(created.value);
  return {
    h,
    app: created.value,
    service: createControlService({
      app: created.value,
      settings: h.deps.settings,
      secrets: h.deps.secrets,
      permissions,
    }),
  };
}

describe("agent control business boundary", () => {
  it("exposes schema/defaults without starting a renderer or connecting", async () => {
    const { service, h } = await setup();
    const response = await service(request("capabilities", {}, []), signal());
    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).toContain("config.apply");
    expect(h.sessions).toHaveLength(0);
    const schema = await service(request("config.schema", {}, []), signal());
    expect(schema.ok).toBe(true);
    expect(JSON.stringify(schema)).toContain("retentionDays");
  });
  it("never grants message access or sends through ordinary configuration permissions", async () => {
    const { service } = await setup();
    for (const method of ["timeline.get", "history.search"] as const) {
      const response = await service(
        request(
          method,
          method === "timeline.get" ? { conversationId: "any" } : { text: "private" },
          ALL_CONTROL_PERMISSIONS,
        ),
        signal(),
      );
      expect(response).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    }
    const send = await service(
      request(
        "action.dispatch",
        {
          action: {
            type: "message.send",
            conversationId: "any",
            kind: "text",
            text: "do not send",
          },
        },
        ALL_CONTROL_PERMISSIONS,
      ),
      signal(),
    );
    expect(send).toMatchObject({ ok: false, error: { code: "permission-denied" } });
  });
  it("requires caller intent even when the server grants every permission", async () => {
    const { service } = await setup(ALL_CONTROL_PERMISSIONS);
    expect(await service(request("history.search", { text: "private" }), signal())).toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    expect(
      await service(
        request("history.search", { text: "private" }, ALL_CONTROL_PERMISSIONS),
        signal(),
      ),
    ).toMatchObject({ ok: true });
  });
  it("plans and CAS-applies partial settings, and rejects stale revisions", async () => {
    const { service, app } = await setup();
    const revision = app.settings.getSnapshot()!.revision;
    const params = {
      edit: { section: "tui", patch: { theme: "light" } },
      expectedRevision: revision,
    };
    const plan = await service(request("config.plan", params), signal());
    expect(plan.ok).toBe(true);
    expect(app.settings.getSnapshot()?.tui.theme).toBe("dark");
    const saved = await service(request("config.apply", params), signal());
    expect(saved.ok).toBe(true);
    expect(app.settings.getSnapshot()?.tui.theme).toBe("light");
    expect(await service(request("config.apply", params), signal())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
  it("does not ignore external disk conflicts even for a live no-op", async () => {
    const { service, app, h } = await setup();
    const original = app.settings.getSnapshot()!;
    const external = await h.deps.settings.save(
      { section: "tui", value: { ...original.tui, theme: "light" } },
      original.revision,
      signal(),
    );
    expect(external.ok).toBe(true);
    const result = await service(
      request("config.apply", {
        edit: { section: "tui", patch: { theme: "dark" } },
        expectedRevision: original.revision,
      }),
      signal(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(app.settings.getSnapshot()?.tui.theme).toBe("dark");
  });
  it("requires destructive grant, intent, and confirmation before shorter retention", async () => {
    const { service, app, h } = await setup(ALL_CONTROL_PERMISSIONS);
    const prune = vi.spyOn(h.deps.history, "prune");
    prune.mockClear();
    const params = {
      edit: { section: "user", patch: { history: { retentionDays: 7 } } },
      expectedRevision: app.settings.getSnapshot()!.revision,
    };
    expect((await service(request("config.plan", params), signal())).ok).toBe(true);
    expect(
      await service(request("config.apply", { ...params, confirm: true }), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(request("config.apply", params, ALL_CONTROL_PERMISSIONS), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(prune).not.toHaveBeenCalled();
    expect(
      (
        await service(
          request("config.apply", { ...params, confirm: true }, ALL_CONTROL_PERMISSIONS),
          signal(),
        )
      ).ok,
    ).toBe(true);
    expect(app.settings.getSnapshot()?.user.history.retentionDays).toBe(7);
    expect(prune).toHaveBeenCalledOnce();
  });
  it("inspects external settings before a revision-checked live reload", async () => {
    const { service, app, h } = await setup();
    const original = app.settings.getSnapshot()!;
    const external = await h.deps.settings.save(
      { section: "tui", value: { ...original.tui, theme: "light" } },
      original.revision,
      signal(),
    );
    if (!external.ok) throw new Error("expected external save");
    const plan = await service(request("config.reload", { dryRun: true }), signal());
    expect(plan.ok).toBe(true);
    expect(app.settings.getSnapshot()?.tui.theme).toBe("dark");
    const applied = await service(
      request("config.reload", { expectedRevision: external.value.revision }),
      signal(),
    );
    expect(applied.ok).toBe(true);
    expect(app.settings.getSnapshot()?.tui.theme).toBe("light");
  });
  it("passes runtime-validated actions to the same AppApi and rejects raw/unknown fields", async () => {
    const { service, app } = await setup();
    const dispatch = vi.spyOn(app, "dispatch");
    const networkId = settings.user.networks[0]!.id;
    const good = await service(
      request("action.dispatch", {
        action: { type: "conversation.query", networkId, nick: "peer" },
      }),
      signal(),
    );
    expect(good.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      { type: "conversation.query", networkId, nick: "peer" },
      expect.any(AbortSignal),
    );
    const invalid = await service(
      request("action.dispatch", {
        action: {
          type: "irc.request",
          networkId,
          command: { type: "raw", line: "PRIVMSG #x :do not execute" },
        },
      }),
      signal(),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("does not reveal message-like error bodies or channel topics in metadata", async () => {
    const fake = createFakeApp();
    const privateText = "private-message-never-metadata";
    fake.state.publish({
      ...appSnapshot,
      error: { code: "network", message: privateText, retryable: false },
      networks: appSnapshot.networks.map((network) => ({
        ...network,
        lastError: { code: "network", message: privateText, retryable: false },
      })),
      conversations: appSnapshot.conversations.map((c) => ({ ...c, topic: privateText })),
    });
    const h = harness();
    const service = createControlService({
      app: fake.app,
      settings: h.deps.settings,
      secrets: h.deps.secrets,
    });
    expect(JSON.stringify(await service(request("status"), signal()))).not.toContain(privateText);
    expect(JSON.stringify(await service(request("conversations.list"), signal()))).not.toContain(
      privateText,
    );
  });
  it("secret ingress returns only a reference, with bounded same-ID replay", async () => {
    const h = harness();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const store = vi.spyOn(h.deps.secrets, "store").mockImplementation(async () => {
      await pending;
      return { ok: true, value: entityId<"secret-ref">("env:REF") };
    });
    const service = createControlService({ settings: h.deps.settings, secrets: h.deps.secrets });
    const req = request("secrets.store", { value: "do-not-log-this-password" });
    const a = service(req, signal());
    const b = service(req, signal());
    const conflict = await service(
      { ...req, params: { value: "different-private-password" } },
      signal(),
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
    resolve();
    const first = await a;
    expect(await b).toEqual(first);
    expect(store).toHaveBeenCalledOnce();
    expect(JSON.stringify(first)).not.toContain("do-not-log");
    expect(first).toMatchObject({ ok: true, result: { reference: "env:REF" } });
  });
  it("denies shutdown/deletion without explicit authority and confirmation", async () => {
    const { service } = await setup(ALL_CONTROL_PERMISSIONS);
    expect(await service(request("app.shutdown", { confirm: true }), signal())).toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    expect(
      await service(request("app.shutdown", { confirm: false }, ALL_CONTROL_PERMISSIONS), signal()),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(request("app.shutdown", { confirm: true }, ALL_CONTROL_PERMISSIONS), signal()),
    ).toMatchObject({ ok: true, result: { accepted: true } });
  });
  it("cancellation before admission never writes settings or stores a secret", async () => {
    const { service, h } = await setup();
    const store = vi.spyOn(h.deps.secrets, "store");
    const controller = new AbortController();
    controller.abort();
    expect(
      await service(request("secrets.store", { value: "private" }), controller.signal),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(store).not.toHaveBeenCalled();
  });
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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

describe("control policy review regressions", () => {
  it("requires both grant and intent for every body-reading/sending/destructive route", async () => {
    const actions = [
      { type: "draft.set", conversationId, text: "private draft" },
      { type: "message.send", conversationId, text: "private message", kind: "text" },
      { type: "message.react", messageId, value: "👍", remove: false },
      { type: "message.redact", messageId },
      { type: "typing.set", conversationId, active: true },
      { type: "history.load-older", conversationId },
      { type: "history.latest", conversationId },
      { type: "history.reveal", messageId },
      { type: "view.report", conversationId, focused: true, atBottom: true },
      { type: "history.delete", conversationId },
      { type: "irc.request", networkId, command: { type: "topic", channel: "#channel", text: "" } },
    ];
    for (const [grant, intent] of [
      [DEFAULT_CONTROL_PERMISSIONS, ALL_CONTROL_PERMISSIONS],
      [ALL_CONTROL_PERMISSIONS, DEFAULT_CONTROL_PERMISSIONS],
    ] as const) {
      const { fake, service } = fakeService(grant);
      const dispatch = vi.spyOn(fake.app, "dispatch");
      for (const action of actions)
        expect(
          await service(request("action.dispatch", { action, confirm: true }, intent), signal()),
          action.type,
        ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
      for (const [method, params] of [
        ["timeline.get", { conversationId }],
        ["history.search", { text: "private" }],
        ["app.shutdown", { confirm: true }],
      ] as const)
        expect(await service(request(method, params, intent), signal())).toMatchObject({
          ok: false,
          error: { code: "permission-denied" },
        });
      expect(dispatch).not.toHaveBeenCalled();
    }
    const { service, fake } = fakeService(ALL_CONTROL_PERMISSIONS);
    for (const action of actions.filter(
      ({ type }) => type === "message.redact" || type === "history.delete",
    )) {
      expect(
        await service(request("action.dispatch", { action }, ALL_CONTROL_PERMISSIONS), signal()),
      ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
      expect(
        await service(
          request("action.dispatch", { action, confirm: false }, ALL_CONTROL_PERMISSIONS),
          signal(),
        ),
      ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    }
    expect(fake.actions).toHaveLength(0);
  });
  it("strips discovery and operation error bodies while retaining intended discovery metadata", async () => {
    const { fake, service } = fakeService();
    const privateText = "private-body-or-resolved-credential";
    const error = { code: "network" as const, message: privateText, retryable: false };
    fake.operations.publish([{ id: entityId<"operation">("operation"), state: "failed", error }]);
    fake.discoveries.get(networkId)!.publish({
      networkId,
      directory: {
        state: "failed",
        items: [{ channel: "#public", userCount: 3, topic: "directory topic" }],
        truncated: false,
        error,
      },
      user: {
        state: "failed",
        details: { nick: "peer", channels: ["#public"], realname: "WHOIS name" },
        error,
      },
    });
    const directory = await service(request("discovery.get", { networkId }), signal());
    expect(directory).toMatchObject({
      ok: true,
      result: { directory: { errorCode: "network" }, user: { errorCode: "network" } },
    });
    expect(JSON.stringify(directory)).toContain("directory topic");
    expect(JSON.stringify(directory)).toContain("WHOIS name");
    for (const response of [directory, await service(request("operations.list"), signal())])
      expect(JSON.stringify(response)).not.toContain(privateText);
    vi.spyOn(fake.app, "discovery").mockReturnValue({ ok: false, error });
    expect(
      JSON.stringify(await service(request("discovery.get", { networkId }), signal())),
    ).not.toContain(privateText);
    vi.spyOn(fake.app, "dispatch").mockResolvedValue({ ok: false, error });
    expect(
      JSON.stringify(
        await service(
          request("action.dispatch", { action: { type: "network.connect", networkId } }),
          signal(),
        ),
      ),
    ).not.toContain(privateText);
  });
  it("rejects non-reference secret storage results rather than returning potential credentials", async () => {
    const h = harness();
    vi.spyOn(h.deps.secrets, "store").mockResolvedValue({
      ok: true,
      value: entityId<"secret-ref">("private-resolved-credential"),
    });
    const service = createControlService({ settings: h.deps.settings, secrets: h.deps.secrets });
    const response = await service(request("secrets.store", { value: "input-password" }), signal());
    expect(response).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(response)).not.toContain("private-resolved-credential");
    expect(JSON.stringify(response)).not.toContain("input-password");
  });
  it("inspect metadata never returns timeline bodies/drafts; capabilities describe the same-UID credential constraint", async () => {
    const { fake, service } = fakeService();
    const privateText = "private-body-never-in-inspect";
    const timeline = fake.timelines.get(conversationId)!;
    timeline.publish({
      ...timeline.getSnapshot(),
      draft: privateText,
      messages: timeline
        .getSnapshot()
        .messages.map((message) => ({ ...message, text: privateText })),
    });
    for (const method of [
      "status",
      "config.get",
      "networks.list",
      "conversations.list",
      "operations.list",
    ] as const)
      expect(JSON.stringify(await service(request(method), signal()))).not.toContain(privateText);
    const response = await service(request("capabilities", {}, []), signal());
    expect(JSON.stringify(response)).toContain("not a secret-vault sandbox");
    expect(JSON.stringify(response)).toContain("resolved credentials are never returned");
  });
  it("rejects malformed actions before dispatch and never resolves a supplied channel key", async () => {
    const { service, fake, h } = fakeService();
    const dispatch = vi.spyOn(fake.app, "dispatch");
    const resolve = vi.spyOn(h.deps.secrets, "resolve");
    for (const action of [
      { type: "conversation.query", networkId, nick: "x".repeat(101) },
      { type: "conversation.join", networkId, channel: `#${"x".repeat(200)}` },
      { type: "conversation.join", networkId, channel: "#channel", key: "plaintext-password" },
      { type: "irc.request", networkId, command: { type: "whois", nick: "bad nick" } },
      {
        type: "irc.request",
        networkId,
        command: { type: "topic", channel: "#channel", text: "bad\ntopic" },
      },
    ])
      expect(
        await service(request("action.dispatch", { action }, ALL_CONTROL_PERMISSIONS), signal()),
      ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rechecks cancellation and live revision after asynchronous pre-save disk inspection", async () => {
    for (const cancel of [false, true]) {
      const { service, fake, h } = fakeService();
      const loadGate = gate<Result<SettingsDocument>>();
      const entered = gate<void>();
      vi.spyOn(h.deps.settings, "load").mockImplementation(async () => {
        entered.resolve();
        return loadGate.promise;
      });
      const save = vi.spyOn(fake.app, "saveSettings");
      const controller = new AbortController();
      const pending = service(
        request("config.apply", {
          edit: { section: "tui", patch: { theme: "light" } },
          expectedRevision: settings.revision,
        }),
        controller.signal,
      );
      await entered.promise;
      if (cancel) controller.abort();
      else
        fake.settings.publish({
          ...settings,
          revision: entityId<"config-revision">("new-live-revision"),
        });
      loadGate.resolve({ ok: true, value: settings });
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: cancel ? "cancelled" : "conflict" },
      });
      expect(save).not.toHaveBeenCalled();
    }
  });
  it("checks reload effects against both explicit network/destructive rights and confirmation", async () => {
    const { service, app, h } = await setup(ALL_CONTROL_PERMISSIONS);
    const original = app.settings.getSnapshot()!;
    const changed = await h.deps.settings.save(
      {
        section: "user",
        value: {
          ...original.user,
          networks: [],
          history: { ...original.user.history, retentionDays: 1 },
        },
      },
      original.revision,
      signal(),
    );
    if (!changed.ok) throw new Error("Expected external edit");
    const reload = vi.spyOn(app, "reloadSettings");
    for (const permissions of [
      ["inspect", "configure", "network"],
      ["inspect", "configure", "destructive"],
    ] satisfies ControlPermission[][])
      expect(
        await service(
          request(
            "config.reload",
            { expectedRevision: changed.value.revision, confirm: true },
            permissions,
          ),
          signal(),
        ),
      ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(
      await service(
        request(
          "config.reload",
          { expectedRevision: changed.value.revision },
          ALL_CONTROL_PERMISSIONS,
        ),
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(reload).not.toHaveBeenCalled();
    expect(
      await service(
        request(
          "config.reload",
          { expectedRevision: "stale", confirm: true },
          ALL_CONTROL_PERMISSIONS,
        ),
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await service(
        request(
          "config.reload",
          { expectedRevision: changed.value.revision, confirm: true },
          ALL_CONTROL_PERMISSIONS,
        ),
        signal(),
      ),
    ).toMatchObject({ ok: true });
    expect(reload).toHaveBeenCalledOnce();
  });
  it("does not apply a reload after cancellation during disk loading", async () => {
    const { service, fake, h } = fakeService();
    const entered = gate<void>();
    const loaded = gate<Result<SettingsDocument>>();
    vi.spyOn(h.deps.settings, "load").mockImplementation(async () => {
      entered.resolve();
      return loaded.promise;
    });
    const reload = vi.spyOn(fake.app, "reloadSettings");
    const controller = new AbortController();
    const pending = service(
      request("config.reload", { expectedRevision: settings.revision }),
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    loaded.resolve({ ok: true, value: settings });
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("control request identity and admission regressions", () => {
  it("rejects cross-method/permission/payload ID reuse for reads and writes", async () => {
    const { service, fake } = fakeService(ALL_CONTROL_PERMISSIONS);
    const first = request("history.search", { text: "private" }, ALL_CONTROL_PERMISSIONS);
    const search = vi.spyOn(fake.app, "search");
    expect(await service(first, signal())).toMatchObject({ ok: true });
    for (const changed of [
      { ...first, permissions: DEFAULT_CONTROL_PERMISSIONS },
      { ...first, params: { text: "different" } },
      { ...first, method: "status" as const, params: {} },
      {
        ...first,
        method: "action.dispatch" as const,
        params: { action: { type: "network.connect", networkId } },
      },
    ])
      expect(await service(changed, signal())).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    expect(search).toHaveBeenCalledOnce();
    expect(fake.actions).toHaveLength(0);
    const write = request("action.dispatch", { action: { type: "network.connect", networkId } });
    expect(await service(write, signal())).toMatchObject({ ok: true });
    expect(await service({ ...write, method: "status", params: {} }, signal())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
  it("canonicalizes key/permission order and detaches replay responses from callers", async () => {
    const { service } = fakeService(ALL_CONTROL_PERMISSIONS);
    const original = request(
      "action.dispatch",
      { action: { type: "network.connect", networkId } },
      ALL_CONTROL_PERMISSIONS,
    );
    const a = await service(original, signal());
    const snapshot = structuredClone(a);
    if (!a.ok || typeof a.result !== "object" || a.result === null)
      throw new Error("Expected receipt");
    Object.assign(a.result, { private: "caller mutation" });
    const b = await service(
      {
        ...original,
        params: { action: { networkId, type: "network.connect" } },
        permissions: [...ALL_CONTROL_PERMISSIONS].reverse(),
      },
      signal(),
    );
    expect(b).toEqual(snapshot);
    expect(b).not.toBe(a);
  });
  it("clones request data before awaits so admitted effects cannot change after fingerprinting", async () => {
    const h = harness();
    const service = createControlService({ settings: h.deps.settings, secrets: h.deps.secrets });
    const entered = gate<void>();
    const loaded = gate<Result<SettingsDocument>>();
    const load = vi.spyOn(h.deps.settings, "load");
    load.mockImplementationOnce(async () => {
      entered.resolve();
      return loaded.promise;
    });
    const params = {
      edit: { section: "tui", patch: { theme: "light" } },
      expectedRevision: settings.revision,
    };
    const req = request("config.apply", params);
    const pending = service(req, signal());
    await entered.promise;
    params.edit.patch.theme = "high-contrast";
    loaded.resolve({ ok: true, value: settings });
    expect(await pending).toMatchObject({ ok: true });
    const saved = await load(signal());
    expect(saved).toMatchObject({ ok: true, value: { tui: { theme: "light" } } });
  });
  it("installs replay entries before entering potentially reentrant app/adapter ports", async () => {
    const h = harness();
    const req = request("secrets.store", { value: "private credential" });
    let duplicate: Promise<unknown> | undefined;
    const service = createControlService({ settings: h.deps.settings, secrets: h.deps.secrets });
    const store = vi.spyOn(h.deps.secrets, "store").mockImplementation(async () => {
      if (!duplicate) duplicate = service(req, signal());
      return { ok: true, value: entityId<"secret-ref">("env:REF") };
    });
    expect(await service(req, signal())).toMatchObject({ ok: true });
    expect(await duplicate).toMatchObject({ ok: true });
    expect(store).toHaveBeenCalledOnce();
  });
  it("expires completed entries and evicts bounded old entries without retrying live work", async () => {
    const h = harness();
    let now = 0;
    const store = vi
      .spyOn(h.deps.secrets, "store")
      .mockResolvedValue({ ok: true, value: entityId<"secret-ref">("env:REF") });
    const service = createControlService({
      settings: h.deps.settings,
      secrets: h.deps.secrets,
      now: () => now,
    });
    const req = request("secrets.store", { value: "private" });
    await service(req, signal());
    await service(req, signal());
    expect(store).toHaveBeenCalledOnce();
    now = 120001;
    await service(req, signal());
    expect(store).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 256; i++) await service(request("status"), signal());
    await service(req, signal());
    expect(store).toHaveBeenCalledTimes(3);
    const pendingGate = gate<void>();
    const entered = gate<void>();
    store.mockImplementation(async () => {
      entered.resolve();
      await pendingGate.promise;
      return { ok: true, value: entityId<"secret-ref">("env:REF") };
    });
    const live = request("secrets.store", { value: "another-private" });
    const first = service(live, signal());
    await entered.promise;
    now += 240000;
    const duplicate = service(live, signal());
    pendingGate.resolve();
    expect(await duplicate).toEqual(await first);
    expect(store).toHaveBeenCalledTimes(4);
  });
  it("bounds cached response bytes as well as entry count", async () => {
    const { service, fake } = fakeService(ALL_CONTROL_PERMISSIONS);
    const message = fake.timelines.get(conversationId)!.getSnapshot().messages[0]!;
    const search = vi.spyOn(fake.app, "search").mockResolvedValue({
      ok: true,
      value: {
        items: Array.from({ length: 20 }, (_, index) => ({
          ...message,
          id: entityId<"message">(`large-${index}`),
          text: "x".repeat(60000),
        })),
      },
    });
    const first = request("history.search", { text: "private" }, ALL_CONTROL_PERMISSIONS);
    expect(await service(first, signal())).toMatchObject({ ok: true });
    for (let i = 0; i < 15; i++)
      expect(
        await service(
          request("history.search", { text: "private" }, ALL_CONTROL_PERMISSIONS),
          signal(),
        ),
      ).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(16);
    expect(await service(first, signal())).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(17);
  });
  it("bounds pending operations and does not cache cancellation before admission", async () => {
    const h = harness();
    const pending = gate<void>();
    const store = vi.spyOn(h.deps.secrets, "store").mockImplementation(async () => {
      await pending.promise;
      return { ok: true, value: entityId<"secret-ref">("env:REF") };
    });
    const service = createControlService({ settings: h.deps.settings, secrets: h.deps.secrets });
    const cancelled = request("secrets.store", { value: "private" });
    const controller = new AbortController();
    controller.abort();
    expect(await service(cancelled, controller.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    const accepted = Array.from({ length: 32 }, (_, i) =>
      service(i === 0 ? cancelled : request("secrets.store", { value: "private" }), signal()),
    );
    expect(await service(request("secrets.store", { value: "private" }), signal())).toMatchObject({
      ok: false,
      error: { code: "rate-limited" },
    });
    pending.resolve();
    expect((await Promise.all(accepted)).every((response) => response.ok)).toBe(true);
    expect(store).toHaveBeenCalledTimes(32);
  });
  it("validates direct service callers before hashing/admitting and returns only static protocol errors", async () => {
    const { service, fake } = fakeService();
    let calls = 0;
    const malformed = Object.defineProperty(request("status"), "params", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(await service(malformed, signal())).toMatchObject({
      ok: false,
      error: { code: "protocol" },
    });
    const cyclic: Record<string, JsonObject> = {};
    cyclic.self = cyclic;
    expect(await service(request("status", cyclic), signal())).toMatchObject({
      ok: false,
      error: { code: "protocol" },
    });
    expect(await service({ ...request("status"), id: "bad private id\n" }, signal())).toMatchObject(
      { id: "invalid-request", ok: false, error: { code: "protocol" } },
    );
    expect(
      await service(request("status", { value: "x".repeat(1048576) }), signal()),
    ).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(calls).toBe(0);
    expect(fake.actions).toHaveLength(0);
  });
});
