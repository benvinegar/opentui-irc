import { describe, expect, it } from "vitest";
import { mergeWindow, mentionsNick, plainText } from "../../src/domain/message-policy";
import { entityId } from "../../src/contracts/common";
import { welcomeMessage } from "../fixtures/scenario";

describe("message policy", () => {
  it("strips terminal commands and IRC formatting", () => {
    expect(
      plainText("\u001b]52;c;attack\u0007\u001b[31mhello\u001b[0m\u000304,05world\u0002!\u0000"),
    ).toBe("helloworld!");
  });
  it("finds IRC-casemapped mentions with nickname boundaries", () => {
    expect(mentionsNick("hello NICK{, welcome", "Nick[", "rfc1459")).toBe(true);
    expect(mentionsNick("nicknames nick_other", "nick", "rfc1459")).toBe(false);
    expect(mentionsNick("Hi nick!", "nick", "ascii")).toBe(true);
  });
  it("merges by identity instead of body and bounds windows", () => {
    const second = {
      ...welcomeMessage,
      id: entityId<"message">("second"),
      receivedAt: welcomeMessage.receivedAt + 1,
    };
    expect(mergeWindow([welcomeMessage], [second], 10)).toHaveLength(2);
    expect(
      mergeWindow([welcomeMessage], [{ ...welcomeMessage, text: "enriched" }], 10),
    ).toHaveLength(1);
    expect(mergeWindow([welcomeMessage], [second], 1)).toEqual([second]);
  });
});
