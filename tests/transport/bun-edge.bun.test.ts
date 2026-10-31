import { describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createBunTransport } from "../../src/transport/bun";

const transport = createBunTransport();
const signal = () => new AbortController().signal;

async function listen(handler: (socket: Socket) => void, pauseOnConnect = false) {
  const sockets = new Set<Socket>();
  const server: Server = createServer({ pauseOnConnect }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture missing port");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function open(port: number) {
  const result = await transport.connect(
    { host: "127.0.0.1", port, tls: false, timeoutMs: 2000 },
    signal(),
  );
  if (!result.ok) throw new Error("Local connection failed");
  return result.value;
}

describe("Bun TCP transport edge cases (local only)", () => {
  test("queued writes complete in order once a slow reader drains the socket", async () => {
    let received = 0;
    let reader: Socket | undefined;
    const fixture = await listen((socket) => {
      reader = socket;
      socket.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
      });
      socket.pause();
    }, true);
    try {
      const connection = await open(fixture.port);
      const chunk = 60 * 1024;
      let sent = 0;
      let stalled: Promise<boolean[]> | undefined;
      // Fill the kernel buffers until a bounded batch stops completing, then let the reader drain.
      for (let batch = 0; batch < 400 && !stalled; batch++) {
        const writes = Promise.all(
          Array.from({ length: 15 }, () =>
            connection.write(new Uint8Array(chunk).fill(batch % 256), signal()),
          ),
        ).then((outcomes) => outcomes.map((outcome) => outcome.ok));
        sent += 15 * chunk;
        const done = await Promise.race([
          writes.then(() => true),
          Bun.sleep(100).then(() => false),
        ]);
        if (!done) stalled = writes;
      }
      expect(stalled).toBeDefined();
      reader?.resume();
      expect((await stalled)?.every(Boolean)).toBe(true);
      while (received < sent) await Bun.sleep(5);
      expect(received).toBe(sent);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });
  test("an unread flood beyond the input bound closes the connection with an error", async () => {
    const fixture = await listen((socket) => {
      const block = Buffer.alloc(64 * 1024, 0x61);
      for (let index = 0; index < 40; index++) socket.write(block);
    });
    try {
      const connection = await open(fixture.port);
      await Bun.sleep(100);
      let error: unknown;
      let bytes = 0;
      try {
        for await (const chunk of connection.incoming) bytes += chunk.byteLength;
      } catch (cause) {
        error = cause;
      }
      expect(error instanceof Error && error.message).toContain("overflow");
      expect(bytes).toBeLessThanOrEqual(1024 * 1024);
      const write = await connection.write(new Uint8Array([1]), signal());
      expect(!write.ok && write.error.code).toBe("network");
    } finally {
      await fixture.close();
    }
  });
  test("the incoming stream has exactly one consumer and empty writes succeed", async () => {
    const fixture = await listen(() => {});
    try {
      const connection = await open(fixture.port);
      expect((await connection.write(new Uint8Array(0), signal())).ok).toBe(true);
      const first = connection.incoming[Symbol.asyncIterator]();
      const pending = first.next();
      const second = connection.incoming[Symbol.asyncIterator]();
      await expect(second.next()).rejects.toThrow("one consumer");
      await connection.close();
      expect((await pending).done).toBe(true);
    } finally {
      await fixture.close();
    }
  });
  test("rejects out-of-range ports, timeouts and non-boolean TLS flags before dialing", async () => {
    for (const options of [
      { host: "127.0.0.1", port: 0, tls: false, timeoutMs: 1000 },
      { host: "127.0.0.1", port: 65536, tls: false, timeoutMs: 1000 },
      { host: "127.0.0.1", port: 1, tls: false, timeoutMs: 0 },
      { host: "127.0.0.1", port: 1, tls: false, timeoutMs: 300_001 },
      { host: "", port: 1, tls: false, timeoutMs: 1000 },
      { host: "a".repeat(254), port: 1, tls: false, timeoutMs: 1000 },
      { host: "127.0.0.1", port: 1, tls: "yes" as unknown as boolean, timeoutMs: 1000 },
    ]) {
      const result = await transport.connect(options, signal());
      expect(!result.ok && result.error.code).toBe("invalid-input");
    }
  });
  test("a TLS connection to a peer that closes during the handshake reports a TLS failure", async () => {
    const fixture = await listen((socket) => socket.destroy());
    try {
      const result = await transport.connect(
        { host: "localhost", port: fixture.port, tls: true, timeoutMs: 2000 },
        signal(),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && ["tls", "network"].includes(result.error.code)).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
