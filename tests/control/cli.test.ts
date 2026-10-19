import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseControlCli, runControlCli, type ControlCliOptions } from "../../src/control/cli";
import type {
  ControlRequest,
  ControlResponse,
  JsonObject,
  JsonValue,
} from "../../src/contracts/control";

const profile: JsonObject = {
  id: "net-1",
  name: "Example",
  endpoints: [{ host: "irc.example.test", port: 6697, tls: true }],
  identity: { nick: "alice", alternateNicks: ["alice_"], username: "alice", realname: "Alice" },
  autoConnect: false,
  autoJoin: [{ channel: "#test", key: "env:CHANNEL_KEY" }],
  sasl: { mechanism: "PLAIN", account: "alice", password: "env:SASL", required: true },
};
const otherProfile: JsonObject = { ...profile, id: "net-2", name: "Other" };
const settings: JsonObject = {
  revision: "rev-1",
  user: { networks: [profile, otherProfile], history: { retentionDays: 90 } },
  tui: { theme: "dark" },
};
function success(request: ControlRequest, result: JsonValue = { accepted: true }): ControlResponse {
  return { version: 1, id: request.id, ok: true, result };
}
function failure(
  request: ControlRequest,
  code: "conflict" | "permission-denied" = "conflict",
): ControlResponse {
  return {
    version: 1,
    id: request.id,
    ok: false,
    error: { code, message: "Safe failure.", retryable: false },
  };
}
async function invoke(
  args: readonly string[],
  overrides: Partial<ControlCliOptions> & { useFilesystem?: boolean } = {},
) {
  const lines: string[] = [];
  const calls: ControlRequest[] = [];
  const execute = vi.fn(async (request: ControlRequest) => {
    calls.push(request);
    return success(request, request.method === "config.get" ? settings : { accepted: true });
  });
  let counter = 0;
  const code = await runControlCli(args, {
    execute,
    output: (line) => lines.push(line),
    requestId: () => `request-${++counter}`,
    input: async () => {
      throw new Error("stdin must not be read");
    },
    ...(overrides.useFilesystem
      ? {}
      : {
          read: async () => {
            throw new Error("file must not be read");
          },
        }),
    ...overrides,
  });
  expect(lines).toHaveLength(1);
  const envelope: unknown = JSON.parse(lines[0]!);
  return { code, lines, envelope, calls, execute };
}
function last(calls: ControlRequest[]): ControlRequest {
  return calls[calls.length - 1]!;
}

describe("control CLI parsing and catalog", () => {
  it("is a pure parser with anywhere global JSON and permission intent flags", () => {
    const result = parseControlCli([
      "--json",
      "config",
      "--config-dir=/tmp/private",
      "get",
      "--allow-read",
      "--allow-send",
      "--allow-destructive",
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        configDirectory: "/tmp/private",
        command: ["config", "get"],
        permissions: [
          "inspect",
          "configure",
          "network",
          "read-messages",
          "send-messages",
          "destructive",
        ],
      },
    });
  });
  it.each([
    [],
    ["unknown"],
    ["config", "apply"],
    ["status", "--file", "secret"],
    ["status", "--json=false"],
    ["status", "--config-dir"],
    ["status", "--json", "--json"],
    ["config", "apply", "--file", "edit.json", "--stdin"],
    ["secrets", "store", "password"],
    ["secrets", "store", "--file", "password.txt"],
    ["secrets", "store"],
    ["conversations", "mute", "c", "maybe"],
    ["networks", "add", "--host", "irc.example.test"],
    ["action", "--file", "x", "--expected-revision", "r"],
  ])("rejects malformed arguments with one sanitized JSON failure: %j", async (...args) => {
    const { code, envelope, calls } = await invoke(args);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ version: 1, ok: false, error: { code: "invalid-input" } });
    expect(calls).toEqual([]);
  });
  it("does not echo user-controlled arguments, input failures, or oversized argv", async () => {
    for (const args of [
      ["--password=hunter2"],
      ["config", "apply", "--file", "hunter2"],
      ["x".repeat(1024 * 1024 + 1)],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.lines[0]).not.toContain("hunter2");
    }
  });
  it("provides stable machine-readable help without calling the server", async () => {
    const a = await invoke(["--help"]);
    const b = await invoke(["help"]);
    expect(a.envelope).toEqual(b.envelope);
    expect(a.envelope).toMatchObject({
      version: 1,
      ok: true,
      result: {
        protocolVersion: 1,
        permissionIntentOnly: true,
        limits: { jsonInputBytes: 1048576, secretInputBytes: 65536 },
      },
    });
    expect(a.calls).toEqual([]);
    expect(a.lines[0]).toContain("exactly one final LF or CRLF");
  });
});

