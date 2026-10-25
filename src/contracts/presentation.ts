import type { Message } from "./model";

/** Name-based display match only, never proof of server/account identity. */
export function isHistServMessage(message: Pick<Message, "sender">): boolean {
  return message.sender.nick.toLowerCase() === "histserv";
}
