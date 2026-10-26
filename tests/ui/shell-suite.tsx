import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
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
async function mount(kittyKeyboard = false) {
  const fake = createFakeApp();
  setup = await testRender(
    () => (
      <OpenIrc
        app={fake.app}
        commands={createCommandService(fake.app)}
        external={createExternalActions({ run: async () => ({ ok: true, value: undefined }) })}
      />
    ),
    { width: 110, height: 36, kittyKeyboard },
  );
  await setup.renderOnce();
  return { fake, view: setup };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function click(view: TestRendererSetup, id: string) {
  let target = view.renderer.root.findDescendantById(id);
  if (!target && !view.renderer.root.findDescendantById("modal-backdrop")) {
    // Secondary actions live in the ctrl+k palette rather than permanent buttons.
    view.mockInput.pressKey("k", { ctrl: true });
    await tick();
    await view.renderOnce();
    target = view.renderer.root.findDescendantById(id);
  }
  const scroll = view.renderer.root.findDescendantById("modal-scroll");
  if (target && scroll instanceof ScrollBoxRenderable && scroll.findDescendantById(id)) {
    const { y, height } = scroll.viewport;
    if (target.y < y || target.y >= y + height) {
      scroll.scrollBy(target.y - y - 1);
      await view.renderOnce();
    }
  }
  expect(target?.id).toBe(id);
  await view.mockMouse.click(target!.x + 1, target!.y);
  await tick();
  await view.renderOnce();
}

describe("real Solid/OpenTUI shell", () => {
  test("HistServ is hidden by default, reversibly, without hiding normal notices or errors", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        { ...welcomeMessage, text: "real-user-message" },
        {
          ...welcomeMessage,
          id: entityId<"message">("hist-notice"),
          sender: { nick: "HistServ" },
          kind: "notice",
          text: "hidden-service-notice",
        },
        {
          ...welcomeMessage,
          id: entityId<"message">("normal-notice"),
          sender: { nick: "robert" },
          kind: "notice",
          text: "ordinary-notice-kept",
        },
        {
          ...welcomeMessage,
          id: entityId<"message">("hist-privmsg"),
          sender: { nick: "hIsTsErV" },
          text: "hidden-service-privmsg",
        },
        {
          ...welcomeMessage,
          id: entityId<"message">("network-error"),
          sender: { nick: "OpenIRC" },
          kind: "event",
          text: "connection-error-kept",
        },
      ],
    });
    await view.renderOnce();
    let frame = view.captureCharFrame();
    expect(frame).toContain("real-user-message");
    expect(frame).toContain("ordinary-notice-kept");
    expect(frame).toContain("connection-error-kept");
    expect(frame).not.toContain("hidden-service-notice");
    expect(frame).not.toContain("hidden-service-privmsg");
    // The reversible toggle lives in the ctrl+k palette and reports the hidden count.
    await view.mockInput.pressKey("k", { ctrl: true });
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Show HistServ (2 hidden)");
    await click(view, "histserv-toggle");
    expect(fake.settings.getSnapshot()?.tui.showHistServ).toBe(true);
    frame = view.captureCharFrame();
    expect(frame).toContain("hidden-service-notice");
    expect(frame).toContain("hidden-service-privmsg");
    await click(view, "histserv-toggle");
    expect(fake.settings.getSnapshot()?.tui.showHistServ).toBe(false);
    expect(view.captureCharFrame()).not.toContain("hidden-service-privmsg");
    expect(model.getSnapshot().messages).toHaveLength(5);
  });
  test("consecutive lines from one sender omit the repeated time and nickname", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: ["first-grouped-line", "second-grouped-line"].map((text, index) => ({
        ...welcomeMessage,
        id: entityId<"message">(`grouped-${index}`),
        sender: { nick: "groupnick" },
        receivedAt: welcomeMessage.receivedAt + index * 1000,
        text,
      })),
    });
    await view.renderOnce();
    const lines = view.captureCharFrame().split("\n");
    expect(lines.find((line) => line.includes("first-grouped-line"))).toContain("groupnick");
    expect(lines.find((line) => line.includes("second-grouped-line"))).not.toContain("groupnick");
    // Comfortable density: a blank line above each new sender group, none inside it.
    const first = lines.findIndex((line) => line.includes("first-grouped-line"));
    expect(lines[first + 1]).toContain("second-grouped-line");
    expect(lines[first - 1]).not.toMatch(/\d\d:\d\d/u);
    const row = (id: string) => view.renderer.root.findDescendantById(`message-${id}`)!.height;
    expect([row("grouped-0"), row("grouped-1")]).toEqual([2, 1]);
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, tui: { ...document.tui, density: "compact" } });
    await view.renderOnce();
    expect([row("grouped-0"), row("grouped-1")]).toEqual([1, 1]);
  });
  test("long names end-truncate with a single-cell ellipsis", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [{ ...welcomeMessage, sender: { nick: "averyveryverylongnickname" } }],
    });
    await view.renderOnce();
    await view.renderOnce();
    const frame = view.captureCharFrame();
    expect(frame).toMatch(/averyveryverylon…/u);
    expect(frame).not.toContain("...");
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, tui: { ...document.tui, sidebarWidth: 12 } });
    view.resize(60, 24);
    await view.renderOnce();
    await view.renderOnce();
    const sidebar = view.renderer.root.findDescendantById("sidebar")!;
    const rows = view
      .captureCharFrame()
      .split("\n")
      .map((line) => line.slice(sidebar.x, sidebar.x + sidebar.width));
    expect(rows.some((row) => row.includes("…"))).toBe(true);
  });
  test("clicking a message opens a small menu at the click with letter shortcuts", async () => {
    const { fake, view } = await mount();
    const row = view.renderer.root.findDescendantById(`body-${welcomeMessage.id}`)!;
    await view.mockMouse.click(row.x + 4, row.y);
    await tick();
    await view.renderOnce();
    const popover = view.renderer.root.findDescendantById("popover")!;
    expect(view.renderer.root.findDescendantById("modal-backdrop")).toBeUndefined();
    expect(popover.y).toBe(row.y + 1);
    expect(popover.x).toBe(row.x + 3);
    expect(popover.width).toBeLessThan(40);
    expect(view.renderer.currentFocusedRenderable?.id).toBe("copy-message");
    expect(view.captureCharFrame()).toContain("About guide");
    // No reply/react without capabilities, no link item without links.
    for (const id of ["reply-message", "react-message", "url-0", "open-links"])
      expect(view.renderer.root.findDescendantById(id)).toBeUndefined();
    view.mockInput.pressKey("c");
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
    expect(view.captureCharFrame()).toContain("Copied.");
    // A press outside closes it without opening anything underneath.
    await view.mockMouse.click(row.x + 4, row.y);
    await tick();
    await view.renderOnce();
    await view.mockMouse.click(1, 1);
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
    expect(fake.actions.some((action) => action.type === "conversation.activate")).toBe(false);
  });
  test("dragging across message text copies the selection instead of opening the menu", async () => {
    const { view } = await mount();
    const body = view.renderer.root.findDescendantById(`body-${welcomeMessage.id}`)!;
    await view.mockMouse.drag(body.x, body.y, body.x + 6, body.y);
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
    expect(view.renderer.getSelection()?.getSelectedText()).toBe("Welcome");
    expect(view.captureCharFrame()).toContain("Copied 7 characters.");
  });
  test("multi-row selections copy message text only and never open the menu", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        {
          ...welcomeMessage,
          id: entityId<"message">("p1"),
          sender: { nick: "joey" },
          text: "first line",
        },
        {
          ...welcomeMessage,
          id: entityId<"message">("p2"),
          sender: { nick: "alice" },
          text: "second line",
          receivedAt: welcomeMessage.receivedAt + 600_000,
        },
      ],
    });
    await view.renderOnce();
    await view.renderOnce();
    const first = view.renderer.root.findDescendantById("body-p1")!;
    const second = view.renderer.root.findDescendantById("body-p2")!;
    await view.mockMouse.drag(first.x, first.y, second.x + 5, second.y);
    await tick();
    await view.renderOnce();
    expect(view.renderer.getSelection()?.getSelectedText()).toBe("first line\nsecond");
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
    // Time and nickname are not selectable, and a drag from there is not a click either.
    const transcript = view.renderer.root.findDescendantById("transcript")!;
    await view.mockMouse.drag(transcript.x, first.y, second.x + 5, second.y);
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
  });
  test("the react submenu sends the chosen emoji and links get their own submenu", async () => {
    const { fake, view } = await mount();
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        features: { ...network.features, reactions: true, replies: true },
      })),
    });
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        {
          ...welcomeMessage,
          serverId: "server-1",
          text: "see https://example.com/a and https://example.com/b",
        },
      ],
    });
    await view.renderOnce();
    await click(view, `body-${welcomeMessage.id}`);
    expect(view.renderer.root.findDescendantById("reply-message")?.id).toBe("reply-message");
    view.mockInput.pressKey("o");
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("https://example.com/b");
    await view.mockInput.pressEscape();
    await Bun.sleep(50);
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("copy-message")?.id).toBe("copy-message");
    view.mockInput.pressKey("e");
    await tick();
    await view.renderOnce();
    expect(view.renderer.currentFocusedRenderable?.id).toBe("react-0");
    view.mockInput.pressKey("2");
    await tick();
    expect(fake.actions.find((action) => action.type === "message.react")).toMatchObject({
      value: "🎉",
      remove: false,
    });
    expect(view.renderer.root.findDescendantById("popover")).toBeUndefined();
  });
  test("clicking a nickname shows a person card from WHOIS and can start a DM", async () => {
    const { fake, view } = await mount();
    await click(view, `nick-${welcomeMessage.id}`);
    expect(view.renderer.root.findDescendantById("popover")?.id).toBe("popover");
    expect(
      fake.actions.some(
        (action) =>
          action.type === "irc.request" &&
          action.command.type === "whois" &&
          action.command.nick === "guide",
      ),
    ).toBe(true);
    expect(view.captureCharFrame()).toContain("Looking up…");
    const discovery = fake.discoveries.get(welcomeMessage.networkId)!;
    discovery.publish({
      ...discovery.getSnapshot(),
      user: {
        state: "ready",
        details: {
          nick: "guide",
          username: "g",
          hostname: "example.test",
          realname: "Community guide",
          channels: ["#welcome"],
        },
      },
    });
    await view.renderOnce();
    const frame = view.captureCharFrame();
    expect(frame).toContain("g@example.test");
    expect(frame).toContain('"Community guide"');
    expect(frame).toContain("not identified");
    expect(view.renderer.currentFocusedRenderable?.id).toBe("person-message");
    view.mockInput.pressKey("m");
    await tick();
    expect(
      fake.actions.some(
        (action) => action.type === "conversation.query" && action.nick === "guide",
      ),
    ).toBe(true);
  });
  test("ctrl+k filters conversations and actions and Enter runs the highlighted entry", async () => {
    const { view } = await mount();
    view.mockInput.pressKey("k", { ctrl: true });
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Jump to…");
    expect(view.captureCharFrame()).toContain("Join a channel…");
    await view.mockInput.typeText("join a");
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain("Search history…");
    view.mockInput.pressEnter();
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Channel name");
  });
  test("arrow keys move through dialog actions", async () => {
    const { view } = await mount();
    await click(view, `message-${welcomeMessage.id}`);
    expect(view.renderer.currentFocusedRenderable?.id).toBe("copy-message");
    view.mockInput.pressArrow("down");
    await tick();
    await view.renderOnce();
    expect(view.renderer.currentFocusedRenderable?.id).not.toBe("copy-message");
    view.mockInput.pressArrow("up");
    await tick();
    expect(view.renderer.currentFocusedRenderable?.id).toBe("copy-message");
  });
  test("dragging column dividers resizes and persists sidebar, member and author widths", async () => {
    const { fake, view } = await mount();
    view.resize(150, 36);
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, tui: { ...document.tui, memberList: true } });
    await view.renderOnce();
    const sidebar = view.renderer.root.findDescendantById("sidebar-splitter")!;
    expect(sidebar.x).toBe(24);
    // Move several cells in one motion: the pointer leaves the one-cell divider immediately.
    await view.mockMouse.drag(sidebar.x, 10, sidebar.x + 8, 10);
    await tick();
    await view.renderOnce();
    expect(fake.settings.getSnapshot()?.tui.sidebarWidth).toBe(32);
    expect(view.renderer.root.findDescendantById("sidebar-splitter")?.x).toBe(32);
    expect(view.renderer.root.findDescendantById("modal-backdrop")).toBeUndefined();
    const members = view.renderer.root.findDescendantById("members-splitter")!;
    await view.mockMouse.drag(members.x, 10, members.x - 6, 10);
    await tick();
    await view.renderOnce();
    expect(fake.settings.getSnapshot()?.tui.memberListWidth).toBe(28);
    expect(view.renderer.root.findDescendantById("members")?.width).toBe(28);
    expect(view.renderer.root.findDescendantById("modal-backdrop")).toBeUndefined();
    const rail = view.renderer.root.findDescendantById("transcript-divider")!;
    const frame = view.renderer.root.findDescendantById("transcript-frame")!;
    const before = rail.x - frame.x;
    await view.mockMouse.drag(rail.x, 10, rail.x + 7, 10);
    await tick();
    await view.renderOnce();
    expect(fake.settings.getSnapshot()?.tui.authorColumnWidth).toBe(before + 7);
    expect(view.renderer.root.findDescendantById("transcript-divider")?.x).toBe(
      frame.x + before + 7,
    );
    expect(view.renderer.root.findDescendantById("modal-backdrop")).toBeUndefined();
  });
  test("a service-only window explains that older chat may still exist", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [{ ...welcomeMessage, sender: { nick: "HistServ" }, text: "service-only-body" }],
    });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Only HistServ entries are loaded.");
    expect(view.captureCharFrame()).not.toContain("service-only-body");
    expect(view.renderer.root.findDescendantById("older")?.id).toBe("older");
  });
  test("visibility reports reference the rendered user message, not a hidden service tail", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        welcomeMessage,
        {
          ...welcomeMessage,
          id: entityId<"message">("hidden-tail"),
          sender: { nick: "HistServ" },
          text: "hidden-tail-body",
        },
      ],
    });
    await view.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      fake.actions.some(
        (action) =>
          action.type === "view.report" && action.lastVisibleMessageId === welcomeMessage.id,
      ),
    ).toBe(true);
    expect(
      fake.actions.some(
        (action) =>
          action.type === "view.report" &&
          action.lastVisibleMessageId === entityId<"message">("hidden-tail"),
      ),
    ).toBe(false);
  });
  test("explicit search reveal can show a service entry without changing the saved default", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    const id = entityId<"message">("search-service");
    model.publish({
      ...model.getSnapshot(),
      messages: [
        { ...welcomeMessage, id, sender: { nick: "HistServ" }, text: "service-search-marker" },
      ],
    });
    await click(view, "search");
    await view.mockInput.typeText("service-search-marker");
    await click(view, "search-submit");
    await click(view, `result-${id}`);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("service-search-marker");
    expect(fake.settings.getSnapshot()?.tui.showHistServ).toBe(false);
    await click(view, "histserv-toggle");
    expect(view.captureCharFrame()).not.toContain("service-search-marker");
  });
  test("compact transcript aligns time/nicks beside a full-height fixed divider at every width", async () => {
    const { fake, view } = await mount();
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, tui: { ...document.tui, density: "compact" } });
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        {
          ...welcomeMessage,
          id: entityId<"message">("grid-joey"),
          sender: { nick: "joey" },
          text: "wrapped words ".repeat(8),
        },
        {
          ...welcomeMessage,
          id: entityId<"message">("grid-robert"),
          sender: { nick: "robert" },
          text: "Second participant",
        },
      ],
    });
    for (const width of [110, 80, 50, 110]) {
      view.resize(width, 24);
      await view.renderOnce();
      await view.renderOnce();
      const divider = view.renderer.root.findDescendantById("transcript-divider")!;
      const frame = view.renderer.root.findDescendantById("transcript-frame")!;
      const body = view.renderer.root.findDescendantById("body-grid-joey")!;
      const nick = view.renderer.root.findDescendantById("nick-grid-joey")!;
      expect(divider.width).toBe(1);
      expect(divider.y).toBe(frame.y);
      expect(divider.height).toBe(frame.height);
      expect(body.x).toBe(divider.x + 2);
      expect(body.y).toBe(nick.y);
      expect(body.height).toBeGreaterThan(1);
      if (!(body instanceof TextRenderable)) throw new Error("Missing message text");
      expect(body.height).toBe(body.virtualLineCount);
      const rendered = view
        .captureCharFrame()
        .split("\n")
        .slice(body.y, body.y + body.height)
        .map((line) => line.slice(body.x, body.x + body.width).trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      expect(rendered).toBe("wrapped words ".repeat(8).trim());
      expect(nick.height).toBe(1);
      const robert = view.renderer.root.findDescendantById("nick-grid-robert")!;
      const spans = view.captureSpans().lines;
      const joeyColor = spans[nick.y]?.spans
        .find((span) => span.text.includes("joey"))
        ?.fg.toInts();
      const robertColor = spans[robert.y]?.spans
        .find((span) => span.text.includes("robert"))
        ?.fg.toInts();
      expect(joeyColor).toBeDefined();
      expect(robertColor).toBeDefined();
      expect(joeyColor).not.toEqual(robertColor);
      const lines = view.captureCharFrame().split("\n");
      for (let row = divider.y; row < divider.y + divider.height; row++)
        expect(lines[row]![divider.x]).toBe("│");
      expect(lines[0]!.trim()).not.toBe("");
      expect(lines[23]!.trim()).not.toBe("");
      expect(view.renderer.root.findDescendantById("conversation-header")?.height).toBe(2);
      expect(view.renderer.root.findDescendantById("composer-panel")?.height).toBe(3);
    }
  });
  test("wrapped messages reserve the scrollbar cell without clipping words or adding blank rows", async () => {
    const { fake, view } = await mount();
    const text =
      "A longer synthetic message wraps entirely inside the message column. Continuation lines stay aligned with the text, not the timestamp or nickname, while the divider remains fixed.";
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [{ ...welcomeMessage, id: entityId<"message">("wrapped-grid"), text }],
    });
    await view.renderOnce();
    await view.renderOnce();
    const body = view.renderer.root.findDescendantById("body-wrapped-grid");
    if (!(body instanceof TextRenderable)) throw new Error("Missing message text");
    const rows = view
      .captureCharFrame()
      .split("\n")
      .slice(body.y, body.y + body.height)
      .map((line) => line.slice(body.x, body.x + body.width).trim());
    expect(rows.every((row) => row.length > 0)).toBe(true);
    expect(rows.join(" ")).toBe(text);
    expect(body.height).toBe(body.virtualLineCount);
  });
  test("long Unicode nicknames stay in the gutter and message decorations stay on the right", async () => {
    const { fake, view } = await mount();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: [
        {
          ...welcomeMessage,
          id: entityId<"message">("unicode-grid"),
          sender: { nick: "長い名前👩‍💻-a-very-long-nickname" },
          text: "Unicode 你好 é 👩‍💻 🇯🇵",
          replyTo: { serverId: "parent-server-message", localId: welcomeMessage.id },
          reactions: [{ value: "👍", count: 2, reactedBySelf: false }],
          sendState: "uncertain",
        },
      ],
    });
    await view.renderOnce();
    await view.renderOnce();
    const divider = view.renderer.root.findDescendantById("transcript-divider")!;
    const nick = view.renderer.root.findDescendantById("nick-unicode-grid")!;
    const body = view.renderer.root.findDescendantById("body-unicode-grid")!;
    expect(nick.height).toBe(1);
    expect(nick.x + nick.width).toBeLessThan(divider.x);
    expect(body.x).toBe(divider.x + 2);
    const frame = view.captureCharFrame();
    expect(frame).toContain("Unicode 你好");
    expect(frame).toContain("[uncertain]");
    expect(frame).toContain("↳ reply to");
    expect(frame).toContain("👍 2");
    await click(view, "message-unicode-grid");
    expect(view.renderer.root.findDescendantById("copy-message")?.id).toBe("copy-message");
  });
  test("composer uses one row when empty and grows only for multiline drafts", async () => {
    const { view } = await mount(true);
    expect(view.renderer.root.findDescendantById("composer-panel")?.height).toBe(3);
    await view.mockInput.typeText("first");
    await view.mockInput.pressEnter({ shift: true });
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("composer-panel")?.height).toBe(4);
    await view.mockInput.typeText("second");
    await view.mockInput.pressEnter({ shift: true });
    await view.mockInput.typeText("third");
    await view.mockInput.pressEnter({ shift: true });
    await tick();
    await view.renderOnce();
    expect(view.renderer.root.findDescendantById("composer-panel")?.height).toBe(5);
  });
  test("typing status has its own row above the composer in a full short transcript", async () => {
    const { fake, view } = await mount();
    view.resize(80, 24);
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: Array.from({ length: 80 }, (_, index) => ({
        ...welcomeMessage,
        id: entityId<"message">(`typing-row-${index}`),
        text: `filler-row-${index}-marker`,
      })),
    });
    await view.renderOnce();
    await view.renderOnce();
    const transcript = view.renderer.root.findDescendantById("transcript");
    if (!(transcript instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
    transcript.scrollTo(transcript.scrollHeight);
    await view.mockInput.typeText("QA bottom draft");
    model.publish({ ...model.getSnapshot(), typing: [entityId<"user">("typing-user")] });
    await view.renderOnce();
    await view.renderOnce();
    const frame = view.captureCharFrame();
    expect(frame).toContain("QA bottom draft");
    expect(frame).toContain("Someone is typing…");
    const line = frame.split("\n").find((line) => line.includes("Someone is typing"))!;
    expect(line.slice(line.indexOf("Someone")).trim()).toBe("Someone is typing…");
  });
  test("reply and member hints reserve rows beside typing in a full wide transcript", async () => {
    const { fake, view } = await mount();
    view.resize(130, 24);
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, tui: { ...document.tui, memberList: true } });
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        features: { ...network.features, replies: true },
      })),
    });
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      messages: Array.from({ length: 80 }, (_, index) => ({
        ...welcomeMessage,
        id: entityId<"message">(`status-row-${index}`),
        serverId: `status-${index}`,
        text: `filler-row-${index}-marker`,
      })),
    });
    await view.renderOnce();
    await view.renderOnce();
    const transcript = view.renderer.root.findDescendantById("transcript");
    if (!(transcript instanceof ScrollBoxRenderable)) throw new Error("Missing transcript");
    transcript.scrollTo(transcript.scrollHeight);
    await view.renderOnce();
    await click(view, "message-status-row-79");
    await click(view, "reply-message");
    model.publish({ ...model.getSnapshot(), typing: [entityId<"user">("typing-user")] });
    await view.renderOnce();
    await view.renderOnce();
    const frame = view.captureCharFrame();
    expect(view.renderer.root.findDescendantById("members")?.id).toBe("members");
    expect(frame).toContain("PEOPLE ·");
    for (const hint of ["Someone is typing…", "Replying to a message · esc to cancel"]) {
      expect(frame).toContain(hint);
      const line = frame.split("\n").find((line) => line.includes(hint))!;
      // Hints own their row; only the member panel's border may share it.
      expect(line.slice(line.indexOf(hint)).split("│")[0]!.trim()).toBe(hint);
    }
  });
  test("saving history preferences closes the form and permits a fresh inverse change", async () => {
    const { fake, view } = await mount();
    for (const enabled of [false, true]) {
      await click(view, "settings");
      const scroll = view.renderer.root.findDescendantById("modal-scroll");
      if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing settings viewport");
      scroll.scrollTo(scroll.scrollHeight);
      await view.renderOnce();
      await click(view, "history-toggle");
      expect(fake.settings.getSnapshot()?.user.history.enabled).toBe(enabled);
      expect(view.renderer.root.findDescendantById("modal-scroll")?.id).toBeUndefined();
    }
  });
  test("saving appearance closes its revision-bound form before another appearance save", async () => {
    const { fake, view } = await mount();
    for (const theme of ["light", "high-contrast"] as const) {
      await click(view, "settings");
      const scroll = view.renderer.root.findDescendantById("modal-scroll");
      if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing settings viewport");
      scroll.scrollTo(scroll.scrollHeight);
      await view.renderOnce();
      await click(view, `theme-${theme}`);
      await click(view, "appearance-save");
      expect(fake.settings.getSnapshot()?.tui.theme).toBe(theme);
      expect(view.renderer.root.findDescendantById("modal-scroll")?.id).toBeUndefined();
    }
    expect(fake.actions.some((action) => action.type === "network.connect")).toBe(false);
  });
  test("conditional credential fields keep their visual keyboard order", async () => {
    const { view } = await mount();
    await click(view, "add-network");
    await click(view, "auth-mode");
    await view.mockInput.pressTab({ shift: true });
    await view.renderOnce();
    expect(view.renderer.currentFocusedRenderable?.id).toBe("network-env");
    await view.mockInput.pressTab();
    expect(view.renderer.currentFocusedRenderable?.id).toBe("auth-mode");
    await view.mockInput.pressTab();
    expect(view.renderer.currentFocusedRenderable?.id).toBe("network-channel");
  });
  test("a send shows its state on the message, never a delivery claim or a stale dialog status", async () => {
    const { view } = await mount();
    await view.mockInput.typeText("previous send");
    await view.mockInput.pressEnter();
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain("Accepted locally");
    expect(view.captureCharFrame()).not.toContain("delivered");
    await view.mockInput.pressKey("F1");
    await tick();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Help");
    expect(view.captureCharFrame()).not.toContain("Accepted locally");
  });
  test("disconnected networks do not claim a plaintext or active TLS connection", async () => {
    const { fake, view } = await mount();
    for (const secure of [false, true]) {
      fake.state.publish({
        ...fake.state.getSnapshot(),
        networks: fake.state.getSnapshot().networks.map((network) => ({
          ...network,
          phase: "disconnected",
          secure,
        })),
      });
      await view.renderOnce();
      expect(view.captureCharFrame()).not.toContain("plaintext");
      expect(view.captureCharFrame()).not.toContain("TLS");
    }
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        phase: "ready",
        secure: false,
      })),
    });
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("plaintext");
  });
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
  test("tabbing through a short settings dialog keeps every focused control visible", async () => {
    const { view } = await mount();
    view.resize(80, 24);
    await view.renderOnce();
    await click(view, "add-network");
    const dialog = view.renderer.root.findDescendantById("modal-scroll");
    expect(dialog).toBeInstanceOf(ScrollBoxRenderable);
    if (!(dialog instanceof ScrollBoxRenderable)) throw new Error("Missing dialog viewport");
    for (let index = 0; index < 24; index++) {
      await view.mockInput.pressTab();
      await view.renderOnce();
      await view.renderOnce();
      const focused = view.renderer.currentFocusedRenderable;
      expect(focused).not.toBeNull();
      if (!focused || focused.id === "dialog-close") continue;
      if (focused.id === "network-nick") {
        await view.mockInput.typeText("visible-nick");
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain("visible-nick");
      }
      expect(focused.y).toBeGreaterThanOrEqual(dialog.viewport.y);
      expect(focused.y + focused.height).toBeLessThanOrEqual(
        dialog.viewport.y + dialog.viewport.height,
      );
    }
    view.resize(50, 16);
    await view.renderOnce();
    await view.renderOnce();
    const focused = view.renderer.currentFocusedRenderable!;
    expect(focused.y).toBeGreaterThanOrEqual(dialog.viewport.y);
    expect(focused.y + focused.height).toBeLessThanOrEqual(
      dialog.viewport.y + dialog.viewport.height,
    );
  });
  test("modal dialogs block background sends, navigation, and focus", async () => {
    const { fake, view } = await mount();
    view.resize(110, 46);
    await view.renderOnce();
    await view.mockInput.typeText("keep this draft private");
    await view.mockInput.pressKey("F1");
    await tick();
    await view.renderOnce();
    await click(view, `conversation-${conversationId}`);
    await click(view, "older");
    expect(fake.actions.some((action) => action.type === "message.send")).toBe(false);
    expect(fake.timelines.get(conversationId)?.getSnapshot().draft).toBe("keep this draft private");
    expect(view.captureCharFrame()).toContain("Help");
    expect(view.renderer.currentFocusedRenderable?.id).toBe("dialog-close");
    await click(view, "dialog-close");
    await view.mockInput.pressEnter();
    await tick();
    expect(fake.actions.filter((action) => action.type === "message.send")).toHaveLength(1);
  });
  test("opening a modal and pressing Enter in the same input batch cannot send the composer", async () => {
    const { fake, view } = await mount();
    await view.mockInput.typeText("not a confirmation");
    await view.mockInput.pressKeys(["F1", "RETURN"]);
    await tick();
    await view.renderOnce();
    expect(fake.actions.some((action) => action.type === "message.send")).toBe(false);
    expect(fake.timelines.get(conversationId)?.getSnapshot().draft).toBe("not a confirmation");
    expect(view.captureCharFrame()).toContain("Help");
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
    expect(view.renderer.root.findDescendantById("directory-join-100")?.id).toBeUndefined();
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
  test("typing is opt-in/capability gated and stops after a paced dialog transition", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 4100));
    expect(fake.actions.filter((action) => action.type === "typing.set").at(-1)).toEqual({
      type: "typing.set",
      conversationId,
      active: false,
    });
  });
  test("typing does not advertise slash-command input", async () => {
    const { fake, view } = await mount();
    const document = fake.settings.getSnapshot()!;
    fake.settings.publish({ ...document, user: { ...document.user, sendTyping: true } });
    fake.state.publish({
      ...fake.state.getSnapshot(),
      networks: fake.state.getSnapshot().networks.map((network) => ({
        ...network,
        features: { ...network.features, typing: true },
      })),
    });
    await view.mockInput.typeText("/whois guide");
    expect(fake.actions.some((action) => action.type === "typing.set")).toBe(false);
  });
  test("removing an own server-backed message requires capability and explicit confirmation", async () => {
    const { fake, view } = await mount();
    const timeline = fake.timelines.get(conversationId)!;
    const own = { ...welcomeMessage, serverId: "server-own", sender: { nick: "newcomer" } };
    timeline.publish({ ...timeline.getSnapshot(), messages: [own] });
    await view.renderOnce();
    await click(view, "message-picker");
    await click(view, `pick-${own.id}`);
    expect(view.renderer.root.findDescendantById("redact-message")?.id).toBeUndefined();
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
    await click(view, "settings");
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
    expect(view.renderer.root.findDescendantById("message-large-0")?.id).toBeUndefined();
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