describe("command mappings and injected execution", () => {
  it.each([
    [["status"], "status"],
    [["capabilities"], "capabilities"],
    [["config", "schema"], "config.schema"],
    [["config", "get"], "config.get"],
    [["networks", "list"], "networks.list"],
    [["conversations", "list"], "conversations.list"],
    [["operations"], "operations.list"],
    [["operations", "list"], "operations.list"],
  ])("maps %j to %s without prerequisite I/O", async (args, method) => {
    const result = await invoke(args);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(last(result.calls)).toMatchObject({
      method,
      params: {},
      permissions: ["inspect", "configure", "network"],
    });
  });
  it("passes config directory and the same abort signal to every executor call", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (request: ControlRequest) =>
      success(request, request.method === "config.get" ? settings : null),
    );
    const result = await invoke(
      ["networks", "connect", "Example", "--config-dir", "/tmp/profile"],
      { execute, signal: controller.signal },
    );
    expect(result.code).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const call of execute.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({ version: 1 }),
        controller.signal,
        { configDirectory: "/tmp/profile" },
      ]);
    }
  });
  it.each(["connect", "disconnect", "reconnect"])(
    "resolves a network selector before %s",
    async (verb) => {
      const result = await invoke(["networks", verb, "Example"]);
      expect(result.calls.map((request) => request.method)).toEqual([
        "config.get",
        "action.dispatch",
      ]);
      expect(last(result.calls).params).toEqual({
        action: { type: `network.${verb}`, networkId: "net-1" },
      });
    },
  );
  it("maps join, direct query, conversation actions and discovery", async () => {
    const cases = [
      {
        args: ["channels", "join", "net-1", "#test", "--key", "env:KEY"],
        params: {
          action: {
            type: "conversation.join",
            networkId: "net-1",
            channel: "#test",
            key: "env:KEY",
          },
        },
      },
      {
        args: ["conversations", "query", "Example", "bob"],
        params: { action: { type: "conversation.query", networkId: "net-1", nick: "bob" } },
      },
      {
        args: ["conversations", "activate", "c"],
        params: { action: { type: "conversation.activate", conversationId: "c" } },
      },
      {
        args: ["conversations", "close", "c"],
        params: { action: { type: "conversation.close", conversationId: "c" } },
      },
      {
        args: ["conversations", "mute", "c"],
        params: { action: { type: "conversation.mute", conversationId: "c", muted: true } },
      },
      {
        args: ["conversations", "mute", "c", "false"],
        params: { action: { type: "conversation.mute", conversationId: "c", muted: false } },
      },
      {
        args: ["conversations", "mute", "c", "--unmute"],
        params: { action: { type: "conversation.mute", conversationId: "c", muted: false } },
      },
      { args: ["discovery", "get", "Example"], params: { networkId: "net-1" } },
    ];
    for (const item of cases) {
      const result = await invoke(item.args);
      expect(result.code).toBe(0);
      expect(last(result.calls).params).toEqual(item.params);
    }
  });
  it("maps bounded search parameters and timeline only with read intent", async () => {
    const search = await invoke([
      "history",
      "search",
      "--text",
      "private search",
      "--network",
      "Example",
      "--conversation",
      "c",
      "--sender",
      "bob",
      "--after",
      "100",
      "--before",
      "200",
      "--cursor",
      "cursor",
      "--limit",
      "10",
      "--allow-read",
    ]);
    expect(last(search.calls)).toMatchObject({
      method: "history.search",
      params: {
        text: "private search",
        networkId: "net-1",
        conversationId: "c",
        sender: "bob",
        after: 100,
        before: 200,
        cursor: "cursor",
        limit: 10,
      },
      permissions: ["inspect", "configure", "network", "read-messages"],
    });
    const timeline = await invoke(["timeline", "get", "c", "--allow-read"]);
    expect(last(timeline.calls)).toMatchObject({
      method: "timeline.get",
      params: { conversationId: "c" },
    });
    for (const args of [
      ["timeline", "get", "c"],
      ["history", "search", "--text", "private search"],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.lines[0]).not.toContain("private search");
      expect(result.envelope).toMatchObject({ ok: false, error: { code: "permission-denied" } });
    }
  });
  it.each(["-1", "0", "1.5", "NaN", "9007199254740992"])(
    "rejects invalid search limits %s",
    async (value) => {
      const result = await invoke([
        "history",
        "search",
        "--text",
        "sensitive",
        "--limit",
        value,
        "--allow-read",
      ]);
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.lines[0]).not.toContain("sensitive");
    },
  );
  it("dispatches file JSON actions without implementing or echoing their content", async () => {
    const action = {
      type: "message.send",
      conversationId: "c",
      text: "private body",
      kind: "text",
    };
    const read = vi.fn(async () => JSON.stringify(action));
    const result = await invoke(["action", "--file", "action.json", "--allow-send"], { read });
    expect(read).toHaveBeenCalledWith("action.json");
    expect(last(result.calls)).toMatchObject({
      method: "action.dispatch",
      params: { action },
      permissions: ["inspect", "configure", "network", "send-messages"],
    });
    expect(result.lines[0]).not.toContain("private body");
  });
  it("cannot grant server policy and preserves safe permission failure", async () => {
    const result = await invoke(["timeline", "get", "c", "--allow-read"], {
      execute: async (request) => failure(request, "permission-denied"),
    });
    expect(result.code).toBe(1);
    expect(result.envelope).toMatchObject({ error: { code: "permission-denied" } });
  });
  it("requires both destructive intent and confirmation for shutdown", async () => {
    for (const args of [
      ["shutdown"],
      ["shutdown", "--confirm"],
      ["shutdown", "--allow-destructive"],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
    const result = await invoke(["shutdown", "--allow-destructive", "--confirm"]);
    expect(last(result.calls)).toMatchObject({
      method: "app.shutdown",
      params: { confirm: true },
      permissions: ["inspect", "configure", "network", "destructive"],
    });
  });
});

