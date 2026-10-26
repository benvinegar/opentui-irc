/** Scripted in-memory IRC server for session tests; never opens a socket. */
import { entityId } from "../../../src/contracts/common";
import type { Clock, Result } from "../../../src/contracts/common";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionEvent } from "../../../src/contracts/session";
import type { NetworkProfile, SecretProvider } from "../../../src/contracts/settings";
import type { ByteConnection } from "../../../src/contracts/transport";
import { createIrcCodec } from "../../../src/irc/codec";
import { createSessionFactory, defaultProtocolLimits } from "../../../src/irc/session";
import type { SessionPolicy } from "../../../src/irc/session";

export const networkId = entityId<"network">("network-1");
export const op = (name: string) => entityId<"operation">(name);
export const signal = () => new AbortController().signal;
export const clock: Clock = {
  now: () => Date.now(),
  sleep(ms, abort) {
    return new Promise((resolve, reject) => {
      if (abort.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const cancel = () => {
        clearTimeout(timer);
        abort.removeEventListener("abort", cancel);
        reject(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        abort.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      abort.addEventListener("abort", cancel, { once: true });
    });
  },
};
export const profile: NetworkProfile = {
  id: networkId,
  name: "Fixture",
  endpoints: [{ host: "fixture.invalid", port: 6697, tls: true }],
  identity: { nick: "me", alternateNicks: ["me_"], username: "user", realname: "Fixture user" },
  autoConnect: false,
  autoJoin: [],
};
export const secrets: SecretProvider = {
  async resolve() {
    return { ok: true, value: "fixture-password" };
  },
  async store() {
    return { ok: false, error: { code: "unsupported", message: "Fixture", retryable: false } };
  },
};
const cleanups: (() => Promise<unknown>)[] = [];
/** Register with `afterEach(closeSessions)` in every suite using `harness`. */
export async function closeSessions() {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}
export async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
export async function harness(
  options: {
    capabilities?: string;
    sasl?: NetworkProfile["sasl"];
    tls?: boolean;
    secretProvider?: SecretProvider;
    policy?: Partial<SessionPolicy>;
    autoConsume?: boolean;
    onWrite?: (
      frame: IrcFrame,
      send: (line: string) => void,
    ) => Promise<Result<void> | void> | Result<void> | void;
  } = {},
) {
  let wake: (() => void) | undefined;
  const input: Uint8Array[] = [];
  let ended = false;
  const written: IrcFrame[] = [];
  const events: SessionEvent[] = [];
  const codec = createIrcCodec(defaultProtocolLimits);
  const send = (line: string) => {
    input.push(new TextEncoder().encode(line + "\r\n"));
    wake?.();
    wake = undefined;
  };
  const parent = new AbortController();
  const connection: ByteConnection = {
    incoming: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (input.length) yield input.shift()!;
          else if (ended) return;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      },
    },
    async write(bytes) {
      const result = codec.push(bytes);
      if (!result.ok) return result;
      for (const frame of result.value) {
        written.push(frame);
        const custom = await options.onWrite?.(frame, send);
        if (custom) return custom;
        if (frame.command === "CAP" && frame.params[0] === "LS")
          send(`:s CAP me LS :${options.capabilities ?? ""}`);
        if (frame.command === "CAP" && frame.params[0] === "REQ")
          send(`:s CAP me ACK :${frame.params[1]}`);
        if (frame.command === "AUTHENTICATE") {
          if (frame.params[0] === "PLAIN") send("AUTHENTICATE +");
          else send(":s 903 me :SASL succeeded");
        }
        if (frame.command === "CAP" && frame.params[0] === "END") send(":s 001 me :welcome");
      }
      return { ok: true, value: undefined };
    },
    async close() {
      ended = true;
      wake?.();
      wake = undefined;
      return { ok: true, value: undefined };
    },
  };
  const factory = createSessionFactory({
    transport: {
      async connect() {
        return { ok: true, value: connection };
      },
    },
    secrets: options.secretProvider ?? secrets,
    clock,
    policy: { floodIntervalMs: 0, ...options.policy },
  });
  const opened = await factory.open(
    {
      ...profile,
      endpoints: profile.endpoints.map((endpoint) => ({
        ...endpoint,
        tls: options.tls ?? endpoint.tls,
      })),
      ...(options.sasl ? { sasl: options.sasl } : {}),
    },
    { networkId, generation: 7 },
    parent.signal,
  );
  if (!opened.ok) throw new Error("Fixture open failed");
  const session = opened.value;
  const consumption =
    options.autoConsume === false
      ? undefined
      : (async () => {
          for await (const event of session.events) events.push(event);
        })();
  cleanups.push(async () => {
    await session.close();
    await consumption;
  });
  return { session, written, events, send, parent, consumption, end: () => connection.close() };
}
export const hasReady = (events: SessionEvent[]) =>
  events.some((event) => event.payload.type === "state" && event.payload.phase === "ready");
