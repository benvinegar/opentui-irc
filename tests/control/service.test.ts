import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app";
import type { AppApi } from "../../src/contracts/app";
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
import { appSnapshot, settings } from "../fixtures/scenario";
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
