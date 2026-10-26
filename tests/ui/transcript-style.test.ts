import { describe, expect, it } from "vitest";
import {
  continuesGroup,
  ellipsize,
  formatDay,
  formatMessageTime,
  nicknameColor,
  transcriptGutterWidth,
} from "../../src/ui/transcript-style";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

describe("compact transcript styling", () => {
  it("keeps nickname colors stable, case-insensitive and distinct for sample participants", () => {
    for (const theme of ["dark", "light", "high-contrast"] as const) {
      const participants = ["joey", "robert", "guide", "alice", "bob", "charlie"];
      expect(new Set(participants.map((nick) => nicknameColor(nick, theme))).size).toBe(
        participants.length,
      );
      expect(nicknameColor("Joey", theme)).toBe(nicknameColor("joey", theme));
      expect(nicknameColor("joey", theme)).toBe(nicknameColor("joey", theme));
    }
  });
  it.each([
    ["dark", "#161821"],
    ["light", "#f4f5fa"],
    ["high-contrast", "#000000"],
  ] as const)("keeps %s nickname colors readable against the transcript", (theme, background) => {
    const bg = luminance(background);
    for (let index = 0; index < 256; index++) {
      const fg = luminance(nicknameColor(`participant-${index}`, theme));
      expect((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses a compact local 24-hour timestamp", () => {
    expect(formatMessageTime(new Date(2026, 0, 1, 3, 7).getTime())).toBe("03:07");
    expect(formatMessageTime(new Date(2026, 0, 1, 23, 59).getTime())).toBe("23:59");
  });
  it("keeps the gutter fixed on regular windows and reduces it on narrow ones", () => {
    expect(transcriptGutterWidth(150)).toBe(24);
    expect(transcriptGutterWidth(80)).toBe(24);
    expect(transcriptGutterWidth(32)).toBe(16);
    expect(transcriptGutterWidth(12)).toBe(8);
  });
  it("sizes the gutter to the longest visible nickname without exceeding the cap", () => {
    expect(transcriptGutterWidth(150, 5)).toBe(12);
    expect(transcriptGutterWidth(150, 10)).toBe(17);
    expect(transcriptGutterWidth(150, 40)).toBe(24);
    expect(transcriptGutterWidth(20, 10)).toBe(10);
  });
  it("groups consecutive lines by one sender within a few minutes on the same day", () => {
    const at = new Date(2026, 0, 1, 12, 0).getTime();
    const line = (nick: string, offset: number, kind = "text") => ({
      sender: { nick },
      kind,
      at: at + offset,
    });
    expect(continuesGroup(undefined, line("joey", 0))).toBe(false);
    expect(continuesGroup(line("joey", 0), line("joey", 60_000))).toBe(true);
    expect(continuesGroup(line("joey", 0), line("alice", 60_000))).toBe(false);
    expect(continuesGroup(line("joey", 0), line("joey", 6 * 60_000))).toBe(false);
    expect(continuesGroup(line("joey", 0), line("joey", 60_000, "event"))).toBe(false);
    expect(continuesGroup(line("OpenIRC", 0, "event"), line("OpenIRC", 1, "event"))).toBe(true);
    const lateNight = new Date(2026, 0, 1, 23, 59).getTime();
    expect(
      continuesGroup(
        { sender: { nick: "joey" }, kind: "text", at: lateNight },
        { sender: { nick: "joey" }, kind: "text", at: lateNight + 120_000 },
      ),
    ).toBe(false);
  });
  it("labels today and yesterday by name", () => {
    const now = new Date(2026, 4, 10, 15).getTime();
    expect(formatDay(now - 3_600_000, now)).toBe("Today");
    expect(formatDay(now - 86_400_000, now)).toBe("Yesterday");
    expect(formatDay(now - 5 * 86_400_000, now)).not.toBe("Yesterday");
  });
  it("end-truncates with a single-cell ellipsis at grapheme boundaries", () => {
    expect(ellipsize("robert", 10)).toBe("robert");
    expect(ellipsize("robert", 6)).toBe("robert");
    expect(ellipsize("Synthetic Lab", 8)).toBe("Synthet…");
    expect(ellipsize("one two three", 5)).toBe("one…");
    const cells = (value: string) => value.replace(/\p{M}/gu, "").length;
    expect(ellipsize("e\u0301e\u0301e\u0301", 2, cells)).toBe("e\u0301…");
    expect(ellipsize("abc", 1)).toBe("…");
    expect(ellipsize("abc", 0)).toBe("");
  });
});
