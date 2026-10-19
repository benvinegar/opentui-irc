import { expect, it } from "vitest";
import type { AppAction } from "../../src/contracts/app";
import { entityId } from "../../src/contracts/common";
import type { NetworkId } from "../../src/contracts/common";

it("keeps entity namespaces distinct at compile time", () => {
  const network = entityId<"network">("network-1");
  const conversation = entityId<"conversation">("conversation-1");
  // @ts-expect-error Conversation IDs cannot be used as network IDs.
  const invalid: NetworkId = conversation;
  void invalid;
  const action: AppAction = { type: "network.connect", networkId: network };
  expect(action.networkId).toBe(network);
  expect(() => entityId<"network">("bad\nvalue")).toThrow();
});
