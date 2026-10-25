import { testRender } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import { OpenIrc } from "../../src/ui/app";
import { createCommandService } from "../../src/services/commands";
import { createExternalActions } from "../../src/services/effects";
import { createFakeApp } from "../fakes/app";
import { conversationId, welcomeMessage } from "../fixtures/scenario";
import { entityId } from "../../src/contracts/common";

// Explicit fake headless preview, not the production startup or a real IRC session.
const fake = createFakeApp();
const document = fake.settings.getSnapshot()!;
fake.settings.publish({ ...document, tui: { ...document.tui, density: "compact" } });
const timeline = fake.timelines.get(conversationId)!;
const names = ["joey", "robert", "alice", "長い名前👩‍💻", "kai"];
const samples = [
  "Synthetic preview: time and nickname on the left; conversation on the right.",
  "A longer synthetic message wraps entirely inside the message column. Continuation lines stay aligned with the text, not the timestamp or nickname, while the divider remains fixed.",
  "Different nicknames get consistent, theme-aware colors.",
  "Unicode fixture: 你好 é 👩‍💻 🇯🇵",
  "Click a message to open its existing actions.",
];
timeline.publish({
  ...timeline.getSnapshot(),
  messages: Array.from({ length: 18 }, (_, index) => ({
    ...welcomeMessage,
    id: entityId<"message">(`preview-${index}`),
    sender: { nick: names[index % names.length]! },
    receivedAt: welcomeMessage.receivedAt + index * 60_000,
    text: samples[index % samples.length]!,
    ...(index === 16 ? { sendState: "uncertain" as const } : {}),
  })),
});
const view = await testRender(
  () => (
    <OpenIrc
      app={fake.app}
      commands={createCommandService(fake.app)}
      external={createExternalActions({ run: async () => ({ ok: true, value: undefined }) })}
    />
  ),
  { width: 110, height: 36 },
);
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rgb = (color: RGBA) => `rgb(${color.toInts().slice(0, 3).join(",")})`;
async function capture(name: string) {
  await view.renderOnce();
  const frame = view.captureSpans();
  const elements = frame.lines
    .flatMap((line, row) => {
      let x = 0;
      return line.spans.map((span) => {
        const left = x * 10;
        x += span.width;
        return `<rect x="${left}" y="${row * 20}" width="${span.width * 10}" height="20" fill="${rgb(span.bg)}"/><text x="${left}" y="${row * 20 + 15}" fill="${rgb(span.fg)}"${span.attributes & 1 ? ' font-weight="bold"' : ""}>${escape(span.text)}</text>`;
      });
    })
    .join("");
  await Bun.write(
    `/tmp/openirc-${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720"><g font-family="JetBrains Mono,monospace" font-size="16" xml:space="preserve">${elements}</g></svg>`,
  );
  await Bun.write(`/tmp/openirc-${name}.txt`, view.captureCharFrame());
}
try {
  await capture("chat");
  const button = view.renderer.root.findDescendantById("settings")!;
  await view.mockMouse.click(button.x + 1, button.y);
  await capture("settings");
} finally {
  await view.dispose();
}
