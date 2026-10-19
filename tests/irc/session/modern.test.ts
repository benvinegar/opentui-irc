import { describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { AppError } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionPayload } from "../../../src/contracts/session";
import {
  ModernSession,
  modernCapabilities,
  modernPolicyDefaults,
  validServerId,
} from "../../../src/irc/session/modern";
const op = (id: string) => entityId<"operation">(id);
const frame = (
  command: string,
  params: readonly string[] = [],
  tags: Record<string, string | null> = {},
): IrcFrame => ({ command, params, tags });
const allCaps = [
  "message-tags",
  "server-time",
  "batch",
  "labeled-response",
  "echo-message",
  "draft/chathistory",
  "draft/read-marker",
  "draft/message-redaction",
];
function fixture(caps = allCaps, policy = {}) {
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
describe("pinned modern IRCv3 state", () => {
  test("exact draft names, dependency-derived feature flags, observed IDs and CLIENTTAGDENY", () => {
    expect(modernCapabilities(new Map(allCaps.map((cap) => [cap, null])))).toEqual([
      "batch",
      "draft/chathistory",
      "draft/message-redaction",
      "draft/read-marker",
    ]);
    const f = fixture();
    expect(f.modern.features()).toEqual({
      history: true,
      replies: false,
      reactions: false,
      typing: true,
      readMarkers: true,
      redaction: true,
      multiline: false,
    });
    f.modern.observeChat(frame("PRIVMSG", ["#room", "x"], { msgid: "real-id" }), "alice", "#room");
    expect(f.modern.features().replies).toBe(true);
    expect(f.modern.features().reactions).toBe(true);
    expect(f.changed()).toBe(1);
    f.modern.isupport(["CLIENTTAGDENY=*,-typing"]);
    expect(f.modern.features()).toMatchObject({ replies: false, reactions: false, typing: true });
    f.modern.isupport(["CLIENTTAGDENY=typing,draft/unreact"]);
    expect(f.modern.features()).toMatchObject({ replies: true, reactions: false, typing: false });
    f.capabilities.delete("server-time");
    expect(f.modern.features()).toMatchObject({ history: false, readMarkers: false });
    expect(
      fixture([
        "message-tags",
        "chathistory",
        "read-marker",
        "message-redaction",
      ]).modern.features(),
    ).toMatchObject({ history: false, readMarkers: false, redaction: false });
  });
  test("validates opaque IDs without normalization or collisions", () => {
    expect(validServerId("Case:Sensitive,ID")).toBe(true);
    for (const id of ["", ":leading", "bad id", "bad\nline", "bad\x1bID"])
      expect(validServerId(id)).toBe(false);
  });
  test("nested labeled history, latest/before selectors, exhaustion and live/playback interleaving", async () => {
    const f = fixture();
    const command = { type: "history" as const, target: "#room", limit: 10 };
    expect(f.modern.admit(command, op("history")).ok).toBe(true);
    expect(f.modern.admit(command, op("overlap")).ok).toBe(false);
    await f.modern.perform(command, op("history"), f.write);
    expect(f.writes[0]?.params).toEqual(["LATEST", "#room", "*", "10"]);
    const label = f.writes[0]!.tags.label!;
    f.modern.handle(frame("BATCH", ["+outer", "labeled-response"], { label }), "s");
    f.modern.handle(
      frame("BATCH", ["+page", "chathistory", "#ROOM"], {
        batch: "outer",
        "draft/chathistory-end": null,
      }),
      "s",
    );
    const old = frame("PRIVMSG", ["#room", "old"], { batch: "page", msgid: "old-id" });
    const live = frame("PRIVMSG", ["#room", "live"], { msgid: "live-id" });
    expect(f.modern.handle(old, "alice")).toBe(false);
    expect(f.modern.playback(old)).toBe(true);
    expect(f.modern.handle(live, "alice")).toBe(false);
    expect(f.modern.playback(live)).toBe(false);
    expect(f.modern.handle(frame("JOIN", ["#room"], { batch: "page" }), "old-user")).toBe(true);
    f.modern.handle(frame("BATCH", ["-page"], { batch: "outer" }), "s");
    f.modern.handle(frame("BATCH", ["-outer"]), "s");
    expect(f.events).toContainEqual({
      type: "history-complete",
      operationId: op("history"),
      target: "#room",
      hasMore: false,
    });
    const before = { ...command, before: { serverId: "old-id" } };
    expect(f.modern.admit(before, op("before")).ok).toBe(true);
    await f.modern.perform(before, op("before"), f.write);
    expect(f.writes[1]?.params).toEqual(["BEFORE", "#room", "msgid=old-id", "10"]);
  });
  test("history limits, reference support, failures and unlabelled request quarantine", async () => {
    const f = fixture(allCaps.filter((cap) => cap !== "labeled-response"));
    f.modern.isupport(["CHATHISTORY=2", "MSGREFTYPES=timestamp"]);
    expect(f.modern.admit({ type: "history", target: "#room", limit: 3 }, op("big")).ok).toBe(
      false,
    );
    expect(
      f.modern.admit(
        { type: "history", target: "#room", limit: 2, before: { serverId: "id" } },
        op("ref"),
      ).ok,
    ).toBe(false);
    const command = {
      type: "history" as const,
      target: "#room",
      limit: 2,
      before: { serverTime: Date.parse("2026-01-01T00:00:00.000Z") },
    };
    expect(f.modern.admit(command, op("query")).ok).toBe(true);
    await f.modern.perform(command, op("query"), f.write);
    expect(f.writes[0]?.params).toEqual([
      "BEFORE",
      "#room",
      "timestamp=2026-01-01T00:00:00.000Z",
      "2",
    ]);
    f.time(101_001);
    f.modern.tick(101_001);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "error", operationId: op("query") }),
    );
    expect(f.modern.admit(command, op("ambiguous")).ok).toBe(false);
    f.modern.handle(frame("BATCH", ["+late", "chathistory", "#room"]), "s");
    f.modern.handle(frame("BATCH", ["-late"]), "s");
    expect(f.modern.admit(command, op("next")).ok).toBe(true);
    f.modern.handle(
      frame("FAIL", ["CHATHISTORY", "INVALID_TARGET", "BEFORE", "#room", "raw server details"]),
      "s",
    );
    expect(JSON.stringify(f.events)).not.toContain("raw server details");
    expect(f.modern.admit(command, op("after-fail")).ok).toBe(true);
  });
  test.each(["messages", "bytes", "depth", "count", "timeout"])(
    "batch %s overflow is explicitly fatal",
    (kind) => {
      const f = fixture(allCaps, {
        maxBatchMessages: 1,
        maxBatchBytes: 200,
        maxBatchDepth: 1,
        maxBatches: 1,
      });
      f.modern.handle(frame("BATCH", ["+one", "chathistory", "#room"]), "s");
      if (kind === "messages") {
        f.modern.handle(frame("PRIVMSG", ["#room", "x"], { batch: "one" }), "a");
        f.modern.handle(frame("PRIVMSG", ["#room", "y"], { batch: "one" }), "a");
      }
      if (kind === "bytes")
        f.modern.handle(frame("PRIVMSG", ["#room", "x".repeat(300)], { batch: "one" }), "a");
      if (kind === "depth")
        f.modern.handle(frame("BATCH", ["+two", "custom"], { batch: "one" }), "s");
      if (kind === "count") f.modern.handle(frame("BATCH", ["+two", "custom"]), "s");
      if (kind === "timeout") f.modern.tick(101_001);
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]?.code).toBe("network");
    },
  );
  test("typing is throttled, transient, clears on chat/quit, ignores historical indicators", async () => {
    const f = fixture();
    const active = frame("TAGMSG", ["#room"], { "+typing": "active" });
    f.modern.handle(active, "alice");
    expect(f.events.at(-1)).toMatchObject({ type: "typing", active: true });
    f.time(106_001);
    f.modern.tick(106_001);
    expect(f.events.at(-1)).toMatchObject({ type: "typing", active: false });
    f.modern.handle(frame("TAGMSG", ["#room"], { "+typing": "paused" }), "alice");
    f.modern.observeChat(frame("PRIVMSG", ["#room", "hello"]), "alice", "#room");
    expect(f.events.at(-1)).toMatchObject({ active: false });
    f.modern.handle(active, "alice");
    f.modern.clearTyping("alice");
    expect(f.events.at(-1)).toMatchObject({ active: false });
    f.modern.handle(frame("BATCH", ["+page", "chathistory", "#room"]), "s");
    const before = f.events.length;
    f.modern.handle(frame("TAGMSG", ["#room"], { batch: "page", "+typing": "active" }), "alice");
    expect(f.events).toHaveLength(before);
    f.modern.handle(frame("BATCH", ["-page"]), "s");
    const command = { type: "typing" as const, target: "#room", active: true };
    expect(f.modern.admit(command, op("typing")).ok).toBe(true);
    await f.modern.perform(command, op("typing"), f.write);
    expect(f.writes[0]).toMatchObject({ command: "TAGMSG", tags: { "+typing": "active" } });
    expect(f.modern.admit({ ...command, active: false }, op("fast")).ok).toBe(false);
    f.time(109_002);
    f.modern.tick(109_002);
    expect(f.modern.admit({ ...command, active: false }, op("done")).ok).toBe(true);
  });
  test("draft reactions/unreactions, REDACT, MARKREAD, standard errors and monotonic markers", async () => {
    const f = fixture();
    f.modern.observeChat(frame("PRIVMSG", ["#room", "hello"], { msgid: "id" }), "alice", "#room");
    const react = {
      type: "reaction" as const,
      target: "#room",
      serverId: "id",
      value: "🐈",
      remove: false,
    };
    expect(f.modern.admit(react, op("react")).ok).toBe(true);
    await f.modern.perform(react, op("react"), f.write);
    expect(f.writes[0]).toMatchObject({
      command: "TAGMSG",
      tags: { "+reply": "id", "+draft/react": "🐈" },
    });
    f.modern.handle(frame("TAGMSG", ["#room"], { "+reply": "id", "+draft/unreact": "🐈" }), "bob");
    expect(f.events.at(-1)).toEqual({
      type: "reaction",
      target: "#room",
      serverId: "id",
      nick: "bob",
      value: "🐈",
      remove: true,
    });
    const redact = { type: "redact" as const, target: "#room", serverId: "id" };
    expect(f.modern.admit(redact, op("redact")).ok).toBe(true);
    await f.modern.perform(redact, op("redact"), f.write);
    f.modern.handle(
      frame("FAIL", ["REDACT", "REDACT_FORBIDDEN", "#room", "id", "private detail"], {
        label: f.writes[1]!.tags.label!,
      }),
      "s",
    );
    expect(f.events.at(-1)).toMatchObject({ type: "error", operationId: op("redact") });
    f.modern.handle(frame("REDACT", ["#room", "id"]), "alice");
    expect(f.events.at(-1)).toEqual({ type: "redaction", target: "#room", serverId: "id" });
    const time = Date.parse("2026-01-01T00:00:00.000Z");
    const read = { type: "mark-read" as const, target: "#room", serverTime: time };
    expect(f.modern.admit(read, op("read")).ok).toBe(true);
    await f.modern.perform(read, op("read"), f.write);
    expect(f.writes[2]?.params).toEqual(["#room", "timestamp=2026-01-01T00:00:00.000Z"]);
    f.modern.handle(frame("MARKREAD", ["#room", "timestamp=2026-01-01T00:00:00.000Z"]), "s");
    expect(f.events.at(-1)).toEqual({ type: "read-marker", target: "#room", serverTime: time });
    const count = f.events.length;
    f.modern.handle(frame("MARKREAD", ["#room", "timestamp=2025-01-01T00:00:00.000Z"]), "s");
    expect(f.events).toHaveLength(count);
    expect(f.modern.admit({ ...read, serverTime: time - 1 }, op("backwards")).ok).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain("private detail");
  });
});