describe("config and full-profile convenience flow", () => {
  it("gets a revision then applies a JSON section patch with one output envelope", async () => {
    const edit = { section: "tui", patch: { theme: "light" }, unset: ["keybindings.custom"] };
    const result = await invoke(["config", "apply", "--file", "edit.json"], {
      read: async () => JSON.stringify(edit),
    });
    expect(result.code).toBe(0);
    expect(result.calls.map((call) => call.method)).toEqual(["config.get", "config.apply"]);
    expect(last(result.calls).params).toEqual({ edit, expectedRevision: "rev-1" });
    expect(result.lines[0]).not.toContain("env:SASL");
  });
  it.each(["--stdin", "--file=-"])("supports JSON edit stdin through %s", async (flag) => {
    const result = await invoke(["config", "plan", flag, "--expected-revision", "explicit"], {
      input: async () => JSON.stringify({ section: "tui", value: { theme: "light" } }),
    });
    expect(result.calls).toHaveLength(1);
    expect(last(result.calls)).toMatchObject({
      method: "config.plan",
      params: { expectedRevision: "explicit", edit: { section: "tui", value: { theme: "light" } } },
    });
  });
  it("turns apply --dry-run into plan and never applies or silently rebases an explicit revision", async () => {
    const result = await invoke(
      ["config", "apply", "--stdin", "--dry-run", "--expected-revision", "old"],
      { input: async () => '{"section":"tui","patch":{"theme":"light"}}' },
    );
    expect(result.calls.map((call) => call.method)).toEqual(["config.plan"]);
    expect(last(result.calls).params.expectedRevision).toBe("old");
  });
  it("patches JSON scalar values including literal null and forwards destructive intent only explicitly", async () => {
    const theme = await invoke(["config", "set", "tui.theme", '"light"']);
    expect(last(theme.calls).params).toEqual({
      edit: { section: "tui", patch: { theme: "light" } },
      expectedRevision: "rev-1",
    });
    const retention = await invoke([
      "config",
      "set",
      "user.history.retentionDays",
      "null",
      "--allow-destructive",
      "--confirm",
    ]);
    expect(last(retention.calls)).toMatchObject({
      params: {
        edit: { section: "user", patch: { history: { retentionDays: null } } },
        expectedRevision: "rev-1",
        confirm: true,
      },
      permissions: ["inspect", "configure", "network", "destructive"],
    });
    const noConfirm = await invoke(["config", "set", "user.history.retentionDays", "7"]);
    expect(last(noConfirm.calls).params).not.toHaveProperty("confirm");
    expect(last(noConfirm.calls).permissions).not.toContain("destructive");
  });
  it("preserves full profiles and all untouched fields while replacing a profile by ID", async () => {
    const updated = { ...profile, name: "Updated", autoConnect: true };
    const result = await invoke(
      ["networks", "update", "Example", "--file", "profile.json", "--expected-revision", "old"],
      { read: async () => JSON.stringify(updated) },
    );
    expect(result.calls.map((call) => call.method)).toEqual(["config.get", "config.apply"]);
    expect(last(result.calls).params).toEqual({
      edit: { section: "user", patch: { networks: [updated, otherProfile] } },
      expectedRevision: "old",
    });
  });
  it("constructs a safe optional profile from explicit host/nick with no implicit auto-connect", async () => {
    const result = await invoke([
      "networks",
      "add",
      "--id",
      "new",
      "--name",
      "New",
      "--host",
      "irc.example.test",
      "--nick",
      "bob",
    ]);
    expect(last(result.calls).params).toEqual({
      edit: {
        section: "user",
        patch: {
          networks: [
            profile,
            otherProfile,
            {
              id: "new",
              name: "New",
              endpoints: [{ host: "irc.example.test", port: 6697, tls: true }],
              identity: { nick: "bob", alternateNicks: [], username: "bob", realname: "bob" },
              autoConnect: false,
              autoJoin: [],
            },
          ],
        },
      },
      expectedRevision: "rev-1",
    });
    const plaintext = await invoke([
      "networks",
      "add",
      "--id",
      "new",
      "--name",
      "New",
      "--host",
      "irc.example.test",
      "--nick",
      "bob",
      "--no-tls",
      "--port",
      "7000",
      "--auto-connect",
    ]);
    expect(JSON.stringify(last(plaintext.calls).params)).toContain('"port":7000,"tls":false');
    expect(JSON.stringify(last(plaintext.calls).params)).toContain('"autoConnect":true');
  });
  it("adds full file profiles and removes profiles while preserving others", async () => {
    const added = { ...profile, id: "new" };
    const result = await invoke(["networks", "add", "--file", "new.json"], {
      read: async () => JSON.stringify(added),
    });
    expect(last(result.calls).params).toMatchObject({
      edit: { patch: { networks: [profile, otherProfile, added] } },
    });
    const removed = await invoke(["networks", "remove", "Example", "--dry-run", "--confirm"]);
    expect(last(removed.calls)).toMatchObject({
      method: "config.plan",
      params: { edit: { patch: { networks: [otherProfile] } }, confirm: true },
    });
  });
  it("fails ambiguous display names, but gives exact IDs precedence", async () => {
    const duplicate = { ...otherProfile, name: "Example" };
    const execute = vi.fn(async (request: ControlRequest) =>
      success(
        request,
        request.method === "config.get"
          ? { ...settings, user: { networks: [profile, duplicate] } }
          : null,
      ),
    );
    const ambiguous = await invoke(["networks", "remove", "Example"], { execute });
    expect(ambiguous.code).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const exact = await invoke(["networks", "connect", "net-1"], { execute });
    expect(exact.code).toBe(0);
    const missing = await invoke(["networks", "connect", "missing"], { execute });
    expect(missing.code).toBe(1);
  });
  it("rejects duplicate profile IDs and replacement ID changes without submitting a save", async () => {
    for (const args of [
      ["networks", "add", "--stdin"],
      ["networks", "update", "Other", "--stdin"],
    ]) {
      const result = await invoke(args, { input: async () => JSON.stringify(profile) });
      expect(result.code).toBe(1);
      expect(result.calls.map((call) => call.method)).toEqual(["config.get"]);
    }
  });
  it("does not rebase or retry a revision conflict", async () => {
    const calls: ControlRequest[] = [];
    const result = await invoke(["networks", "remove", "Example", "--expected-revision", "stale"], {
      execute: async (request) => {
        calls.push(request);
        return request.method === "config.get" ? success(request, settings) : failure(request);
      },
    });
    expect(result.code).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(["config.get", "config.apply"]);
    expect(last(calls).params.expectedRevision).toBe("stale");
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("stops when config.get fails or returns malformed data", async () => {
    for (const execute of [
      async (request: ControlRequest) => failure(request),
      async (request: ControlRequest) => success(request, {}),
    ]) {
      const result = await invoke(["config", "set", "tui.theme", '"light"'], { execute });
      expect(result.code).toBe(1);
      expect(result.envelope).toMatchObject({ ok: false });
    }
  });
  it("reload --dry-run only inspects disk once without reading the live config", async () => {
    const inspect = await invoke(["config", "reload", "--dry-run"]);
    expect(inspect.code).toBe(0);
    expect(inspect.calls).toHaveLength(1);
    expect(last(inspect.calls)).toMatchObject({
      method: "config.reload",
      params: { dryRun: true },
    });
  });
  it.each([
    { revision: "disk-rev", liveRevision: "live-rev", plans: [] },
    { applied: false, revision: "disk-rev", mode: "offline" },
  ])("inspects reload disk revision then applies that exact revision: %j", async (result) => {
    const calls: ControlRequest[] = [];
    const reloaded = await invoke(["config", "reload", "--confirm"], {
      execute: async (request) => {
        calls.push(request);
        return success(request, request.params.dryRun === true ? result : { applied: true });
      },
    });
    expect(reloaded.code).toBe(0);
    expect(calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "config.reload", params: { dryRun: true } },
      {
        method: "config.reload",
        params: { dryRun: false, expectedRevision: "disk-rev", confirm: true },
      },
    ]);
  });
  it.each([false, true])(
    "preserves explicit reload revision without an extra inspect (dry-run=%s)",
    async (dryRun) => {
      const calls: ControlRequest[] = [];
      const apply = await invoke(
        [
          "config",
          "reload",
          "--expected-revision",
          "explicit",
          "--confirm",
          ...(dryRun ? ["--dry-run"] : []),
        ],
        {
          execute: async (request) => {
            calls.push(request);
            return failure(request);
          },
        },
      );
      expect(apply.code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(last(calls).params).toEqual({ dryRun, expectedRevision: "explicit", confirm: true });
      expect(apply.envelope).toMatchObject({ error: { code: "conflict" } });
    },
  );
  it("does not retry reload if the disk changes after inspection", async () => {
    const calls: ControlRequest[] = [];
    const result = await invoke(["config", "reload"], {
      execute: async (request) => {
        calls.push(request);
        return request.params.dryRun === true
          ? success(request, { revision: "disk-rev" })
          : failure(request);
      },
    });
    expect(result.code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(last(calls).params).toEqual({ dryRun: false, expectedRevision: "disk-rev" });
    expect(result.envelope).toMatchObject({ error: { code: "conflict" } });
  });
  it("does not apply after reload inspection fails or has no valid revision", async () => {
    for (const reply of [null, {}, { revision: 1 }, { revision: "" }, "failure"]) {
      const execute = vi.fn(async (request: ControlRequest) =>
        reply === "failure" ? failure(request) : success(request, reply),
      );
      const result = await invoke(["config", "reload"], { execute });
      expect(result.code).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.envelope).toMatchObject({
        error: { code: reply === "failure" ? "conflict" : "protocol" },
      });
    }
  });
  it("does not apply reload if cancelled after inspection", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (request: ControlRequest) => {
      controller.abort();
      return success(request, { revision: "disk-rev" });
    });
    const result = await invoke(["config", "reload"], { execute, signal: controller.signal });
    expect(result.code).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.envelope).toMatchObject({ error: { code: "cancelled" } });
  });
});

