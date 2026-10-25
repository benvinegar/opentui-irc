import { describe, expect, it } from "vitest";
import {
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
});
