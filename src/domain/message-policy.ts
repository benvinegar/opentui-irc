/* eslint-disable no-control-regex -- Strip untrusted IRC and terminal control bytes. */
import type { Message } from "../contracts/model";
import type { ProtocolSupport } from "../contracts/protocol";
import { foldIdentifier } from "./irc-identifiers";

/** Defense in depth at the domain boundary; never render remote terminal escape sequences. */
export function plainText(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strip untrusted terminal control sequences.
  return (
    value
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/gu, "")
      // eslint-disable-next-line no-control-regex -- CSI terminal escapes.
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/gu, "")
      // eslint-disable-next-line no-control-regex -- IRC color prefixes, including decimal arguments.
      .replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/gu, "")
      // eslint-disable-next-line no-control-regex -- Allow only TAB/LF among control characters.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")
  );
}

export function mentionsNick(
  text: string,
  nick: string,
  mapping: ProtocolSupport["casemapping"],
): boolean {
  if (!nick) return false;
  const haystack = foldIdentifier(text, mapping);
  const needle = foldIdentifier(nick, mapping);
  const isNick = (character: string | undefined) =>
    character !== undefined && /[\p{L}\p{N}_\-`^{}[\]\\|~]/u.test(character);
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    if (!isNick(haystack[offset - 1]) && !isNick(haystack[offset + needle.length])) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

/** Unicode scalar order matches SQLite's UTF-8 BINARY collation, independent of locale. */
export function compareMessageIds(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
function compareMessages(left: Message, right: Message): number {
  return (
    (left.serverTime ?? left.receivedAt) - (right.serverTime ?? right.receivedAt) ||
    compareMessageIds(left.id, right.id)
  );
}

/** IDs are stable on enrichment. Same-text messages without a shared ID remain distinct. */
export function mergeWindow(
  current: readonly Message[],
  incoming: readonly Message[],
  limit: number,
): readonly Message[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort(compareMessages).slice(-limit);
}
