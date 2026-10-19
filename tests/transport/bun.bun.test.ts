import { describe, expect, test } from "bun:test";
import { createBunTransport } from "../../src/transport/bun";

const transport = createBunTransport();
const connect = (port: number, signal = new AbortController().signal) =>
  transport.connect({ host: "127.0.0.1", port, tls: false, timeoutMs: 1000 }, signal);
describe("Bun TCP transport (local only)", () => {
  test("receives owned chunks, writes in order, EOF and repeated close", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, bytes) {
          socket.write(bytes);
        },
      },
    });
    try {
      const result = await connect(listener.port);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const connection = result.value;
      const iterator = connection.incoming[Symbol.asyncIterator]();
      const data = new TextEncoder().encode("hello 🐈");
      expect((await connection.write(data, new AbortController().signal)).ok).toBe(true);
      data.fill(0);
      const first = await iterator.next();
      expect(new TextDecoder().decode(first.value)).toBe("hello 🐈");
      expect((await connection.close()).ok).toBe(true);
      expect((await connection.close()).ok).toBe(true);
      expect((await iterator.next()).done).toBe(true);
    } finally {
      listener.stop(true);
    }
  });
  test("EOF unblocks pending reads", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {},
      },
    });
    try {
      const result = await connect(listener.port);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect((await result.value.incoming[Symbol.asyncIterator]().next()).done).toBe(true);
    } finally {
      listener.stop(true);
    }
  });
  test("lifetime abort terminates read and future writes", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const controller = new AbortController();
    try {
      const result = await connect(listener.port, controller.signal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const pending = result.value.incoming[Symbol.asyncIterator]().next();
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      expect((await result.value.write(new Uint8Array([1]), controller.signal)).ok).toBe(false);
      await result.value.close();
    } finally {
      listener.stop(true);
    }
  });
  test("abort before/during connection, refused endpoint and invalid inputs are safe", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await connect(1, controller.signal)).ok).toBe(false);
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    expect((await connect(port)).ok).toBe(false);
    const during = new AbortController();
    const promise = connect(port, during.signal);
    during.abort();
    const aborted = await promise;
    expect(!aborted.ok && aborted.error.code).toBe("cancelled");
    expect(
      (
        await transport.connect(
          { host: "bad\nname", port: 1, tls: false, timeoutMs: 1000 },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);
  });
  test("rejects excess queued bytes without retaining caller memory", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const result = await connect(listener.port);
      if (!result.ok) throw new Error("Local connection failed");
      const rejected = await result.value.write(
        new Uint8Array(1024 * 1024 + 1),
        new AbortController().signal,
      );
      expect(!rejected.ok && rejected.error.code).toBe("rate-limited");
      await result.value.close();
    } finally {
      listener.stop(true);
    }
  });
});
