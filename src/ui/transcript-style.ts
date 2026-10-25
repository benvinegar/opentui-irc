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
export function transcriptGutterWidth(conversationWidth: number, longestNick = Infinity): number {
  // Time (5) + space + nick + spacing; no wider than the longest visible nickname needs.
  return Math.max(
    8,
    Math.min(24, Math.floor(conversationWidth / 2), Math.max(12, longestNick + 7)),
  );
}

const GROUP_WINDOW = 5 * 60_000;

/** Consecutive chat lines by one sender within a few minutes read as one block. */
export function continuesGroup(
  previous: { sender: { nick: string }; kind: string; at: number } | undefined,
  current: { sender: { nick: string }; kind: string; at: number },
): boolean {
  return (
    !!previous &&
    (previous.kind === "event") === (current.kind === "event") &&
    previous.sender.nick === current.sender.nick &&
    current.at - previous.at >= 0 &&
    current.at - previous.at < GROUP_WINDOW &&
    dayKey(previous.at) === dayKey(current.at)
  );
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatDay(timestamp: number, now = Date.now()): string {
  const key = dayKey(timestamp);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
