import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityId, type Result } from "../../src/contracts/common";
import type { Message } from "../../src/contracts/model";
import type { ConversationRecord, HistoryRepository } from "../../src/contracts/storage";
import { createHistoryRepository } from "../../src/storage/history";

const signal = new AbortController().signal;
const first: ConversationRecord = {
  id: entityId("conversation-1"),
  networkId: entityId("network-1"),
  kind: "channel",
  name: "#first",
};
const second: ConversationRecord = {
  id: entityId("conversation-2"),
  networkId: entityId("network-2"),
  kind: "direct",
  name: "peer",
};
function message(id: string, time: number, changes: Partial<Message> = {}): Message {
  return {
    id: entityId(id),
    conversationId: first.id,
    networkId: first.networkId,
    sender: { nick: "tester" },
    kind: "text",
    text: "literal %_ AND foo",
    receivedAt: time,
    source: "live",
    reactions: [],
    redacted: false,
    ...changes,
  };
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Unexpected safe error: ${result.error.code}`);
  return result.value;
}
const repositories: HistoryRepository[] = [];
const directories: string[] = [];
async function openHistory(): Promise<{ repository: HistoryRepository; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "openirc-history-"));
  directories.push(directory);
  const path = join(directory, "history.sqlite");
  const repository = value(await createHistoryRepository(path));
  repositories.push(repository);
  return { repository, path };
}
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("SQLite history", () => {
  test("upgrades v1 with a private consistent WAL backup and preserves per-conversation occurrences", async () => {
    const { repository, path } = await openHistory();
    const legacy = message("legacy", 100, { serverId: "shared-event" });
    value(
      await repository.commit(
        { conversations: [first], messages: [legacy], readPositions: [] },
        signal,
      ),
    );
    value(await repository.close());
    const raw = new Database(path);
    try {
      raw.exec(
        "DROP INDEX message_server_identity; CREATE UNIQUE INDEX message_server_identity ON messages(network_id,server_id) WHERE server_id IS NOT NULL; PRAGMA user_version=1;",
      );
      const wal = { ...legacy, text: "committed WAL content" };
      raw
        .query("UPDATE messages SET body=?,search_text=? WHERE id=?")
        .run(JSON.stringify(wal), wal.text, wal.id);
      const upgraded = value(await createHistoryRepository(path));
      repositories.push(upgraded);
      expect(value(await upgraded.page(first.id, { limit: 10 }, signal)).items).toEqual([wal]);
      const backupPath = `${path}.schema-v1.bak`;
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(
          backup.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
        ).toBe(1);
        const body = backup
          .query<{ body: string }, [string]>("SELECT body FROM messages WHERE id=?")
          .get(legacy.id)?.body;
        expect(body && JSON.parse(body)).toEqual(wal);
      } finally {
        backup.close();
      }
      const other: ConversationRecord = { ...first, id: entityId("other-channel"), name: "#other" };
      const occurrence = {
        ...wal,
        id: entityId<"message">("other-occurrence"),
        conversationId: other.id,
      };
      value(
        await upgraded.commit(
          { conversations: [other], messages: [occurrence], readPositions: [] },
          signal,
        ),
      );
      expect(
        value(await upgraded.findByServerId(first.networkId, first.id, "shared-event", signal))?.id,
      ).toBe(legacy.id);
      expect(
        value(await upgraded.findByServerId(first.networkId, other.id, "shared-event", signal))?.id,
      ).toBe(occurrence.id);
      value(await upgraded.close());
      const reopened = value(await createHistoryRepository(path));
      repositories.push(reopened);
      expect(value(await reopened.page(other.id, { limit: 10 }, signal)).items).toEqual([
        occurrence,
      ]);
    } finally {
      raw.close();
    }
  });
  test("never overwrites a preexisting migration backup or upgrades without a fresh backup", async () => {
    const { repository, path } = await openHistory();
    value(await repository.close());
    const raw = new Database(path);
    raw.exec(
      "DROP INDEX message_server_identity; CREATE UNIQUE INDEX message_server_identity ON messages(network_id,server_id) WHERE server_id IS NOT NULL; PRAGMA user_version=1;",
    );
    raw.close();
    const backupPath = `${path}.schema-v1.bak`;
    await writeFile(backupPath, "preserve this existing backup", { flag: "wx", mode: 0o600 });
    const opened = await createHistoryRepository(path);
    expect(opened.ok ? null : opened.error.code).toBe("conflict");
    expect(await readFile(backupPath, "utf8")).toBe("preserve this existing backup");
    const unchanged = new Database(path, { readonly: true });
    try {
      expect(
        unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(1);
    } finally {
      unchanged.close();
    }
  });
  test("migrates, persists registry/workspace/messages/read positions and idempotently enriches local identity", async () => {
    const { repository, path } = await openHistory();
    const local = message("local", 100, { source: "local", sendState: "pending" });
    const batch = {
      conversations: [first],
      messages: [local],
      readPositions: [{ conversationId: first.id, messageId: local.id, readAt: 110 }],
    };
    value(await repository.commit(batch, signal));
    value(await repository.commit(batch, signal));
    const echo = {
      ...local,
      serverId: "server-1",
      serverTime: 90,
      sendState: "echo-observed" as const,
    };
    value(
      await repository.commit({ conversations: [], messages: [echo], readPositions: [] }, signal),
    );
    value(
      await repository.saveWorkspace(
        {
          activeConversationId: first.id,
          conversationOrder: [first.id],
          mutedConversations: [first.id],
          drafts: [{ conversationId: first.id, text: "draft" }],
        },
        signal,
      ),
    );
    value(await repository.close());
    const reopened = value(await createHistoryRepository(path));
    repositories.push(reopened);
    expect(value(await reopened.loadConversations(signal))).toEqual([first]);
    expect(value(await reopened.page(first.id, { limit: 10 }, signal)).items).toEqual([echo]);
    expect(
      value(await reopened.findByServerId(first.networkId, first.id, "server-1", signal)),
    ).toEqual(echo);
    expect(
      value(await reopened.findByServerId(second.networkId, first.id, "server-1", signal)),
    ).toBeNull();
    expect(
      value(await reopened.findByServerId(first.networkId, second.id, "server-1", signal)),
    ).toBeNull();
    expect(value(await reopened.loadReadPositions(signal))).toEqual(batch.readPositions);
    expect(value(await reopened.loadWorkspace(signal)).drafts[0]?.text).toBe("draft");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("enforces conversation-scoped event occurrences, immutable identities and atomic rollback", async () => {
    const { repository } = await openHistory();
    const third: ConversationRecord = { ...first, id: entityId("conversation-3"), name: "#third" };
    value(
      await repository.commit(
        {
          conversations: [first, second, third],
          messages: [
            message("a", 10, { serverId: "same" }),
            message("occurrence", 10, { conversationId: third.id, serverId: "same" }),
            message("b", 10, {
              conversationId: second.id,
              networkId: second.networkId,
              serverId: "same",
            }),
          ],
          readPositions: [],
        },
        signal,
      ),
    );
    expect(
      value(await repository.findByServerId(first.networkId, third.id, "same", signal))?.id,
    ).toBe(entityId("occurrence"));
    const conflict = await repository.commit(
      {
        conversations: [],
        messages: [message("c", 20), message("collision", 20, { serverId: "same" })],
        readPositions: [],
      },
      signal,
    );
    expect(conflict.ok ? null : conflict.error.code).toBe("conflict");
    expect(
      value(await repository.page(first.id, { limit: 10 }, signal)).items.map((item) => item.id),
    ).toEqual([entityId("a")]);
    const invalid = await repository.commit(
      {
        conversations: [],
        messages: [message("invalid", 10, { networkId: second.networkId })],
        readPositions: [],
      },
      signal,
    );
    expect(invalid.ok ? null : invalid.error.code).toBe("invalid-input");
    const move = await repository.commit(
      {
        conversations: [{ ...first, networkId: second.networkId }],
        messages: [],
        readPositions: [],
      },
      signal,
    );
    expect(move.ok ? null : move.error.code).toBe("conflict");
    const wrongRead = await repository.commit(
      {
        conversations: [],
        messages: [],
        readPositions: [{ conversationId: first.id, messageId: entityId("b"), readAt: 100 }],
      },
      signal,
    );
    expect(wrongRead.ok ? null : wrongRead.error.code).toBe("invalid-input");
  });

  test("keyset pages are chronological, deterministic and stable after newer insertions; cursors are query-bound", async () => {
    const { repository } = await openHistory();
    value(
      await repository.commit(
        {
          conversations: [first, second],
          messages: [message("a", 10), message("b", 10), message("c", 20), message("d", 30)],
          readPositions: [],
        },
        signal,
      ),
    );
    const latest = value(await repository.page(first.id, { limit: 2 }, signal));
    expect(latest.items.map((item) => item.id)).toEqual([entityId("c"), entityId("d")]);
    expect(latest.nextCursor).toBeDefined();
    value(
      await repository.commit(
        { conversations: [], messages: [message("e", 40)], readPositions: [] },
        signal,
      ),
    );
    const older = value(
      await repository.page(first.id, { limit: 2, cursor: latest.nextCursor! }, signal),
    );
    expect(older.items.map((item) => item.id)).toEqual([entityId("a"), entityId("b")]);
    expect(older.nextCursor).toBeUndefined();
    const foreign = await repository.page(
      second.id,
      { limit: 2, cursor: latest.nextCursor! },
      signal,
    );
    expect(foreign.ok ? null : foreign.error.code).toBe("invalid-input");
    expect((await repository.page(first.id, { limit: 501 }, signal)).ok).toBe(false);
    expect(
      (await repository.page(first.id, { limit: 2, cursor: entityId("bad-cursor") }, signal)).ok,
    ).toBe(false);
  });

  test("literal search is parameterized, filtered, newest-first, paginated and removed on redaction", async () => {
    const { repository } = await openHistory();
    value(
      await repository.commit(
        {
          conversations: [first],
          messages: [
            message("a", 10),
            message("b", 20),
            message("c", 30, { text: "wildcard other" }),
          ],
          readPositions: [],
        },
        signal,
      ),
    );
    const result = value(
      await repository.search(
        { text: "%_ AND", networkId: first.networkId, sender: "tester", limit: 1 },
        signal,
      ),
    );
    expect(result.items[0]?.id).toBe(entityId("b"));
    const older = value(
      await repository.search(
        {
          text: "%_ AND",
          networkId: first.networkId,
          sender: "tester",
          limit: 1,
          cursor: result.nextCursor!,
        },
        signal,
      ),
    );
    expect(older.items[0]?.id).toBe(entityId("a"));
    expect(
      (await repository.search({ text: "different", limit: 1, cursor: result.nextCursor! }, signal))
        .ok,
    ).toBe(false);
    expect(
      value(await repository.search({ text: "' OR 1=1 --", limit: 20 }, signal)).items,
    ).toEqual([]);
    value(
      await repository.commit(
        {
          conversations: [],
          messages: [
            message("b", 20, {
              redacted: true,
              reactions: [{ value: "x", count: 1, reactedBySelf: false }],
            }),
          ],
          readPositions: [],
        },
        signal,
      ),
    );
    expect(
      value(await repository.search({ text: "%_ AND", limit: 10 }, signal)).items.map(
        (item) => item.id,
      ),
    ).toEqual([entityId("a")]);
    const redacted = value(await repository.context(entityId("b"), 0, signal))[0];
    expect(redacted?.text).toBe("");
    expect(redacted?.reactions).toEqual([]);
    expect(
      (
        await repository.commit(
          { conversations: [], messages: [message("b", 20)], readPositions: [] },
          signal,
        )
      ).ok,
    ).toBe(false);
  });

  test("context includes target, retention and deletion clean read/search/draft data but retain conversation identity", async () => {
    const { repository } = await openHistory();
    value(
      await repository.commit(
        {
          conversations: [first],
          messages: [message("a", 10), message("b", 20), message("c", 30)],
          readPositions: [{ conversationId: first.id, messageId: entityId("a"), readAt: 40 }],
        },
        signal,
      ),
    );
    expect(
      value(await repository.context(entityId("b"), 1, signal)).map((item) => item.id),
    ).toEqual([entityId("a"), entityId("b"), entityId("c")]);
    expect((await repository.context(entityId("missing"), 1, signal)).ok).toBe(false);
    expect(value(await repository.prune(20, signal))).toBe(1);
    expect(value(await repository.loadReadPositions(signal))).toEqual([]);
    value(
      await repository.saveWorkspace(
        {
          conversationOrder: [first.id],
          mutedConversations: [],
          drafts: [{ conversationId: first.id, text: "sensitive draft" }],
        },
        signal,
      ),
    );
    value(await repository.deleteConversation(first.id, signal));
    expect(value(await repository.page(first.id, { limit: 10 }, signal)).items).toEqual([]);
    expect(value(await repository.loadConversations(signal))).toEqual([first]);
    expect(value(await repository.loadWorkspace(signal)).drafts).toEqual([]);
    expect(value(await repository.search({ text: "literal", limit: 10 }, signal)).items).toEqual(
      [],
    );
  });

  test("read positions never regress and cancelled/closed operations have no effects", async () => {
    const { repository } = await openHistory();
    value(
      await repository.commit(
        {
          conversations: [first],
          messages: [message("a", 10), message("b", 20)],
          readPositions: [{ conversationId: first.id, messageId: entityId("b"), readAt: 20 }],
        },
        signal,
      ),
    );
    value(
      await repository.commit(
        {
          conversations: [],
          messages: [],
          readPositions: [{ conversationId: first.id, messageId: entityId("a"), readAt: 100 }],
        },
        signal,
      ),
    );
    expect(value(await repository.loadReadPositions(signal))[0]?.messageId).toBe(entityId("b"));
    const aborted = new AbortController();
    aborted.abort();
    expect((await repository.deleteConversation(first.id, aborted.signal)).ok).toBe(false);
    expect(value(await repository.page(first.id, { limit: 10 }, signal)).items.length).toBe(2);
    value(await repository.close());
    expect((await repository.loadConversations(signal)).ok).toBe(false);
    expect((await repository.close()).ok).toBe(false);
  });

  test("status labels allow spaces; Unicode ID ties use SQLite ordering for read monotonicity", async () => {
    const { repository } = await openHistory();
    const status: ConversationRecord = { ...first, kind: "status", name: "Example Network status" };
    const lower = message("\ue000", 10);
    const higher = message("\u{10000}", 10);
    value(
      await repository.commit(
        {
          conversations: [status],
          messages: [higher, lower],
          readPositions: [{ conversationId: status.id, messageId: higher.id, readAt: 10 }],
        },
        signal,
      ),
    );
    value(
      await repository.commit(
        {
          conversations: [],
          messages: [],
          readPositions: [{ conversationId: status.id, messageId: lower.id, readAt: 20 }],
        },
        signal,
      ),
    );
    expect(value(await repository.loadReadPositions(signal))[0]?.messageId).toBe(higher.id);
    expect(
      value(await repository.page(status.id, { limit: 10 }, signal)).items.map((item) => item.id),
    ).toEqual([lower.id, higher.id]);
  });

  test("rejects unregistered workspace references and externally corrupted search columns", async () => {
    const { repository, path } = await openHistory();
    expect(
      (
        await repository.saveWorkspace(
          { conversationOrder: [first.id], mutedConversations: [], drafts: [] },
          signal,
        )
      ).ok,
    ).toBe(false);
    value(
      await repository.commit(
        { conversations: [first], messages: [message("a", 10)], readPositions: [] },
        signal,
      ),
    );
    const raw = new Database(path);
    raw.exec("UPDATE messages SET search_text='inconsistent private body'");
    raw.close();
    const result = await repository.search({ text: "inconsistent", limit: 1 }, signal);
    expect(result.ok ? null : result.error.code).toBe("storage");
    expect(JSON.stringify(result)).not.toContain("private body");
    expect(
      (
        await repository.commit(
          {
            conversations: [],
            messages: [message("invalid", 20, { text: "bad\x1b[31m" })],
            readPositions: [],
          },
          signal,
        )
      ).ok,
    ).toBe(false);
  });

  test("rejects newer schema and corrupt stored data with safe errors", async () => {
    const { repository, path } = await openHistory();
    value(
      await repository.commit(
        { conversations: [first], messages: [message("a", 10)], readPositions: [] },
        signal,
      ),
    );
    const raw = new Database(path);
    raw.query("UPDATE messages SET body=?").run('{"secret":"never leak"}');
    const result = await repository.page(first.id, { limit: 10 }, signal);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("never leak");
    raw.exec("PRAGMA user_version=999");
    raw.close();
    value(await repository.close());
    const future = await createHistoryRepository(path);
    expect(future.ok ? null : future.error.code).toBe("unsupported");
  });
});
