import type { Result } from "../../contracts/common";
import type { IrcCodec, IrcFrame, ProtocolLimits } from "../../contracts/protocol";

const encoder = new TextEncoder();
const fail = <T>(message: string): Result<T> => ({
  ok: false,
  error: { code: "invalid-input", message, retryable: false },
});
const validKey = (key: string) => /^\+?(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+$/.test(key);
const unsafe = (text: string) => /[\r\n\0]/.test(text);
const escapeTag = (text: string) =>
  text.replace(
    /[; \\\r\n]/g,
    (c) => ({ ";": "\\:", " ": "\\s", "\\": "\\\\", "\r": "\\r", "\n": "\\n" })[c]!,
  );
function unescapeTag(text: string): string {
  return text.replace(
    /\\(.|$)/g,
    (_, c: string) => ({ ":": ";", s: " ", r: "\r", n: "\n", "\\": "\\" })[c] ?? c,
  );
}

/** A parsed line section plus the position just after it. */
type Section<T> = Result<{ readonly value: T; readonly position: number }>;
const skipSpaces = (line: string, position: number) => {
  while (line[position] === " ") position++;
  return position;
};

function parseTags(line: string): Section<Record<string, string | null>> {
  const tags: Record<string, string | null> = Object.create(null);
  if (!line.startsWith("@")) return { ok: true, value: { value: tags, position: 0 } };
  const end = line.indexOf(" ");
  if (end < 2) return fail("Malformed IRC tags.");
  for (const item of line.slice(1, end).split(";")) {
    const equals = item.indexOf("=");
    const key = equals < 0 ? item : item.slice(0, equals);
    if (!validKey(key)) return fail("Malformed IRC tags.");
    tags[key] = equals < 0 ? null : unescapeTag(item.slice(equals + 1));
  }
  return { ok: true, value: { value: tags, position: end + 1 } };
}

function parsePrefix(line: string, start: number): Section<string | undefined> {
  const position = skipSpaces(line, start);
  if (line[position] !== ":") return { ok: true, value: { value: undefined, position } };
  const end = line.indexOf(" ", position);
  if (end <= position + 1) return fail("Malformed IRC prefix.");
  const prefix = line.slice(position + 1, end);
  return { ok: true, value: { value: prefix, position: skipSpaces(line, end + 1) } };
}

function parseParams(line: string, start: number): Result<string[]> {
  const params: string[] = [];
  let position = start;
  while (position < line.length) {
    if (line[position] === " ") {
      position++;
      continue;
    }
    if (params.length === 15) return fail("Too many IRC parameters.");
    if (line[position] === ":") {
      params.push(line.slice(position + 1));
      break;
    }
    const end = line.indexOf(" ", position);
    params.push(line.slice(position, end < 0 ? undefined : end));
    position = end < 0 ? line.length : end + 1;
  }
  return { ok: true, value: params };
}

function parseLine(bytes: Uint8Array): Result<IrcFrame> {
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Invalid IRC UTF-8 input.");
  }
  if (unsafe(line)) return fail("Malformed IRC input.");
  const tags = parseTags(line);
  if (!tags.ok) return tags;
  const prefix = parsePrefix(line, tags.value.position);
  if (!prefix.ok) return prefix;
  const position = prefix.value.position;
  const commandEnd = line.indexOf(" ", position);
  const command = line.slice(position, commandEnd < 0 ? undefined : commandEnd).toUpperCase();
  if (!/^(?:[A-Z]+|[0-9]{3})$/.test(command)) return fail("Malformed IRC command.");
  const params = parseParams(line, commandEnd < 0 ? line.length : commandEnd + 1);
  if (!params.ok) return params;
  return {
    ok: true,
    value: {
      tags: tags.value.value,
      ...(prefix.value.value === undefined ? {} : { prefix: prefix.value.value }),
      command,
      params: params.value,
    },
  };
}

function encodeTags(tags: IrcFrame["tags"]): Result<string> {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    if (!validKey(key) || (value !== null && unsafe(value))) return fail("Invalid IRC tag.");
    parts.push(value === null ? key : `${key}=${escapeTag(value)}`);
  }
  return { ok: true, value: parts.length ? `@${parts.join(";")} ` : "" };
}

