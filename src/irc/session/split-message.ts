import type { Result } from "../../contracts/common";
import { failure } from "./primitives";

export interface SplitMessage {
  readonly pieces: readonly string[];
  readonly emptyLines: number;
}
interface SplitOptions {
  readonly text: string;
  readonly target: string;
  readonly kind: "text" | "action" | "notice";
  readonly maxCommandBytes: number;
  readonly sourcePrefixBytes: number;
  readonly maxBytes: number;
  readonly maxFragments: number;
}
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Deliberate LF fallback, never command parsing. Empty lines get an explicit one-space wire body. */
export function splitMessage(options: SplitOptions): Result<SplitMessage> {
  if (!options.text || /[\r\0]/.test(options.text))
    return failure("invalid-input", "Messages must be nonempty and cannot contain CR or NUL.");
  if (options.text.length > options.maxBytes || bytes(options.text) > options.maxBytes)
    return failure("invalid-input", "Message exceeds the configured UTF-8 byte limit.");
  const command = options.kind === "notice" ? "NOTICE" : "PRIVMSG";
  const wrapBytes = options.kind === "action" ? 9 : 0;
  const budget =
    options.maxCommandBytes -
    options.sourcePrefixBytes -
    bytes(`${command} ${options.target} :\r\n`) -
    wrapBytes;
  if (budget < 1) return failure("invalid-input", "Message target leaves no room for content.");
  const pieces: string[] = [];
  let emptyLines = 0;
  for (const original of options.text.split("\n")) {
    // IRC ERR_NOTEXTTOSEND makes an empty trailing param unreliable. A space is visible as a blank line.
    const line = original === "" ? " " : original;
    if (!original) emptyLines++;
    let piece = "";
    let length = 0;
    for (const point of line) {
      const size = bytes(point);
      if (size > budget)
        return failure("invalid-input", "Message target leaves no room for a UTF-8 character.");
      if (length + size > budget) {
        pieces.push(piece);
        if (pieces.length >= options.maxFragments)
          return failure("invalid-input", "Message exceeds the configured fragment limit.");
        piece = "";
        length = 0;
      }
      piece += point;
      length += size;
    }
    pieces.push(piece);
    if (pieces.length > options.maxFragments)
      return failure("invalid-input", "Message exceeds the configured fragment limit.");
  }
  return { ok: true, value: { pieces, emptyLines } };
}