describe("bounded input, secret ingress and safe failures", () => {
  it.each(["password\n", "password\r\n", "password", "password\n\n"])(
    "strips exactly one trailing secret newline: %j",
    async (input) => {
      const result = await invoke(["secrets", "store", "--stdin"], {
        input: async () => input,
        execute: async (request) => {
          expect(request.method).toBe("secrets.store");
          expect(request.params.value).toBe(input === "password\n\n" ? "password\n" : "password");
          return success(request, "keychain:reference");
        },
      });
      expect(result.code).toBe(0);
      expect(result.lines[0]).not.toContain("password");
      expect(result.envelope).toMatchObject({ ok: true, result: "keychain:reference" });
    },
  );
  it("enforces secret byte limits before stripping newlines and never logs raw exceptions", async () => {
    for (const input of ["", "\n", "\r\n", "a".repeat(65537), "é".repeat(32769)]) {
      const result = await invoke(["secrets", "store", "--stdin"], { input: async () => input });
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
    const result = await invoke(["secrets", "store", "--stdin"], {
      input: async () => {
        throw new Error("SECRET");
      },
    });
    expect(result.lines[0]).not.toContain("SECRET");
    const exact = await invoke(["secrets", "store", "--stdin"], {
      input: async () => "a".repeat(65536),
    });
    expect(exact.code).toBe(0);
  });
  it.each([
    '{"section":"tui","patch": invalid-private-body}',
    '{"section":"tui","patch":{"__proto__":{"polluted":true}}}',
    '{"constructor":{}}',
    "[1,2]",
    "null",
  ])("rejects malformed or unsafe JSON without echoing it: %s", async (input) => {
    const result = await invoke(["config", "apply", "--stdin"], { input: async () => input });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.lines[0]).not.toContain("private-body");
    expect({}).not.toHaveProperty("polluted");
  });
  it("rejects dangerous convenience paths without fetching configuration", async () => {
    for (const path of ["tui.__proto__.x", "user.constructor.x", "tui", "unknown.theme"]) {
      const result = await invoke(["config", "set", path, "null"]);
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });
  it("bounds injected file and stdin JSON in UTF-8 bytes", async () => {
    const huge = JSON.stringify({ section: "tui", patch: { theme: "é".repeat(524288) } });
    for (const args of [
      ["config", "apply", "--stdin"],
      ["config", "apply", "--file", "large.json"],
    ]) {
      const result = await invoke(args, { input: async () => huge, read: async () => huge });
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.envelope).toMatchObject({ error: { code: "invalid-input" } });
    }
  });
  it("bounds the default filesystem reader and safely handles file errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openirc-control-cli-"));
    try {
      const path = join(directory, "edit.json");
      await writeFile(path, JSON.stringify({ section: "tui", patch: { theme: "light" } }));
      const small = await invoke(["config", "apply", "--file", path], { useFilesystem: true });
      expect(small.code).toBe(0);
      await writeFile(path, "x".repeat(1048577));
      const huge = await invoke(["config", "apply", "--file", path], { useFilesystem: true });
      expect(huge.code).toBe(1);
      expect(huge.calls).toEqual([]);
      const folder = await invoke(["action", "--file", directory], { useFilesystem: true });
      expect(folder.code).toBe(1);
      const fifoPath = join(directory, "input.fifo");
      execFileSync("mkfifo", [fifoPath]);
      const fifo = await invoke(["action", "--file", fifoPath], { useFilesystem: true });
      expect(fifo.code).toBe(1);
      expect(fifo.calls).toEqual([]);
      const missing = await invoke(["action", "--file", join(directory, "SECRET-FILENAME")], {
        useFilesystem: true,
      });
      expect(missing.code).toBe(1);
      expect(missing.lines[0]).not.toContain("SECRET-FILENAME");
      await writeFile(path, Buffer.from([0xff, 0xfe]));
      const invalidUtf8 = await invoke(["action", "--file", path], { useFilesystem: true });
      expect(invalidUtf8.code).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("respects pre-aborted signals without reading or submitting", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = vi.fn(async () => "password");
    const result = await invoke(["secrets", "store", "--stdin"], {
      signal: controller.signal,
      input,
    });
    expect(result.code).toBe(1);
    expect(result.envelope).toMatchObject({ error: { code: "cancelled" } });
    expect(input).not.toHaveBeenCalled();
    expect(result.calls).toEqual([]);
  });
  it("does not submit if cancelled during input", async () => {
    const controller = new AbortController();
    const result = await invoke(["secrets", "store", "--stdin"], {
      signal: controller.signal,
      input: async () => {
        controller.abort();
        return "password";
      },
    });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.lines[0]).not.toContain("password");
  });
  it("sanitizes executor exceptions as unknown outcome and never retries", async () => {
    const execute = vi.fn(async () => {
      throw new Error("password/private body/stack");
    });
    const result = await invoke(["status"], { execute });
    expect(result.code).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { outcome: "unknown", code: "unavailable" },
    });
    expect(result.lines[0]).not.toContain("password");
    expect(result.lines[0]).not.toContain("stack");
  });
});
