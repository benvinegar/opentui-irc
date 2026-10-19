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
  function parse(bytes: Uint8Array): Result<IrcFrame> {
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("Invalid IRC UTF-8 input.");
    }
    if (unsafe(line)) return fail("Malformed IRC input.");
    const tags: Record<string, string | null> = Object.create(null);
    let position = 0;
    if (line.startsWith("@")) {
      const end = line.indexOf(" ");
      if (end < 2) return fail("Malformed IRC tags.");
      for (const item of line.slice(1, end).split(";")) {
        const equals = item.indexOf("=");
        const key = equals < 0 ? item : item.slice(0, equals);
        if (!validKey(key)) return fail("Malformed IRC tags.");
        tags[key] = equals < 0 ? null : unescapeTag(item.slice(equals + 1));
      }
      position = end + 1;
    }
    while (line[position] === " ") position++;
    let prefix: string | undefined;
    if (line[position] === ":") {
      const end = line.indexOf(" ", position);
      if (end <= position + 1) return fail("Malformed IRC prefix.");
      prefix = line.slice(position + 1, end);
      position = end + 1;
      while (line[position] === " ") position++;
    }
    const commandEnd = line.indexOf(" ", position);
    const command = line.slice(position, commandEnd < 0 ? undefined : commandEnd).toUpperCase();
    if (!/^(?:[A-Z]+|[0-9]{3})$/.test(command)) return fail("Malformed IRC command.");
    position = commandEnd < 0 ? line.length : commandEnd + 1;
    const params: string[] = [];
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
    return {
      ok: true,
      value: { tags, ...(prefix === undefined ? {} : { prefix }), command, params },
    };
  }
  return {
    push(chunk) {
      if (dead) return fail("IRC codec is closed.");
      const frames: IrcFrame[] = [];
      for (const byte of chunk) {
        if (
          length >= pending.length ||
          byte === 0 ||
          (byte === 10 && pending[length - 1] !== 13) ||
          (length > 0 && pending[length - 1] === 13 && byte !== 10)
        )
          return reject();
        pending[length++] = byte;
        const tagged = pending[0] === 64;
        if (tagged && tagEnd < 0 && byte === 32) tagEnd = length;
        if (tagged && tagEnd < 0 && length > limits.maxTagBytes) return reject();
        if (
          tagEnd > limits.maxTagBytes ||
          (length - (tagged ? Math.max(0, tagEnd) : 0) > limits.maxCommandBytes &&
            (!tagged || tagEnd >= 0))
        )
          return reject();
        if (byte === 10) {
          if (tagged && tagEnd < 0) return reject();
          const result = parse(pending.subarray(0, length - 2));
          if (!result.ok) {
            dead = true;
            length = 0;
            return result;
          }
          frames.push(result.value);
          length = 0;
          tagEnd = -1;
        }
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
      const tagParts: string[] = [];
      for (const [key, value] of Object.entries(frame.tags)) {
        if (!validKey(key) || (value !== null && unsafe(value))) return fail("Invalid IRC tag.");
        tagParts.push(value === null ? key : `${key}=${escapeTag(value)}`);
      }
      const tags = tagParts.length ? `@${tagParts.join(";")} ` : "";
      let command = `${frame.prefix === undefined ? "" : `:${frame.prefix} `}${frame.command.toUpperCase()}`;
      for (let i = 0; i < frame.params.length; i++) {
        const param = frame.params[i]!;
        if (unsafe(param)) return fail("Invalid IRC parameter.");
        const trailing = param === "" || param.startsWith(":") || param.includes(" ");
        if (trailing && i !== frame.params.length - 1) return fail("Invalid IRC parameter order.");
        command += ` ${trailing ? ":" : ""}${param}`;
      }
      command += "\r\n";
      if (
        encoder.encode(tags).length > limits.maxTagBytes ||
        encoder.encode(command).length > limits.maxCommandBytes ||
        encoder.encode(tags).length + encoder.encode(command).length > limits.maxBufferedBytes
      )
        return fail("IRC output exceeds byte limit.");
      return { ok: true, value: encoder.encode(tags + command) };
    },
  };
}
