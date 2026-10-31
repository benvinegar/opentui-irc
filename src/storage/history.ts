import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entityId, type Cursor, type Result } from "../contracts/common";
import type { Message } from "../contracts/model";
import type {
  ConversationRecord,
  HistoryRepository,
  Page,
  ReadPosition,
  SearchQuery,
  WorkspaceState,
} from "../contracts/storage";
import { failure, safeFailure, StorageFault, success } from "./errors";
import {
  identifier,
  record,
  timestamp,
  validConversation,
  validMessage,
  validReadPosition,
  validWorkspace,
} from "./validation";

type MessageRow = {
  id: string;
  conversation_id: string;
  network_id: string;
  server_id: string | null;
  order_time: number;
  sender: string;
  search_text: string;
  body: string;
};
type Position = { time: number; id: string };
const MAX_PAGE = 500;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
function checkPayload(items: readonly unknown[], limit = MAX_BATCH_BYTES): void {
  let bytes = 0;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > limit)
      throw new StorageFault("invalid-input", "Storage payload exceeds the supported size.");
  }
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (cause: unknown) => !(cause instanceof Error && "code" in cause && cause.code === "ENOENT"),
  );
}
function validLimit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_PAGE;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function cursorFor(query: string, position: Position): Cursor {
  return entityId<"cursor">(
    Buffer.from(JSON.stringify({ version: 1, query, ...position })).toString("base64url"),
  );
}
function cursorPosition(cursor: Cursor | undefined, query: string): Position | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== "string" || cursor.length > 2048 || !/^[\w-]+$/u.test(cursor))
      throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !record(parsed) ||
      parsed.version !== 1 ||
      parsed.query !== query ||
      !timestamp(parsed.time) ||
      !identifier(parsed.id)
    )
      throw new Error();
    return { time: parsed.time, id: parsed.id };
  } catch {
    throw new StorageFault("invalid-input", "Invalid or incompatible history cursor.");
  }
}
function decodeMessage(row: MessageRow): Message {
  const value: unknown = JSON.parse(row.body);
  if (
    !validMessage(value) ||
    value.id !== row.id ||
    value.conversationId !== row.conversation_id ||
    value.networkId !== row.network_id ||
    (value.serverId ?? null) !== row.server_id ||
    (value.serverTime ?? value.receivedAt) !== row.order_time ||
    value.sender.nick !== row.sender ||
    value.text !== row.search_text ||
    (value.redacted && (value.text !== "" || value.reactions.length !== 0))
  )
    throw new StorageFault("storage", "Stored history is invalid.");
  return value;
}

