import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import { OpenIrc } from "../../src/ui/app";
import { createCommandService } from "../../src/services/commands";
import { createExternalActions } from "../../src/services/effects";
import { createFakeApp } from "../fakes/app";
import { conversationId, welcomeMessage } from "../fixtures/scenario";
import { entityId } from "../../src/contracts/common";

let setup: TestRendererSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});
async function mount() {
  const fake = createFakeApp();
  setup = await testRender(
    () => (
      <OpenIrc
        app={fake.app}
        commands={createCommandService(fake.app)}
        external={createExternalActions({ run: async () => ({ ok: true, value: undefined }) })}
      />
    ),
    { width: 110, height: 36 },
  );
  await setup.renderOnce();
  return { fake, view: setup };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("real Solid/OpenTUI shell", () => {
  test("renders hierarchy, accepts a message, and restores subscriptions", async () => {
    const { fake, view } = await mount();
    expect(view.captureCharFrame()).toContain("OpenIRC");
    expect(view.captureCharFrame()).toContain("CHANNELS");
    expect(view.captureCharFrame()).toContain("Welcome to OpenIRC!");
    await view.mockInput.pasteBracketedText("Hello 世界 😀");
    await view.mockInput.pressEnter();
    await tick();
    await view.renderOnce();
    expect(
      fake.actions.some(
        (action) => action.type === "message.send" && action.text === "Hello 世界 😀",
      ),
    ).toBe(true);
    view.renderer.destroy();
    setup = undefined;
    expect(fake.state.subscribers).toBe(0);
    expect(fake.timelines.get(conversationId)?.subscribers).toBe(0);
  });
  test("pasted slash commands remain inert and require insert plus deliberate send", async () => {
    const { fake, view } = await mount();
    await view.mockInput.pasteBracketedText("/quit\n/join #bad");
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Review paste");
    expect(fake.actions.some((action) => action.type === "conversation.join")).toBe(false);
    // Close is first; Tab moves to Insert; Enter inserts, but does not send.
    await view.mockInput.pressTab();
    await view.mockInput.pressEnter();
    await tick();
    expect(fake.actions.some((action) => action.type === "message.send")).toBe(false);
    await view.mockInput.pressEnter();
    await tick();
    expect(
      fake.actions.some(
        (action) => action.type === "message.send" && action.text === "/quit\n/join #bad",
      ),
    ).toBe(true);
  });
  test("form can be opened with mouse and has real inputs; draft survives resize", async () => {
    const { fake, view } = await mount();
    await view.mockInput.pasteBracketedText("a draft 😀");
    await tick();
    view.resize(80, 28);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("a draft");
    const button = view.renderer.root.findDescendantById("settings")!;
    await view.mockMouse.click(button.x + 1, button.y);
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Server hostname");
    await view.mockInput.pressEscape();
    await view.renderOnce();
    expect(fake.timelines.get(conversationId)?.getSnapshot().draft).toBe("a draft 😀");
  });
  test("10k-message source mounts only 300 message rows", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    timeline.publish({
      ...timeline.getSnapshot(),
      messages: Array.from({ length: 10_000 }, (_, index) => ({
        ...welcomeMessage,
        id: entityId<"message">(`large-${index}`),
        text: `Message ${index}`,
      })),
    });
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("message-large-0")).toBeUndefined();
    expect(view.renderer.root.findDescendantById("message-large-9999")).toBeDefined();
  });
  test("native display-cell offsets convert to UTF-16 for completion", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    timeline.publish({
      ...timeline.getSnapshot(),
      members: [{ id: entityId<"user">("u"), nick: "Alice", away: false, prefixes: [] }],
    });
    await view.mockInput.pasteBracketedText("世界 😀 Al");
    await view.mockInput.pressTab();
    await tick();
    expect(timeline.getSnapshot().draft).toBe("世界 😀 Alice");
  });
});
