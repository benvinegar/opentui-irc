import type { TuiSettings } from "../contracts/settings";

/** Stable nickname colors, not an assertion of verified person/account identity. */
export function nicknameColor(nick: string, theme: TuiSettings["theme"]): string {
  let hash = 2166136261;
  for (const character of nick.toLowerCase()) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  const value = hash >>> 0;
  const hue = (value % 360) / 60;
  const saturation = (65 + ((value >>> 9) % 16)) / 100;
  const lightness =
    (theme === "light" ? 20 : theme === "high-contrast" ? 75 : 70) / 100 +
    ((value >>> 17) % 5) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  const channels =
    hue < 1
      ? [chroma, second, 0]
      : hue < 2
        ? [second, chroma, 0]
        : hue < 3
          ? [0, chroma, second]
          : hue < 4
            ? [0, second, chroma]
            : hue < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return (
    "#" +
    channels
      .map((channel) =>
        Math.round((channel + offset) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Fixed across rows; reduce the gutter only when the conversation is narrow. */
export function transcriptGutterWidth(conversationWidth: number): number {
  return Math.max(8, Math.min(24, Math.floor(conversationWidth / 2)));
}