/** Creates schema v2 in an empty database; anything else is left untouched. */
function createSchema(db: Database): void {
  if (
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get()?.count !== 0
  )
    throw new StorageFault("unsupported", "Unrecognized history database; it was not modified.");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('channel','direct','status')), name TEXT NOT NULL, UNIQUE(id, network_id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, network_id TEXT NOT NULL, server_id TEXT, order_time INTEGER NOT NULL, sender TEXT NOT NULL, search_text TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(id, conversation_id), FOREIGN KEY(conversation_id, network_id) REFERENCES conversations(id, network_id));
      CREATE UNIQUE INDEX message_server_identity ON messages(network_id, conversation_id, server_id) WHERE server_id IS NOT NULL;
      CREATE INDEX message_conversation_order ON messages(conversation_id, order_time DESC, id DESC);
      CREATE INDEX message_order ON messages(order_time DESC, id DESC);
      CREATE INDEX message_network_order ON messages(network_id, order_time DESC, id DESC);
      CREATE TABLE read_positions (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), message_id TEXT NOT NULL, read_at INTEGER NOT NULL, FOREIGN KEY(message_id, conversation_id) REFERENCES messages(id, conversation_id) ON DELETE CASCADE);
      CREATE TABLE workspace (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
  })();
}
async function migrateFromV1(db: Database, path: string): Promise<void> {
  // VACUUM INTO snapshots committed WAL content too. Some SQLite builds (macOS system
  // SQLite) refuse an existing target, so write into a private temporary directory and
  // hard-link it into place: the link never overwrites an earlier migration backup.
  const backupPath = `${path}.schema-v1.bak`;
  const conflict = () =>
    new StorageFault(
      "conflict",
      "History migration backup already exists. Preserve it and inspect before retrying.",
    );
  if (await exists(backupPath)) throw conflict();
  let staging;
  try {
    staging = await mkdtemp(join(dirname(path), ".history-migration-"));
    await chmod(staging, 0o700);
  } catch {
    throw new StorageFault("storage", "Could not create a private history migration backup.");
  }
  try {
    const snapshot = join(staging, "backup.sqlite");
    db.query("VACUUM INTO ?").run(snapshot);
    await chmod(snapshot, 0o600);
    try {
      await link(snapshot, backupPath);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") throw conflict();
      throw cause;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  db.transaction(() => {
    db.exec(`
      DROP INDEX message_server_identity;
      CREATE UNIQUE INDEX message_server_identity ON messages(network_id, conversation_id, server_id) WHERE server_id IS NOT NULL;
      PRAGMA user_version = 2;
    `);
  })();
}
function validSearch(query: SearchQuery): boolean {
  return (
    typeof query.text === "string" &&
    query.text.trim() !== "" &&
    query.text.length <= 4096 &&
    validLimit(query.limit) &&
    (query.networkId === undefined || identifier(query.networkId)) &&
    (query.conversationId === undefined || identifier(query.conversationId)) &&
    (query.sender === undefined || identifier(query.sender)) &&
    (query.after === undefined || timestamp(query.after)) &&
    (query.before === undefined || timestamp(query.before)) &&
    (query.after === undefined || query.before === undefined || query.after < query.before)
  );
}
function searchFilters(query: SearchQuery): { where: string[]; params: (string | number)[] } {
  const where = ["instr(search_text, ?) > 0"];
  const params: (string | number)[] = [query.text];
  for (const [column, value] of [
    ["network_id", query.networkId],
    ["conversation_id", query.conversationId],
    ["sender", query.sender],
  ] as const) {
    if (value !== undefined) {
      where.push(`${column}=?`);
      params.push(value);
    }
  }
  if (query.after !== undefined) {
    where.push("order_time>?");
    params.push(query.after);
  }
  if (query.before !== undefined) {
    where.push("order_time<?");
    params.push(query.before);
  }
  return { where, params };
}

/** Opens an explicit SQLite path; schema v1 uses indexed keyset order (effective time, local ID). */
export async function createHistoryRepository(path: string): Promise<Result<HistoryRepository>> {
  let db: Database | undefined;
  try {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0"))
      return failure("invalid-input", "A history database path is required.");
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") await chmod(path, 0o600);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2)
      throw new StorageFault("unsupported", "History database schema is not supported.");
    if (version === 0) createSchema(db);
    if (version === 1) await migrateFromV1(db, path);
    db.exec("PRAGMA journal_mode = WAL;");
    return success(repository(db));
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Preserve the original safe failure. */
    }
    return safeFailure(error);
  }
}

function repository(db: Database): HistoryRepository {
  let closed = false;
  function perform<T>(signal: AbortSignal, operation: () => T): Promise<Result<T>> {
    if (signal.aborted)
      return Promise.resolve(failure("cancelled", "Storage operation cancelled."));
    if (closed) return Promise.resolve(failure("unavailable", "History is closed."));
    try {
      return Promise.resolve(success(operation()));
    } catch (error) {
      return Promise.resolve(safeFailure(error));
    }
  }
  function requireConversation(id: string): void {
    if (!db.query<{ id: string }, [string]>("SELECT id FROM conversations WHERE id = ?").get(id))
      throw new StorageFault("unavailable", "Conversation is not registered.");
  }
  function rows(sql: string, params: (string | number)[]): MessageRow[] {
    return db.query<MessageRow, (string | number)[]>(sql).all(...params);
  }
  function paginated(
    where: string[],
    params: (string | number)[],
    position: Position | undefined,
    limit: number,
    query: string,
    chronological: boolean,
  ): Page<Message> {
    if (position) {
      where.push("(order_time < ? OR (order_time = ? AND id < ?))");
      params.push(position.time, position.time, position.id);
    }
    const matches = rows(
      `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY order_time DESC, id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const selected = matches.slice(0, limit);
    const last = selected.at(-1);
    const items = selected.map(decodeMessage);
    if (chronological) items.reverse();
    return {
      items,
      ...(matches.length > limit && last
        ? { nextCursor: cursorFor(query, { time: last.order_time, id: last.id }) }
        : {}),
    };
  }
  function upsertConversation(conversation: ConversationRecord): void {
    const existing = db
      .query<{ network_id: string; kind: string }, [string]>(
        "SELECT network_id, kind FROM conversations WHERE id=?",
      )
      .get(conversation.id);
    if (
      existing &&
      (existing.network_id !== conversation.networkId || existing.kind !== conversation.kind)
    )
      throw new StorageFault("conflict", "Conversation identity cannot be reassigned.");
    db.query(
      "INSERT INTO conversations(id,network_id,kind,name) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
    ).run(conversation.id, conversation.networkId, conversation.kind, conversation.name);
  }
  function upsertMessage(original: Message): void {
    const message: Message = original.redacted
      ? { ...original, text: "", reactions: [] }
      : original;
    const conversation = db
      .query<{ network_id: string }, [string]>("SELECT network_id FROM conversations WHERE id=?")
      .get(message.conversationId);
    if (!conversation || conversation.network_id !== message.networkId)
      throw new StorageFault("invalid-input", "Message conversation/network is not registered.");
    const existing = db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE id=?")
      .get(message.id);
    if (
      existing &&
      (existing.network_id !== message.networkId ||
        existing.conversation_id !== message.conversationId ||
        (existing.server_id !== null && existing.server_id !== message.serverId))
    )
      throw new StorageFault("conflict", "Message identity cannot be reassigned.");
    if (existing && decodeMessage(existing).redacted && !message.redacted)
      throw new StorageFault("conflict", "A redacted message cannot be restored by an upsert.");
    if (message.serverId !== undefined) {
      const collision = db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM messages WHERE network_id=? AND conversation_id=? AND server_id=?",
        )
        .get(message.networkId, message.conversationId, message.serverId);
      if (collision && collision.id !== message.id)
        throw new StorageFault("conflict", "Server message identity requires an explicit merge.");
    }
    db.query(
      "INSERT INTO messages(id,conversation_id,network_id,server_id,order_time,sender,search_text,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET server_id=excluded.server_id,order_time=excluded.order_time,sender=excluded.sender,search_text=excluded.search_text,body=excluded.body",
    ).run(
      message.id,
      message.conversationId,
      message.networkId,
      message.serverId ?? null,
      message.serverTime ?? message.receivedAt,
      message.sender.nick,
      message.text,
      JSON.stringify(message),
    );
  }
  /** Read positions only move forward; an older position is ignored. */
  function advanceReadPosition(position: ReadPosition): void {
    const target = db
      .query<{ conversation_id: string; order_time: number }, [string]>(
        "SELECT conversation_id,order_time FROM messages WHERE id=?",
      )
      .get(position.messageId);
    if (!target || target.conversation_id !== position.conversationId)
      throw new StorageFault("invalid-input", "Read position does not belong to its conversation.");
    const newerPosition = db
      .query<{ id: string }, [string, number, number, string]>(
        "SELECT m.id FROM read_positions r JOIN messages m ON m.id=r.message_id WHERE r.conversation_id=? AND (m.order_time > ? OR (m.order_time = ? AND m.id > ?))",
      )
      .get(position.conversationId, target.order_time, target.order_time, position.messageId);
    if (newerPosition) return;
    db.query(
      "INSERT INTO read_positions(conversation_id,message_id,read_at) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET message_id=excluded.message_id,read_at=max(read_at,excluded.read_at)",
    ).run(position.conversationId, position.messageId, position.readAt);
  }
  return {
    commit(batch, signal) {
      return perform(signal, () => {
        if (
          !record(batch) ||
          !Array.isArray(batch.conversations) ||
          !Array.isArray(batch.messages) ||
          !Array.isArray(batch.readPositions) ||
          batch.conversations.length > 10000 ||
          batch.messages.length > 10000 ||
          batch.readPositions.length > 10000 ||
          !batch.conversations.every(validConversation) ||
          !batch.messages.every(validMessage) ||
          !batch.readPositions.every(validReadPosition)
        )
          throw new StorageFault("invalid-input", "Invalid history batch.");
        checkPayload([...batch.conversations, ...batch.messages, ...batch.readPositions]);
        db.transaction(() => {
          batch.conversations.forEach(upsertConversation);
          batch.messages.forEach(upsertMessage);
          batch.readPositions.forEach(advanceReadPosition);
        })();
      });
    },
    page(conversationId, options, signal) {
      return perform(signal, () => {
        if (!identifier(conversationId) || !validLimit(options.limit))
          throw new StorageFault("invalid-input", "Invalid history page request.");
        requireConversation(conversationId);
        const query = hash(["page", conversationId]);
        return paginated(
          ["conversation_id=?"],
          [conversationId],
          cursorPosition(options.cursor, query),
          options.limit,
          query,
          true,
        );
      });
    },
    findByServerId(networkId, conversationId, serverId, signal) {
      return perform(signal, () => {
        if (!identifier(networkId) || !identifier(conversationId) || !identifier(serverId))
          throw new StorageFault("invalid-input", "Invalid server message identity.");
        const row = db
          .query<MessageRow, [string, string, string]>(
            "SELECT * FROM messages WHERE network_id=? AND conversation_id=? AND server_id=?",
          )
          .get(networkId, conversationId, serverId);
        return row ? decodeMessage(row) : null;
      });
    },
    search(query: SearchQuery, signal) {
      return perform(signal, () => {
        if (!validSearch(query)) throw new StorageFault("invalid-input", "Invalid search request.");
        const fingerprint = hash([
          "search",
          query.text,
          query.networkId,
          query.conversationId,
          query.sender,
          query.after,
          query.before,
        ]);
        const { where, params } = searchFilters(query);
        return paginated(
          where,
          params,
          cursorPosition(query.cursor, fingerprint),
          query.limit,
          fingerprint,
          false,
        );
      });
    },
    context(messageId, radius, signal) {
      return perform(signal, () => {
        if (!identifier(messageId) || !Number.isInteger(radius) || radius < 0 || radius > 250)
          throw new StorageFault("invalid-input", "Invalid history context request.");
        const target = db
          .query<MessageRow, [string]>("SELECT * FROM messages WHERE id=?")
          .get(messageId);
        if (!target) throw new StorageFault("unavailable", "Message is not in local history.");
        const params = [
          target.conversation_id,
          target.order_time,
          target.order_time,
          target.id,
          radius,
        ];
        const older = rows(
          "SELECT * FROM messages WHERE conversation_id=? AND (order_time < ? OR (order_time=? AND id < ?)) ORDER BY order_time DESC,id DESC LIMIT ?",
          params,
        ).reverse();
        const newer = rows(
          "SELECT * FROM messages WHERE conversation_id=? AND (order_time > ? OR (order_time=? AND id > ?)) ORDER BY order_time ASC,id ASC LIMIT ?",
          params,
        );
        return [...older, target, ...newer].map(decodeMessage);
      });
    },
    loadConversations(signal) {
      return perform(signal, () =>
        db
          .query<{ id: string; network_id: string; kind: string; name: string }, []>(
            "SELECT * FROM conversations ORDER BY id",
          )
          .all()
          .map((row): ConversationRecord => {
            const value: unknown = {
              id: row.id,
              networkId: row.network_id,
              kind: row.kind,
              name: row.name,
            };
            if (!validConversation(value))
              throw new StorageFault("storage", "Stored conversation is invalid.");
            return value;
          }),
      );
    },
    loadReadPositions(signal) {
      return perform(signal, () =>
        db
          .query<{ conversation_id: string; message_id: string; read_at: number }, []>(
            "SELECT * FROM read_positions ORDER BY conversation_id",
          )
          .all()
          .map((row): ReadPosition => {
            const value: unknown = {
              conversationId: row.conversation_id,
              messageId: row.message_id,
              readAt: row.read_at,
            };
            if (!validReadPosition(value))
              throw new StorageFault("storage", "Stored read position is invalid.");
            return value;
          }),
      );
    },
    loadWorkspace(signal) {
      return perform(signal, () => {
        const row = db
          .query<{ body: string }, []>("SELECT body FROM workspace WHERE singleton=1")
          .get();
        const value: unknown = row
          ? JSON.parse(row.body)
          : { conversationOrder: [], mutedConversations: [], drafts: [] };
        if (!validWorkspace(value))
          throw new StorageFault("storage", "Stored workspace is invalid.");
        const references = [
          ...value.conversationOrder,
          ...value.mutedConversations,
          ...value.drafts.map((draft) => draft.conversationId),
          ...(value.activeConversationId ? [value.activeConversationId] : []),
        ];
        references.forEach(requireConversation);
        return value;
      });
    },
    saveWorkspace(state: WorkspaceState, signal) {
      return perform(signal, () => {
        if (!validWorkspace(state))
          throw new StorageFault("invalid-input", "Invalid workspace state.");
        checkPayload(
          [...state.conversationOrder, ...state.mutedConversations, ...state.drafts],
          8 * 1024 * 1024,
        );
        db.transaction(() => {
          const ids = [
            ...state.conversationOrder,
            ...state.mutedConversations,
            ...state.drafts.map((draft) => draft.conversationId),
            ...(state.activeConversationId ? [state.activeConversationId] : []),
          ];
          ids.forEach(requireConversation);
          db.query(
            "INSERT INTO workspace(singleton,body) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body",
          ).run(JSON.stringify(state));
        })();
      });
    },
    deleteConversation(conversationId, signal) {
      return perform(signal, () => {
        if (!identifier(conversationId))
          throw new StorageFault("invalid-input", "Invalid conversation identity.");
        db.transaction(() => {
          db.query("DELETE FROM messages WHERE conversation_id=?").run(conversationId);
          const row = db
            .query<{ body: string }, []>("SELECT body FROM workspace WHERE singleton=1")
            .get();
          if (row) {
            const workspace: unknown = JSON.parse(row.body);
            if (!validWorkspace(workspace))
              throw new StorageFault("storage", "Stored workspace is invalid.");
            db.query("UPDATE workspace SET body=? WHERE singleton=1").run(
              JSON.stringify({
                ...workspace,
                drafts: workspace.drafts.filter((draft) => draft.conversationId !== conversationId),
              }),
            );
          }
        })();
      });
    },
    prune(before, signal) {
      return perform(signal, () => {
        if (!timestamp(before))
          throw new StorageFault("invalid-input", "Invalid history retention cutoff.");
        return db.transaction(() => {
          const count =
            db
              .query<{ count: number }, [number]>(
                "SELECT count(*) AS count FROM messages WHERE order_time < ?",
              )
              .get(before)?.count ?? 0;
          db.query("DELETE FROM messages WHERE order_time < ?").run(before);
          return count;
        })();
      });
    },
    async close() {
      if (closed) return failure("unavailable", "History is closed.");
      closed = true;
      let result: Result<void> = success(undefined);
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        result = failure("storage", "History flush failed.");
      }
      try {
        db.close();
      } catch {
        result = failure("storage", "History close failed.");
      }
      return result;
    },
  };
}