/** Space-led parameter list; only the final parameter may use the trailing `:` form. */
function encodeParams(params: IrcFrame["params"]): Result<string> {
  let encoded = "";
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (unsafe(param)) return fail("Invalid IRC parameter.");
    const trailing = param === "" || param.startsWith(":") || param.includes(" ");
    if (trailing && i !== params.length - 1) return fail("Invalid IRC parameter order.");
    encoded += ` ${trailing ? ":" : ""}${param}`;
  }
  return { ok: true, value: encoded };
}

/** Limits are configuration invariants; malformed wire input is instead a safe Result error. */
export function createIrcCodec(limits: ProtocolLimits): IrcCodec {
  if (
    !Number.isSafeInteger(limits.maxCommandBytes) ||
    limits.maxCommandBytes < 64 ||
    !Number.isSafeInteger(limits.maxTagBytes) ||
    limits.maxTagBytes < 0 ||
    !Number.isSafeInteger(limits.maxBufferedBytes) ||
    limits.maxBufferedBytes < limits.maxCommandBytes ||
    limits.maxBufferedBytes > 16 * 1024 * 1024
  )
    throw new TypeError("Invalid IRC protocol limits");
  const pending = new Uint8Array(limits.maxBufferedBytes);
  let length = 0;
  let dead = false;
  let tagEnd = -1;
  const reject = <T>(): Result<T> => {
    dead = true;
    length = 0;
    return fail("Malformed or oversized IRC input.");
  };
  /** Buffer overflow, NUL, bare LF and CR without LF are fatal framing errors. */
  const framed = (byte: number) =>
    length < pending.length &&
    byte !== 0 &&
    (byte !== 10 || pending[length - 1] === 13) &&
    (length === 0 || pending[length - 1] !== 13 || byte === 10);
  /** Buffers one byte; tags and the command each have their own byte budget. */
  function accept(byte: number): boolean {
    if (!framed(byte)) return false;
    pending[length++] = byte;
    if (pending[0] !== 64) return length <= limits.maxCommandBytes;
    if (tagEnd < 0 && byte === 32) tagEnd = length;
    if (tagEnd < 0) return length <= limits.maxTagBytes;
    return tagEnd <= limits.maxTagBytes && length - tagEnd <= limits.maxCommandBytes;
  }
  return {
    push(chunk) {
      if (dead) return fail("IRC codec is closed.");
      const frames: IrcFrame[] = [];
      for (const byte of chunk) {
        if (!accept(byte)) return reject();
        if (byte !== 10) continue;
        if (pending[0] === 64 && tagEnd < 0) return reject();
        const result = parseLine(pending.subarray(0, length - 2));
        if (!result.ok) {
          dead = true;
          length = 0;
          return result;
        }
        frames.push(result.value);
        length = 0;
        tagEnd = -1;
      }
      return { ok: true, value: frames };
    },
    finish() {
      const incomplete = length > 0;
      dead = true;
      length = 0;
      return incomplete
        ? fail("Incomplete IRC input at end of connection.")
        : { ok: true, value: undefined };
    },
    encode(frame) {
      if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(frame.command) || frame.params.length > 15)
        return fail("Invalid IRC command.");
      if (frame.prefix !== undefined && (!frame.prefix || /[\s\0]/.test(frame.prefix)))
        return fail("Invalid IRC prefix.");
      const tags = encodeTags(frame.tags);
      if (!tags.ok) return tags;
      const params = encodeParams(frame.params);
      if (!params.ok) return params;
      const prefix = frame.prefix === undefined ? "" : `:${frame.prefix} `;
      const command = `${prefix}${frame.command.toUpperCase()}${params.value}\r\n`;
      const tagBytes = encoder.encode(tags.value).length;
      const commandBytes = encoder.encode(command).length;
      if (
        tagBytes > limits.maxTagBytes ||
        commandBytes > limits.maxCommandBytes ||
        tagBytes + commandBytes > limits.maxBufferedBytes
      )
        return fail("IRC output exceeds byte limit.");
      return { ok: true, value: encoder.encode(tags.value + command) };
    },
  };
}
