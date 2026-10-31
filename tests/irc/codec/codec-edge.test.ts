import { describe, expect, test } from "vitest";
import { createIrcCodec } from "../../../src/irc/codec";

const limits = { maxCommandBytes: 512, maxTagBytes: 8192, maxBufferedBytes: 16384 };

describe("IRC codec configuration and encoding edges", () => {
  test("rejects invalid protocol limits as configuration errors", () => {
    for (const invalid of [
      { ...limits, maxCommandBytes: 63 },
      { ...limits, maxCommandBytes: 512.5 },
      { ...limits, maxTagBytes: -1 },
      { ...limits, maxBufferedBytes: 511 },
      { ...limits, maxBufferedBytes: 16 * 1024 * 1024 + 1 },
    ])
      expect(() => createIrcCodec(invalid)).toThrow(TypeError);
  });
  test("refuses to encode empty or whitespace prefixes", () => {
    const codec = createIrcCodec(limits);
    for (const prefix of ["", "server name", "nick\0"])
      expect(codec.encode({ tags: {}, prefix, command: "PING", params: ["x"] }).ok).toBe(false);
    const valid = codec.encode({ tags: {}, prefix: "server", command: "ping", params: ["x"] });
    expect(valid.ok && new TextDecoder().decode(valid.value)).toBe(":server PING x\r\n");
  });
  test("refuses to encode invalid tag keys or values with line breaks", () => {
    const codec = createIrcCodec(limits);
    for (const tags of [{ "bad key": "x" }, { label: "a\r\nQUIT" }, { "": null }])
      expect(codec.encode({ tags, command: "PING", params: ["x"] }).ok).toBe(false);
  });
});
