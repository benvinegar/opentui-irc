import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runControlCli } from "../../src/control/cli";
import type {
  ControlRequest,
  ControlResponse,
  JsonObject,
  JsonValue,
} from "../../src/contracts/control";
import { parseCli } from "../../src/cli";

const kept: JsonObject = {
  id: "kept",
  name: "Kept",
  endpoints: [{ host: "irc.example.test", port: 6697, tls: true }],
  identity: { nick: "alice", alternateNicks: [], username: "alice", realname: "Alice" },
  autoConnect: false,
  autoJoin: [],
};
const removed: JsonObject = { ...kept, id: "removed", name: "Removed" };

async function invoke(args: readonly string[], config: JsonValue, useStdin = false) {
  const lines: string[] = [];
  const calls: ControlRequest[] = [];
  const execute = vi.fn(async (request: ControlRequest): Promise<ControlResponse> => {
    calls.push(request);
    return {
      version: 1,
      id: request.id,
      ok: true,
      result: request.method === "config.get" ? config : { accepted: true },
    };
  });
  let counter = 0;
  const code = await runControlCli(args, {
    execute,
    output: (line) => lines.push(line),
    requestId: () => `edge-${++counter}`,
    read: async () => {
      throw new Error("file must not be read");
    },
    ...(useStdin
      ? {}
      : {
          input: async () => {
            throw new Error("stdin must not be read");
          },
        }),
  });
  expect(lines).toHaveLength(1);
  const envelope: unknown = JSON.parse(lines[0]!);
  return { code, envelope, calls, line: lines[0]! };
}
async function withStdin(input: PassThrough, test: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  try {
    await test();
  } finally {
    Object.defineProperty(process, "stdin", descriptor);
    input.destroy();
  }
}

describe("control CLI configuration edges", () => {
  it("prunes history exclusions that name a removed profile and keeps the rest", async () => {
    const exclusions = [
      { networkId: "kept", kind: "channel", name: "#quiet" },
      { networkId: "removed", kind: "channel", name: "#gone" },
    ];
    const result = await invoke(["networks", "remove", "Removed"], {
      revision: "rev-1",
      user: { networks: [kept, removed], history: { excludedConversations: exclusions } },
      tui: {},
    });
    expect(result.code).toBe(0);
    expect(result.calls.at(-1)).toMatchObject({
      method: "config.apply",
      params: {
        edit: {
          section: "user",
          patch: { networks: [kept], history: { excludedConversations: [exclusions[0]] } },
        },
        expectedRevision: "rev-1",
      },
    });
  });
  it("refuses to save when the live configuration has malformed profiles or exclusions", async () => {
    for (const user of [
      { networks: [kept, "not-a-profile"] },
      { networks: [kept, { id: 7, name: "Bad" }] },
      { networks: "nope" },
      { networks: [kept, removed], history: { excludedConversations: "nope" } },
      { networks: [kept, removed], history: { excludedConversations: [{ networkId: 1 }] } },
    ]) {
      const result = await invoke(["networks", "remove", "Removed"], {
        revision: "rev-1",
        user,
        tui: {},
      });
      expect(result.code, JSON.stringify(user)).toBe(1);
      expect(result.envelope).toMatchObject({ ok: false, error: { code: "protocol" } });
      expect(result.calls.map((call) => call.method)).toEqual(["config.get"]);
    }
  });
});

describe("control CLI stdin edges", () => {
  it("fails without sending when stdin is already closed", async () => {
    const input = new PassThrough();
    input.destroy();
    await withStdin(input, async () => {
      const result = await invoke(["secrets", "store", "--stdin"], null, true);
      expect(result.code).toBe(1);
      expect(result.envelope).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(result.calls).toEqual([]);
    });
  });
  it("reads an already-ended stdin as empty input and never submits an empty credential", async () => {
    const input = new PassThrough();
    input.end();
    input.resume();
    await once(input, "end");
    await withStdin(input, async () => {
      const result = await invoke(["secrets", "store", "--stdin"], null, true);
      expect(result.code).toBe(1);
      expect(result.envelope).toMatchObject({ ok: false });
      expect(result.calls).toEqual([]);
    });
  });
});

describe("application CLI options", () => {
  it("rejects unknown options instead of ignoring them", () => {
    expect(parseCli(["--frobnicate"], {}, "/home/test", "linux")).toMatchObject({ ok: false });
    expect(parseCli(["--control-allow", "root"], {}, "/home/test", "linux")).toMatchObject({
      ok: false,
    });
  });
  it("uses an explicit data directory without changing the config directory", () => {
    expect(parseCli(["--data-dir", "/srv/irc-data"], {}, "/home/test", "linux")).toMatchObject({
      ok: true,
      value: { configDirectory: "/home/test/.config/openirc", dataDirectory: "/srv/irc-data" },
    });
  });
});
