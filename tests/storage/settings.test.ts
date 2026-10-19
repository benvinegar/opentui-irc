import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityId, type Result } from "../../src/contracts/common";
import {
  createSettingsRepository,
  defaultTuiSettings,
  defaultUserSettings,
} from "../../src/storage/settings";

const hooks = vi.hoisted(() => ({
  preparing: undefined as (() => Promise<void>) | undefined,
  failWrite: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
        await hooks.preparing?.();
        if (hooks.failWrite) throw new Error("sensitive platform error");
      }
      return actual.open(...args);
    },
  };
});
const signal = new AbortController().signal;
const directories: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "openirc-settings-"));
  directories.push(directory);
  return { directory, repository: createSettingsRepository(directory) };
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Unexpected safe error: ${result.error.code}`);
  return result.value;
}
afterEach(async () => {
  hooks.preparing = undefined;
  hooks.failWrite = false;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("JSONC settings", () => {
  test("missing files give schema-v1 onboarding defaults without creating files", async () => {
    const { directory, repository } = await setup();
    const loaded = value(await repository.load(signal));
    expect(loaded.user.networks).toEqual([]);
    expect(loaded.user.history).toEqual({
      enabled: true,
      retentionDays: 30,
      excludedConversations: [],
      persistDrafts: false,
    });
    expect(await readdir(directory)).toEqual([]);
    expect(value(await repository.load(signal)).revision).toBe(loaded.revision);
  });

  test("atomic single-section saves preserve JSONC comments and restrictive file permissions", async () => {
    const { directory, repository } = await setup();
    const source = `// user heading\n${JSON.stringify(defaultUserSettings(), null, 2).replace('"enabled": true', '"enabled": true, // keep history comment').replace("true, // keep history comment,", "true, // keep history comment")}`;
    await writeFile(join(directory, "openirc.jsonc"), source);
    await writeFile(
      join(directory, "tui.jsonc"),
      `// theme heading\n${JSON.stringify(defaultTuiSettings(), null, 2).replace('"theme": "dark",', '"theme": "dark", // theme choice')}`,
    );
    const loaded = value(await repository.load(signal));
    const saved = value(
      await repository.save(
        {
          section: "user",
          value: { ...loaded.user, history: { ...loaded.user.history, retentionDays: 60 } },
        },
        loaded.revision,
        signal,
      ),
    );
    expect(saved.user.history.retentionDays).toBe(60);
    expect(saved.revision).not.toBe(loaded.revision);
    const persisted = await readFile(join(directory, "openirc.jsonc"), "utf8");
    expect(persisted).toContain("// user heading");
    expect(persisted).toContain("// keep history comment");
    expect((await stat(join(directory, "openirc.jsonc"))).mode & 0o777).toBe(0o600);
    const tuiBefore = await readFile(join(directory, "tui.jsonc"), "utf8");
    expect(tuiBefore).toContain("// theme choice");
    const theme = value(
      await repository.save(
        { section: "tui", value: { ...saved.tui, theme: "light" } },
        saved.revision,
        signal,
      ),
    );
    expect(theme.tui.theme).toBe("light");
    expect(await readFile(join(directory, "tui.jsonc"), "utf8")).toContain("// theme choice");
    expect((await readdir(directory)).sort()).toEqual(["openirc.jsonc", "tui.jsonc"]);
  });

  test("revision covers both files, including comment-only edits", async () => {
    const { directory, repository } = await setup();
    const loaded = value(await repository.load(signal));
    await writeFile(
      join(directory, "tui.jsonc"),
      `// external\n${JSON.stringify(defaultTuiSettings())}`,
    );
    const result = await repository.save(
      { section: "user", value: loaded.user },
      loaded.revision,
      signal,
    );
    expect(result.ok ? null : result.error.code).toBe("conflict");
    expect(await readdir(directory)).toEqual(["tui.jsonc"]);
  });

  test("detects external edits during asynchronous save preparation without overwriting either file", async () => {
    const { directory, repository } = await setup();
    const loaded = value(await repository.load(signal));
    hooks.preparing = async () => {
      await writeFile(
        join(directory, "tui.jsonc"),
        JSON.stringify({ ...defaultTuiSettings(), theme: "light" }),
      );
    };
    const result = await repository.save(
      { section: "user", value: loaded.user },
      loaded.revision,
      signal,
    );
    expect(result.ok ? null : result.error.code).toBe("conflict");
    expect((await readdir(directory)).sort()).toEqual(["tui.jsonc"]);
    expect(value(await repository.load(signal)).tui.theme).toBe("light");
  });

  test("cooperating writer lock prevents replacement and failed preparation leaves original intact", async () => {
    const { directory, repository } = await setup();
    const loaded = value(await repository.load(signal));
    await writeFile(join(directory, ".settings.lock"), "");
    const busy = await repository.save(
      { section: "user", value: loaded.user },
      loaded.revision,
      signal,
    );
    expect(busy.ok ? null : busy.error.code).toBe("conflict");
    await rm(join(directory, ".settings.lock"));
    hooks.failWrite = true;
    const failed = await repository.save(
      { section: "user", value: loaded.user },
      loaded.revision,
      signal,
    );
    expect(failed.ok ? null : failed.error.code).toBe("storage");
    expect(JSON.stringify(failed)).not.toContain("sensitive");
    expect(await readdir(directory)).toEqual([]);
    hooks.failWrite = false;
    expect(
      (await repository.save({ section: "user", value: loaded.user }, loaded.revision, signal)).ok,
    ).toBe(true);
  });

  test("rejects malformed schemas, plaintext secrets, duplicate IDs/shortcuts, invalid ports and SASL without TLS", async () => {
    const { directory, repository } = await setup();
    const network = {
      id: "n",
      name: "Example",
      endpoints: [{ host: "irc.example.test", port: 6697, tls: true }],
      identity: { nick: "tester", alternateNicks: [], username: "tester", realname: "Test" },
      autoConnect: false,
      autoJoin: [],
      sasl: { mechanism: "PLAIN", account: "tester", password: "env:OPENIRC_TEST", required: true },
    };
    const badUsers: unknown[] = [
      { schemaVersion: 1 },
      { ...defaultUserSettings(), password: "never store this" },
      { ...defaultUserSettings(), history: { ...defaultUserSettings().history, retentionDays: 0 } },
      { ...defaultUserSettings(), networks: [network, network] },
      {
        ...defaultUserSettings(),
        networks: [{ ...network, endpoints: [{ host: "irc.example.test", port: 0, tls: true }] }],
      },
      {
        ...defaultUserSettings(),
        networks: [
          { ...network, endpoints: [{ host: "irc.example.test", port: 6667, tls: false }] },
        ],
      },
      { ...defaultUserSettings(), networks: [{ ...network, serverPassword: "plaintext" }] },
    ];
    for (const bad of badUsers) {
      await writeFile(join(directory, "openirc.jsonc"), JSON.stringify(bad));
      const result = await repository.load(signal);
      expect(result.ok ? null : result.error.code).toBe("invalid-input");
      expect(JSON.stringify(result)).not.toContain("never store this");
    }
    await writeFile(
      join(directory, "openirc.jsonc"),
      JSON.stringify({ ...defaultUserSettings(), networks: [network] }),
    );
    expect((await repository.load(signal)).ok).toBe(true);
    await writeFile(
      join(directory, "tui.jsonc"),
      JSON.stringify({
        ...defaultTuiSettings(),
        keybindings: { one: ["ctrl+x"], two: ["CTRL+X"] },
      }),
    );
    expect((await repository.load(signal)).ok).toBe(false);
    await writeFile(join(directory, "tui.jsonc"), "/* malformed");
    expect((await repository.load(signal)).ok).toBe(false);
  });

  test("accepts trailing commas, rejects oversized files and observes cancellation without writes", async () => {
    const { directory, repository } = await setup();
    await writeFile(
      join(directory, "openirc.jsonc"),
      JSON.stringify(defaultUserSettings()).replace(/\}$/u, ",}"),
    );
    expect((await repository.load(signal)).ok).toBe(true);
    const loaded = value(await repository.load(signal));
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (
        await repository.save(
          { section: "user", value: loaded.user },
          loaded.revision,
          aborted.signal,
        )
      ).ok,
    ).toBe(false);
    expect((await repository.load(aborted.signal)).ok).toBe(false);
    const invalidSave = await repository.save(
      { section: "tui", value: { ...loaded.tui, sidebarWidth: 1 } },
      entityId("revision"),
      signal,
    );
    expect(invalidSave.ok ? null : invalidSave.error.code).toBe("invalid-input");
    await writeFile(join(directory, "tui.jsonc"), " ".repeat(1024 * 1024 + 1));
    expect((await repository.load(signal)).ok).toBe(false);
  });
});
