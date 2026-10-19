import { describe, expect, test } from "vitest";
import { createIrcCodec } from "../../../src/irc/codec";
import type { IrcFrame } from "../../../src/contracts/protocol";

const limits = { maxCommandBytes: 512, maxTagBytes: 8192, maxBufferedBytes: 16384 };
const bytes = (text: string) => new TextEncoder().encode(text);
describe("IRC codec", () => {
  test("CRLF and multibyte UTF-8 at every byte boundary", () => {
    const input = bytes(
      "@a=hello\\sworld;x=semi\\:colon;y=\\\\;z;empty= :n!u@h PRIVMSG #room :hi 🐈\r\n:s 001 n :welcome\r\n",
    );
    for (let split = 0; split <= input.length; split++) {
      const codec = createIrcCodec(limits);
      const first = codec.push(input.slice(0, split));
      const second = codec.push(input.slice(split));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) continue;
      const frames = [...first.value, ...second.value];
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({
        tags: { a: "hello world", x: "semi;colon", y: "\\", z: null, empty: "" },
        prefix: "n!u@h",
        command: "PRIVMSG",
        params: ["#room", "hi 🐈"],
      });
      expect(frames[1]?.command).toBe("001");
      expect(codec.finish().ok).toBe(true);
    }
  });
  test("one-byte chunks and trailing empty parameter", () => {
    const codec = createIrcCodec(limits);
    const frames: IrcFrame[] = [];
    for (const byte of bytes(":nick TOPIC #a :\r\n")) {
      const result = codec.push(new Uint8Array([byte]));
      expect(result.ok).toBe(true);
      if (result.ok) frames.push(...result.value);
    }
    expect(frames[0]?.params).toEqual(["#a", ""]);
  });
  test("unknown commands, escapes and numerics are preserved", () => {
    const result = createIrcCodec(limits).push(
      bytes("@unknown=abc\\q\\ FROB :\r\n:s 799 n :text\r\n"),
    );
    expect(result.ok && result.value[0]?.tags.unknown).toBe("abcq");
    expect(result.ok && result.value[1]?.command).toBe("799");
  });
  test.each([
    "PING x\n",
    "PING x\rZ",
    "PING \0\r\n",
    "@bad_key=v PING x\r\n",
    ": PING x\r\n",
    "1234 x\r\n",
    `CMD ${Array(16).fill("x").join(" ")}\r\n`,
  ])("rejects malformed input safely", (input) => {
    const codec = createIrcCodec(limits);
    const result = codec.push(bytes(input));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(input);
    expect(codec.push(bytes("PING x\r\n")).ok).toBe(false);
  });
  test("invalid UTF-8, unfinished input and bounded pending bytes", () => {
    expect(createIrcCodec(limits).push(new Uint8Array([80, 32, 255, 13, 10])).ok).toBe(false);
    const codec = createIrcCodec(limits);
    expect(codec.push(bytes("PING x\r")).ok).toBe(true);
    expect(codec.finish().ok).toBe(false);
    expect(createIrcCodec(limits).push(bytes("@x=" + "a".repeat(17000))).ok).toBe(false);
    expect(createIrcCodec(limits).push(bytes("CMD :" + "a".repeat(512))).ok).toBe(false);
  });
  test("many complete frames may exceed pending budget in aggregate", () => {
    const result = createIrcCodec(limits).push(bytes("PING x\r\n".repeat(5000)));
    expect(result.ok && result.value.length).toBe(5000);
  });
  test("separate exact command/tag budgets, serialization and injection rejection", () => {
    const codec = createIrcCodec({ maxCommandBytes: 64, maxTagBytes: 16, maxBufferedBytes: 80 });
    const original: IrcFrame = {
      tags: { a: "hi there" },
      command: "PRIVMSG",
      params: ["#a", "🐈 : hello"],
    };
    const encoded = codec.encode(original);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) expect(codec.push(encoded.value)).toEqual({ ok: true, value: [original] });
    expect(codec.encode({ tags: {}, command: "PING", params: ["a".repeat(57)] }).ok).toBe(true);
    expect(codec.encode({ tags: {}, command: "PING", params: ["a".repeat(58)] }).ok).toBe(false);
    expect(codec.encode({ tags: { a: "a".repeat(13) }, command: "PING", params: [] }).ok).toBe(
      false,
    );
    for (const bad of ["\r", "\n", "\0"]) {
      expect(
        codec.encode({ tags: {}, command: "PRIVMSG", params: ["#a", `secret${bad}QUIT`] }).ok,
      ).toBe(false);
      expect(codec.encode({ tags: { a: `x${bad}` }, command: "PING", params: [] }).ok).toBe(false);
    }
  });
});
