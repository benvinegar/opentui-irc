import { describe, expect, it } from "vitest";
import { isHistServMessage } from "../../src/contracts/presentation";

describe("HistServ presentation match", () => {
  it("matches the complete nickname case-insensitively", () => {
    for (const nick of ["HistServ", "histserv", "HISTSERV", "hIsTsErV"])
      expect(isHistServMessage({ sender: { nick } })).toBe(true);
  });
  it("does not match text, similar names, ordinary users or local errors", () => {
    for (const nick of ["joey", "robert", "opentui-irc", "HistServBot", "not-HistServ"])
      expect(isHistServMessage({ sender: { nick } })).toBe(false);
  });
});
