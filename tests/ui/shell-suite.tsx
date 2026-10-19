import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
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

async function click(view: TestRendererSetup, id: string) {
  const target = view.renderer.root.findDescendantById(id)!;
  expect(target).toBeDefined();
  await view.mockMouse.click(target.x + 1, target.y);
  await tick();
  await view.renderOnce();
}

describe("real Solid/OpenTUI shell", () => {
  test("Page Up/Down scroll dialogs without moving the conversation or editing a field", async () => {
    const { view } = await mount();
    const transcript = view.renderer.root.findDescendantById("transcript");
    expect(transcript).toBeInstanceOf(ScrollBoxRenderable);
    const transcriptTop = transcript instanceof ScrollBoxRenderable ? transcript.scrollTop : -1;
    await view.mockInput.pressKey("F1");
    await tick();
    await view.renderOnce();
    const dialog = view.renderer.root.findDescendantById("modal-scroll");
    expect(dialog).toBeInstanceOf(ScrollBoxRenderable);
    if (!(dialog instanceof ScrollBoxRenderable)) throw new Error("Missing dialog viewport");
    expect(dialog.scrollTop).toBe(0);
    await view.mockInput.pressKey("\x1b[6~");
    await view.renderOnce();
    expect(dialog.scrollTop).toBeGreaterThan(0);
    await view.mockInput.pressKey("\x1b[5~");
    await view.renderOnce();
    expect(dialog.scrollTop).toBe(0);
    for (let index = 0; index < 5; index++) await view.mockInput.pressKey("\x1b[6~");
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("/quit");
    expect(transcript instanceof ScrollBoxRenderable && transcript.scrollTop).toBe(transcriptTop);
    await click(view, "dialog-close");
    await click(view, "add-network");
    await click(view, "network-name");
    await view.mockInput.typeText("paging preserves this");
    await view.mockInput.pressKey("\x1b[6~");
    await view.mockInput.pressKey("\x1b[5~");
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("paging preserves this");
  });
  test("channel directory opens from /list, streams bounded/filterable results, and joins the pinned network", async () => {
    const { fake, view } = await mount();
    await view.mockInput.typeText("/list");
    await view.mockInput.pressEnter();
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Receiving directory");
    const discovery = fake.discoveries.get(welcomeMessage.networkId)!;
    discovery.publish({
      ...discovery.getSnapshot(),
      directory: {
        state: "ready",
        truncated: true,
        items: Array.from({ length: 150 }, (_, index) => ({
          channel: `#room-${index}`,
          userCount: index,
          topic: `Community ${index}`,
        })),
      },
    });
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("directory-join-99")).toBeDefined();
    expect(view.renderer.root.findDescendantById("directory-join-100")).toBeUndefined();
    expect(view.captureCharFrame()).toContain("Some channels");
    expect(view.captureCharFrame()).toContain("are omitted");
    await click(view, "directory-filter");
    await view.mockInput.typeText("#room-149");
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Join #room-149");
    await click(view, "directory-join-0");
    expect(
      fake.actions.some(
        (action) =>
          action.type === "conversation.join" &&
          action.channel === "#room-149" &&
          action.networkId === welcomeMessage.networkId,
      ),
    ).toBe(true);
    expect(discovery.subscribers).toBe(0);
  });
  test("WHOIS renders live details/errors and opens a direct conversation", async () => {
    const { fake, view } = await mount();
    await view.mockInput.typeText("/whois guide");
    await view.mockInput.pressEnter();
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Waiting for the network");
    const discovery = fake.discoveries.get(welcomeMessage.networkId)!;
    discovery.publish({
      ...discovery.getSnapshot(),
      user: {
        state: "failed",
        error: { code: "network", message: "No such nickname.", retryable: false },
      },
    });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("No such nickname");
    discovery.publish({
      ...discovery.getSnapshot(),
      user: {
        state: "ready",
        details: {
          nick: "guide",
          realname: "Community guide",
          account: "guide-account",
          awayReason: "Lunch",
          channels: ["#welcome"],
        },
      },
    });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Community guide");
    expect(view.captureCharFrame()).toContain("Away: Lunch");
    await click(view, "whois-message");
    expect(
      fake.actions.some(
        (action) => action.type === "conversation.query" && action.nick === "guide",
      ),
    ).toBe(true);
  });
  test("optional presets only populate setup and never save/connect without consent", async () => {
    const { fake, view } = await mount();
    const before = fake.settings.getSnapshot();
    await click(view, "add-network");
    await click(view, "preset-libera");
    expect(view.captureCharFrame()).toContain("irc.libera.chat");
    await click(view, "preset-oftc");
    expect(view.captureCharFrame()).toContain("irc.oftc.net");
    expect(fake.settings.getSnapshot()).toBe(before);
    expect(
      fake.actions.some(
        (action) => action.type === "network.connect" || action.type === "conversation.join",
      ),
    ).toBe(false);
  });
  test("typing is opt-in/capability gated and stops when opening a dialog", async () => {
    const { fake, view } = await mount();
    await view.mockInput.typeText("a");
    expect(fake.actions.some((action) => action.type === "typing.set")).toBe(false);
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, user: { ...document.user, sendTyping: true } });
    await view.mockInput.typeText("b");
    expect(fake.actions.some((action) => action.type === "typing.set")).toBe(false);
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        features: { ...network.features, typing: true },
      })),
    });
    await view.mockInput.typeText("cde");
    await tick();
    expect(fake.actions.filter((action) => action.type === "typing.set")).toEqual([
      { type: "typing.set", conversationId, active: true },
    ]);
    await view.mockInput.pressKey("F1");
    await tick();
    expect(fake.actions.filter((action) => action.type === "typing.set").at(-1)).toEqual({
      type: "typing.set",
      conversationId,
      active: false,
    });
  });
  test("removing an own server-backed message requires capability and explicit confirmation", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    const own = { ...welcomeMessage, serverId: "server-own", sender: { nick: "newcomer" } };
    timeline.publish({ ...timeline.getSnapshot(), messages: [own] });
    await view.renderOnce();
    await click(view, "message-picker");
    await click(view, `pick-${own.id}`);
    expect(view.renderer.root.findDescendantById("redact-message")).toBeUndefined();
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        features: { ...network.features, redaction: true },
      })),
    });
    await view.renderOnce();
    await click(view, "redact-message");
    expect(fake.actions.some((action) => action.type === "message.redact")).toBe(false);
    await click(view, "redact-cancel");
    expect(fake.actions.some((action) => action.type === "message.redact")).toBe(false);
    await click(view, "message-picker");
    await click(view, `pick-${own.id}`);
    await click(view, "redact-message");
    await click(view, "redact-confirm");
    expect(fake.actions.filter((action) => action.type === "message.redact")).toHaveLength(1);
    expect(timeline.getSnapshot().messages[0]?.redacted).toBe(true);
  });
  test("network onboarding is mouse-first and persists only secret references", async () => {
    const { fake, view } = await mount();
    await click(view, "add-network");
    for (const [id, text] of [
      ["network-name", "Community"],
      ["network-host", "irc.example.org"],
      ["network-nick", "newcomer"],
    ]) {
      await click(view, id!);
      await view.mockInput.typeText(text!);
      await view.renderOnce();
    }
    const scroll = view.renderer.root.findDescendantById("modal-scroll");
    expect(scroll).toBeInstanceOf(ScrollBoxRenderable);
    for (let index = 0; index < 5; index++) await view.mockMouse.scroll(60, 20, "down");
    await view.renderOnce();
    await click(view, "network-account");
    await view.mockInput.typeText("my-account");
    await click(view, "auth-mode");
    await click(view, "network-env");
    await view.mockInput.typeText("OPENIRC_PASSWORD");
    await view.renderOnce();
    await click(view, "network-save");
    const saved = fake.settings.getSnapshot()?.user.networks.at(-1);
    expect(saved?.name).toBe("Community");
    expect(saved?.endpoints).toEqual([{ host: "irc.example.org", port: 6697, tls: true }]);
    expect(saved?.identity.nick).toBe("newcomer");
    expect(saved?.sasl).toEqual({
      mechanism: "PLAIN",
      account: "my-account",
      password: entityId<"secret-ref">("env:OPENIRC_PASSWORD"),
      required: true,
    });
  });
  test("password input masks editing/paste and hands plaintext only to storeSecret", async () => {
    const { fake, view } = await mount();
    const received: string[] = [];
    fake.app.storeSecret = async (value) => {
      received.push(value);
      return { ok: true, value: entityId<"secret-ref">("keychain:test-only") };
    };
    await click(view, "add-network");
    for (const [id, text] of [
      ["network-host", "irc.example.org"],
      ["network-nick", "newcomer"],
    ]) {
      await click(view, id!);
      await view.mockInput.typeText(text!);
      await view.renderOnce();
    }
    for (let index = 0; index < 4; index++) await view.mockMouse.scroll(60, 20, "down");
    await view.renderOnce();
    await click(view, "network-account");
    await view.mockInput.typeText("my-account");
    await click(view, "network-password");
    await view.mockInput.typeText("test-secret");
    await view.mockInput.pressBackspace();
    await view.mockInput.pasteBracketedText("t-42");
    await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain("test-secret-42");
    expect(view.captureCharFrame()).not.toContain("test-secre");
    expect(view.captureCharFrame()).toContain("••••");
    await click(view, "network-save");
    expect(received).toEqual(["test-secret-42"]);
    expect(fake.settings.getSnapshot()?.user.networks.at(-1)?.sasl?.password).toBe(
      entityId<"secret-ref">("keychain:test-only"),
    );
    expect(JSON.stringify(fake.settings.getSnapshot())).not.toContain("test-secret");
    expect(JSON.stringify(fake.actions)).not.toContain("test-secret");
  });
  test("mouse join and direct-message controls dispatch the same actions as commands", async () => {
    const { fake, view } = await mount();
    await click(view, "join");
    await click(view, "dialog-input");
    await view.mockInput.typeText("#newcomers");
    await view.renderOnce();
    await click(view, "target-submit");
    expect(
      fake.actions.some(
        (action) => action.type === "conversation.join" && action.channel === "#newcomers",
      ),
    ).toBe(true);
    const joinedId = fake.state.getSnapshot().activeConversationId;
    await view.mockInput.typeText("Hello channel");
    await view.mockInput.pressEnter();
    await tick();
    expect(
      fake.actions.some(
        (action) =>
          action.type === "message.send" &&
          action.text === "Hello channel" &&
          action.conversationId === joinedId,
      ),
    ).toBe(true);
    await click(view, "query");
    await click(view, "dialog-input");
    await view.mockInput.typeText("friend");
    await view.renderOnce();
    await click(view, "target-submit");
    expect(
      fake.actions.some(
        (action) => action.type === "conversation.query" && action.nick === "friend",
      ),
    ).toBe(true);
    const directId = fake.state.getSnapshot().activeConversationId;
    await view.mockInput.typeText("Hello friend");
    await view.mockInput.pressEnter();
    await tick();
    expect(
      fake.actions.some(
        (action) =>
          action.type === "message.send" &&
          action.text === "Hello friend" &&
          action.conversationId === directId,
      ),
    ).toBe(true);
    expect(fake.actions.filter((action) => action.type === "conversation.query")).toHaveLength(1);
  });
  test("a historical window offers an explicit app-level return to latest", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    timeline.publish({ ...timeline.getSnapshot(), atLatest: false });
    await view.renderOnce();
    await click(view, "latest");
    expect(fake.actions.some((action) => action.type === "history.latest")).toBe(true);
  });
  test("scrolling back remains anchored while messages arrive", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    const source = Array.from({ length: 60 }, (_, index) => ({
      ...welcomeMessage,
      id: entityId<"message">(`anchor-${index}`),
      text: `Message ${index}`,
    }));
    timeline.publish({ ...timeline.getSnapshot(), messages: source });
    await view.renderOnce();
    const scroll = view.renderer.root.findDescendantById("transcript");
    expect(scroll).toBeInstanceOf(ScrollBoxRenderable);
    if (!(scroll instanceof ScrollBoxRenderable)) return;
    scroll.scrollTo(10);
    await view.renderOnce();
    const before = scroll.scrollTop;
    timeline.publish({
      ...timeline.getSnapshot(),
      messages: [
        ...source,
        { ...welcomeMessage, id: entityId<"message">("new-live"), text: "New message" },
      ],
    });
    await view.renderOnce();
    await view.renderOnce();
    expect(scroll.scrollTop).toBe(before);
    expect(scroll.scrollTop + scroll.viewport.height).toBeLessThan(scroll.scrollHeight);
    const anchor = view.renderer.root.findDescendantById("message-anchor-5")!;
    const relativeY = anchor.y - scroll.viewport.y;
    timeline.publish({
      ...timeline.getSnapshot(),
      messages: [
        ...Array.from({ length: 5 }, (_, index) => ({
          ...welcomeMessage,
          id: entityId<"message">(`prepended-${index}`),
          text: "Older message",
        })),
        ...timeline.getSnapshot().messages,
      ],
    });
    await view.renderOnce();
    await view.renderOnce();
    expect(anchor.y - scroll.viewport.y).toBe(relativeY);
    view.resize(90, 30);
    await view.renderOnce();
    await view.renderOnce();
    expect(anchor.y - scroll.viewport.y).toBe(relativeY);
  });
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
  test("drafts and literal-paste safety survive conversation switching", async () => {
    const { fake, view } = await mount();
    await view.mockInput.pasteBracketedText("/quit");
    await view.renderOnce();
    await view.mockInput.pressTab();
    await view.mockInput.pressEnter();
    await tick();
    await fake.app.dispatch(
      { type: "conversation.query", networkId: welcomeMessage.networkId, nick: "friend" },
      new AbortController().signal,
    );
    await view.renderOnce();
    await view.mockInput.typeText("other draft");
    await tick();
    await fake.app.dispatch(
      { type: "conversation.activate", conversationId },
      new AbortController().signal,
    );
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("/quit");
    await view.mockInput.pressEnter();
    await tick();
    expect(
      fake.actions.some((action) => action.type === "message.send" && action.text === "/quit"),
    ).toBe(true);
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
