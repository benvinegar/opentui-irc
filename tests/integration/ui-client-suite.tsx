import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testRender } from "@opentui/solid";
import { OpenIrc } from "../../src/ui/app";
import { createApp } from "../../src/app/create-app";
import { createSettingsRepository } from "../../src/storage/settings";
import { createHistoryRepository } from "../../src/storage/history";
import { createCommandService } from "../../src/services/commands";
import { createExternalActions } from "../../src/services/effects";
import { harness } from "../app/harness";
import type { AppApi } from "../../src/contracts/app";
import type { TestRendererSetup } from "@opentui/core/testing";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("UI/app integration timed out");
    await Bun.sleep(5);
  }
}
async function click(view: TestRendererSetup, id: string) {
  const target = view.renderer.root.findDescendantById(id);
  expect(target).toBeDefined();
  await view.mockMouse.click(target!.x + 1, target!.y);
  await Bun.sleep(5);
  await view.renderOnce();
}

test("real UI -> application -> JSONC/SQLite onboarding and send journey", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openirc-ui-integration-"));
  let app: AppApi | undefined;
  let view: TestRendererSetup | undefined;
  try {
    const h = harness();
    const config = createSettingsRepository(join(directory, "config"));
    const opened = await createHistoryRepository(join(directory, "history.sqlite"));
    if (!opened.ok) throw new Error(opened.error.message);
    const created = await createApp(
      { ...h.deps, settings: config, history: opened.value },
      new AbortController().signal,
    );
    if (!created.ok) throw new Error(created.error.message);
    app = created.value;
    view = await testRender(
      () => (
        <OpenIrc
          app={app!}
          commands={createCommandService(app!)}
          external={createExternalActions({ run: async () => ({ ok: true, value: undefined }) })}
        />
      ),
      { width: 110, height: 38 },
    );
    await view.renderOnce();
    // Start from the real empty application and enter setup with a mouse click.
    expect(view.captureCharFrame()).toContain("Settings");
    await click(view, "add-network");
    for (const [id, text] of [
      ["network-name", "Real application"],
      ["network-host", "irc.example.org"],
      ["network-nick", "newcomer"],
    ]) {
      await click(view, id!);
      await view.mockInput.typeText(text!);
      await view.renderOnce();
    }
    for (let i = 0; i < 5; i++) await view.mockMouse.scroll(60, 20, "down");
    await view.renderOnce();
    await click(view, "network-save");
    await until(() => app!.state.getSnapshot().networks.length === 1);
    const saved = await config.load(new AbortController().signal);
    expect(saved.ok && saved.value.user.networks[0]?.name).toBe("Real application");
    const network = app.state.getSnapshot().networks[0]!;
    await view.mockInput.pressEscape();
    await Bun.sleep(50);
    await view.renderOnce();
    await click(view, `connect-${network.id}`);
    await until(() => h.sessions.length === 1);
    h.session(network.id).emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await until(() => app!.state.getSnapshot().networks[0]?.phase === "ready");
    await view.renderOnce();
    await click(view, "query");
    await view.mockInput.typeText("friend");
    await view.renderOnce();
    await click(view, "target-submit");
    await until(() => app!.state.getSnapshot().conversations.some((c) => c.kind === "direct"));
    await Bun.sleep(20);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Nicknames can be reused");
    await view.mockInput.typeText("hello through the real application");
    await view.mockInput.pressEnter();
    await until(() => h.session(network.id).commands.some((item) => item.command.type === "send"));
    const command = h.session(network.id).commands.find((item) => item.command.type === "send")!;
    const operation = app.operations.getSnapshot().find((item) => item.id === command.operationId)!;
    expect(operation).toBeDefined();
    const stored = await app.search(
      { text: "hello through the real application", limit: 10 },
      new AbortController().signal,
    );
    expect(stored.ok && stored.value.items.length).toBe(1);
    expect(app.state.getSnapshot().error).toBeUndefined();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("hello through the real application");
  } finally {
    view?.renderer.destroy();
    await app?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
