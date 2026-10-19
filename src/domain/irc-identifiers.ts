import type { ProtocolSupport } from "../contracts/protocol";

/** IRC identifiers use negotiated ASCII folding, not locale/Unicode lowercasing. */
export function foldIdentifier(value: string, mapping: ProtocolSupport["casemapping"]): string {
  return value.replace(/[A-Z[\]\\^]/gu, (character) => {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    if (mapping === "ascii") return character;
    if (character === "[") return "{";
    if (character === "]") return "}";
    if (character === "\\") return "|";
    return mapping === "rfc1459" ? "~" : character;
  });
}
