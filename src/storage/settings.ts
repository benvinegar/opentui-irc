import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { entityId, type ConfigRevision, type Result } from "../contracts/common";
import type {
  SettingsChange,
  SettingsDocument,
  SettingsRepository,
  TuiSettings,
  UserSettings,
} from "../contracts/settings";
import { failure, safeFailure, StorageFault, success } from "./errors";
import { record, validTuiSettings, validUserSettings } from "./validation";

export const DEFAULT_RETENTION_DAYS = 30;
export function defaultUserSettings(): UserSettings {
  return {
    schemaVersion: 1,
    networks: [],
    history: {
      enabled: true,
      retentionDays: DEFAULT_RETENTION_DAYS,
      excludedConversations: [],
      persistDrafts: false,
    },
    notifications: { desktop: false, previews: false, bell: false },
    sendTyping: false,
  };
}
export function defaultTuiSettings(): TuiSettings {
  return {
    schemaVersion: 1,
    theme: "dark",
    mouse: true,
    density: "compact",
    memberList: true,
    showHistServ: false,
    sidebarWidth: 24,
    memberListWidth: 22,
    keybindings: {},
  };
}
const MAX_CONFIG_BYTES = 1024 * 1024;
type Sources = { user: string | null; tui: string | null };
function hasCode(error: unknown, code: string): boolean {
  return record(error) && error.code === code;
}
async function readSource(path: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
      throw new StorageFault("invalid-input", "Settings file is too large or not a regular file.");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONFIG_BYTES)
      throw new StorageFault("invalid-input", "Settings file is too large.");
    const bytes = buffer.subarray(0, total);
    const source = bytes.toString("utf8");
    if (!Buffer.from(source).equals(bytes))
      throw new StorageFault("invalid-input", "Settings file is not valid UTF-8.");
    return source;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
function parseSource(source: string | null, fallback: unknown): unknown {
  if (source === null) return fallback;
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) throw new StorageFault("invalid-input", "Settings contain invalid JSONC.");
  return value;
}
function revision(sources: Sources): ConfigRevision {
  return entityId<"config-revision">(
    createHash("sha256")
      .update(JSON.stringify([sources.user, sources.tui]))
      .digest("hex"),
  );
}
function document(sources: Sources): SettingsDocument {
  const user = parseSource(sources.user, defaultUserSettings());
  const storedTui = parseSource(sources.tui, defaultTuiSettings());
  // Older schema-v1 files remain valid without rewriting their JSONC on load.
  const tui = record(storedTui)
    ? {
        ...storedTui,
        ...("showHistServ" in storedTui ? {} : { showHistServ: false }),
        ...("memberListWidth" in storedTui ? {} : { memberListWidth: 22 }),
      }
    : storedTui;
  if (!validUserSettings(user) || !validTuiSettings(tui))
    throw new StorageFault(
      "invalid-input",
      "Settings do not match the supported schema or security policy.",
    );
  return { revision: revision(sources), user, tui };
}
/** Leaf edits preserve JSONC comments/formatting on unchanged fields, including array elements. */
function updateJsonc(source: string | null, previous: unknown, next: unknown): string {
  if (source === null) {
    const created = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(created) > MAX_CONFIG_BYTES)
      throw new StorageFault("invalid-input", "Settings exceed the file size limit.");
    return created;
  }
  let result = source;
  function update(path: (string | number)[], before: unknown, after: unknown): void {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (record(before) && record(after)) {
      for (const key of Object.keys(before))
        if (!(key in after)) update([...path, key], before[key], undefined);
      for (const [key, value] of Object.entries(after)) update([...path, key], before[key], value);
    } else if (Array.isArray(before) && Array.isArray(after)) {
      for (let index = before.length - 1; index >= after.length; index--)
        update([...path, index], before[index], undefined);
      for (let index = 0; index < after.length; index++)
        update([...path, index], before[index], after[index]);
    } else {
      result = applyEdits(
        result,
        modify(result, path, after, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      );
    }
  }
  update([], previous, next);
  if (Buffer.byteLength(result) > MAX_CONFIG_BYTES)
    throw new StorageFault("invalid-input", "Settings exceed the file size limit.");
  return result;
}

/** Only reads this explicit directory; no cwd discovery or implicit project configuration. */
export function createSettingsRepository(directory: string): SettingsRepository {
  const validDirectory =
    typeof directory === "string" && directory.length > 0 && !directory.includes("\0");
  const explicitDirectory = validDirectory ? directory : ".";
  const paths = {
    user: join(explicitDirectory, "openirc.jsonc"),
    tui: join(explicitDirectory, "tui.jsonc"),
  };
  const lockPath = join(explicitDirectory, ".settings.lock");
  async function sources(): Promise<Sources> {
    const [user, tui] = await Promise.all([readSource(paths.user), readSource(paths.tui)]);
    return { user, tui };
  }
  return {
    async load(signal): Promise<Result<SettingsDocument>> {
      if (!validDirectory)
        return failure("invalid-input", "An explicit settings directory is required.");
      if (signal.aborted) return failure("cancelled", "Settings load cancelled.");
      try {
        const result = document(await sources());
        return signal.aborted ? failure("cancelled", "Settings load cancelled.") : success(result);
      } catch (error) {
        return safeFailure(error);
      }
    },
    async save(
      change: SettingsChange,
      expectedRevision,
      signal,
    ): Promise<Result<SettingsDocument>> {
      if (!validDirectory)
        return failure("invalid-input", "An explicit settings directory is required.");
      if (signal.aborted) return failure("cancelled", "Settings save cancelled.");
      let lock: FileHandle | undefined;
      let temporary: string | undefined;
      try {
        const copied: unknown = JSON.parse(JSON.stringify(change));
        if (
          !record(copied) ||
          !(
            (copied.section === "user" && validUserSettings(copied.value)) ||
            (copied.section === "tui" && validTuiSettings(copied.value))
          )
        )
          return failure("invalid-input", "Invalid settings change.");
        const section = copied.section === "user" ? "user" : "tui";
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if (hasCode(error, "EEXIST"))
            return failure(
              "conflict",
              "Settings are being edited by another writer; retry after it finishes.",
            );
          throw error;
        }
        const original = await sources();
        const current = document(original);
        if (current.revision !== expectedRevision)
          return failure("conflict", "Settings changed externally; reload before saving.");
        const content = updateJsonc(original[section], current[section], copied.value);
        const nextSources = { ...original, [section]: content };
        const nextDocument = document(nextSources);
        temporary = join(directory, `.settings-${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        // The second fingerprint check deliberately occurs after asynchronous save preparation.
        if (revision(await sources()) !== expectedRevision)
          return failure(
            "conflict",
            "Settings changed while preparing the save; reload before saving.",
          );
        if (signal.aborted) return failure("cancelled", "Settings save cancelled.");
        await rename(temporary, paths[section]);
        temporary = undefined;
        // Single-file durability on supported local POSIX filesystems; no cross-file CAS claim.
        const parent = await open(directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        return success(nextDocument);
      } catch (error) {
        return safeFailure(error);
      } finally {
        if (temporary) {
          try {
            await unlink(temporary);
          } catch {
            /* Best effort orphan cleanup. */
          }
        }
        if (lock) {
          try {
            await lock.close();
          } catch {
            /* A lock-handle cleanup error must not reject an expected Result. */
          } finally {
            try {
              await unlink(lockPath);
            } catch {
              /* A stale lock is recoverable explicitly. */
            }
          }
        }
      }
    },
  };
}
