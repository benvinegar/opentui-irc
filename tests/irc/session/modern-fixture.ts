/** Unit-level ModernSession fixture with a controllable clock and captured events/writes. */
import { entityId } from "../../../src/contracts/common";
import type { AppError } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionPayload } from "../../../src/contracts/session";
import { ModernSession, modernPolicyDefaults } from "../../../src/irc/session/modern";
export const op = (id: string) => entityId<"operation">(id);
export const frame = (
  command: string,
  params: readonly string[] = [],
  tags: Record<string, string | null> = {},
): IrcFrame => ({ command, params, tags });
export const allCaps = [
  "message-tags",
  "server-time",
  "batch",
  "labeled-response",
  "echo-message",
  "draft/chathistory",
  "draft/read-marker",
  "draft/message-redaction",
];
export function fixture(caps = allCaps, policy = {}) {
  const events: SessionPayload[] = [];
  const errors: AppError[] = [];
  const writes: IrcFrame[] = [];
  const capabilities = new Map<string, string | null>(caps.map((cap) => [cap, null]));
  let now = 100_000;
  let changed = 0;
  const modern = new ModernSession({
    policy: { ...modernPolicyDefaults, queryTimeoutMs: 1000, ...policy },
    now: () => now,
    capabilities: () => capabilities,
    self: (nick) => nick === "me",
    fold: (value) => value.toLowerCase(),
    emit: (event) => events.push(event),
    changed: () => {
      changed++;
    },
    fatal: (error) => errors.push(error),
  });
  return {
    modern,
    events,
    errors,
    writes,
    capabilities,
    changed: () => changed,
    time: (value: number) => {
      now = value;
    },
    write: async (frame: IrcFrame) => {
      writes.push(frame);
      return { ok: true as const, value: undefined };
    },
  };
}
