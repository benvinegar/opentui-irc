import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app";
import type { AppApi } from "../../src/contracts/app";
import { entityId } from "../../src/contracts/common";
import type { SettingsDocument, SettingsRepository } from "../../src/contracts/settings";
import { DEFAULT_CONTROL_PERMISSIONS } from "../../src/contracts/control";
import { createControlService } from "../../src/control/service";
import { harness } from "../app/harness";
import { settings } from "../fixtures/scenario";

const signal = () => new AbortController().signal;
const apps: AppApi[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
});
async function setup() {
  const h = harness();
  let disk: SettingsDocument = structuredClone(settings);
  let writes = 0;
  const repository: SettingsRepository = {
    async load() {
      return { ok: true, value: disk };
    },
    async save(change, expected) {
      if (expected !== disk.revision)
        return { ok: false, error: { code: "conflict", message: "Conflict", retryable: false } };
      disk = {
        ...disk,
        [change.section]: change.value,
        revision: entityId<"config-revision">(`write-${++writes}`),
      };
      return { ok: true, value: disk };
    },
  };
  const created = await createApp({ ...h.deps, settings: repository }, signal());
  if (!created.ok) throw new Error(created.error.message);
  apps.push(created.value);
  return {
    app: created.value,
    h,
    repository,
    get disk() {
      return disk;
    },
    restore(document: SettingsDocument) {
      disk = document;
    },
  };
}

describe("app-owned control effect CAS", () => {
  it("rejects a reload whose harmless plan became destructive behind the serial admission boundary", async () => {
    const context = await setup();
    const app = context.app;
    const original = app.settings.getSnapshot()!;
    const inspected: SettingsDocument = {
      ...original,
      revision: entityId<"config-revision">("inspected-file-bytes"),
      user: { ...original.user, history: { ...original.user.history, retentionDays: 60 } },
    };
    context.restore(inspected);
    const prunes = vi.spyOn(context.h.deps.history, "prune");
    prunes.mockClear();
    const facade: AppApi = {
      ...app,
      async reloadSettings(expectedDisk, expectedLive, requestSignal) {
        // A cooperating UI save was queued before control's app admission. A local editor
        // temporarily restores its base, then restores the inspected bytes/hash after it.
        context.restore(original);
        const ui = await app.saveSettings(
          {
            section: "user",
            value: { ...original.user, history: { ...original.user.history, retentionDays: null } },
          },
          original.revision,
          requestSignal,
        );
        if (!ui.ok) throw new Error("Expected UI save");
        context.restore(inspected);
        return app.reloadSettings(expectedDisk, expectedLive, requestSignal);
      },
    };
    const service = createControlService({
      app: facade,
      settings: context.repository,
      secrets: context.h.deps.secrets,
    });
    const response = await service(
      {
        version: 1,
        id: "reload-live-base-cas",
        method: "config.reload",
        params: { expectedRevision: inspected.revision },
        permissions: DEFAULT_CONTROL_PERMISSIONS,
      },
      signal(),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(app.settings.getSnapshot()?.user.history.retentionDays).toBeNull();
    expect(prunes).not.toHaveBeenCalled();
  });
  it("checks the live base during a save even when an editor restores matching disk bytes", async () => {
    const context = await setup();
    const app = context.app;
    const original = app.settings.getSnapshot()!;
    const prunes = vi.spyOn(context.h.deps.history, "prune");
    prunes.mockClear();
    const facade: AppApi = {
      ...app,
      async saveSettings(change, expected, requestSignal) {
        const ui = await app.saveSettings(
          {
            section: "user",
            value: { ...original.user, history: { ...original.user.history, retentionDays: null } },
          },
          original.revision,
          requestSignal,
        );
        if (!ui.ok) throw new Error("Expected UI save");
        context.restore(original);
        return app.saveSettings(change, expected, requestSignal);
      },
    };
    const service = createControlService({
      app: facade,
      settings: context.repository,
      secrets: context.h.deps.secrets,
    });
    const response = await service(
      {
        version: 1,
        id: "save-live-base-cas",
        method: "config.apply",
        params: {
          edit: { section: "user", patch: { history: { retentionDays: 60 } } },
          expectedRevision: original.revision,
        },
        permissions: DEFAULT_CONTROL_PERMISSIONS,
      },
      signal(),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(app.settings.getSnapshot()?.user.history.retentionDays).toBeNull();
    expect(prunes).not.toHaveBeenCalled();
  });
});
