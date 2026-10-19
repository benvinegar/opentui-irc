import { checkServerIdentity } from "node:tls";
import type { AppError, Result } from "../contracts/common";
import type { ByteConnection, TransportFactory } from "../contracts/transport";

const MAX_BYTES = 1024 * 1024;
const MAX_WRITES = 256;
const success = (): Result<void> => ({ ok: true, value: undefined });
const error = (code: AppError["code"], message: string): AppError => ({
  code,
  message,
  retryable: code === "network",
});

/** Bun's unbuffered partial writes are drained explicitly; no hidden reconnect or TLS bypass. */
export function createBunTransport(): TransportFactory {
  return {
    async connect(options, lifetime) {
      if (lifetime.aborted)
        return { ok: false, error: error("cancelled", "Connection cancelled.") };
      if (
        !options.host ||
        /[\s\0/]/.test(options.host) ||
        options.host.length > 253 ||
        !Number.isInteger(options.port) ||
        options.port < 1 ||
        options.port > 65535 ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 300_000 ||
        typeof options.tls !== "boolean"
      ) {
        return {
          ok: false,
          error: error("invalid-input", "Invalid connection endpoint or timeout."),
        };
      }
      let socket: Bun.Socket | undefined;
      let ended = false;
      let readError: AppError | undefined;
      let connected = false;
      let incomingBytes = 0;
      let pendingBytes = 0;
      let wake: (() => void) | undefined;
      const chunks: Uint8Array[] = [];
      const writes: {
        bytes: Uint8Array;
        offset: number;
        resolve: (result: Result<void>) => void;
        signal: AbortSignal;
        abort: () => void;
      }[] = [];
      let settleConnect: (result: Result<ByteConnection>) => void = () => {};
      const result = new Promise<Result<ByteConnection>>((resolve) => {
        settleConnect = resolve;
      });
      function notify() {
        const callback = wake;
        wake = undefined;
        callback?.();
      }
      function stop(failure?: AppError) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        lifetime.removeEventListener("abort", abort);
        if (failure) readError = failure;
        for (const write of writes.splice(0)) {
          write.signal.removeEventListener("abort", write.abort);
          write.resolve({
            ok: false,
            error: failure ?? error("network", "Connection closed during write."),
          });
        }
        pendingBytes = 0;
        notify();
        if (!connected)
          settleConnect({
            ok: false,
            error: failure ?? error("network", "Connection closed before opening."),
          });
        try {
          socket?.terminate();
        } catch {
          /* All consumers are already unblocked. */
        }
      }
      const abort = () => stop(error("cancelled", "Connection cancelled."));
      const timer = setTimeout(
        () => stop(error("network", "Connection timed out.")),
        options.timeoutMs,
      );
      lifetime.addEventListener("abort", abort, { once: true });
      function drain() {
        if (!socket || ended) return;
        while (writes.length) {
          const write = writes[0]!;
          let count: number;
          try {
            count = socket.write(write.bytes.subarray(write.offset));
          } catch {
            stop(error("network", "Socket write failed."));
            return;
          }
          if (count < 0) {
            stop(error("network", "Socket closed during write."));
            return;
          }
          write.offset += count;
          pendingBytes -= count;
          if (write.offset !== write.bytes.length) return;
          writes.shift();
          write.signal.removeEventListener("abort", write.abort);
          write.resolve(success());
        }
      }
      let consumed = false;
      const connection: ByteConnection = {
        incoming: {
          async *[Symbol.asyncIterator]() {
            if (consumed) throw new Error("Connection incoming stream has one consumer.");
            consumed = true;
            try {
              while (true) {
                if (chunks.length) {
                  const chunk = chunks.shift()!;
                  incomingBytes -= chunk.length;
                  yield chunk;
                } else if (ended) {
                  if (readError) throw new Error(readError.message);
                  return;
                } else
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
              }
            } finally {
              stop();
              chunks.length = 0;
              incomingBytes = 0;
            }
          },
        },
        write(bytes, signal) {
          if (signal.aborted || lifetime.aborted)
            return Promise.resolve({ ok: false, error: error("cancelled", "Write cancelled.") });
          if (ended)
            return Promise.resolve({ ok: false, error: error("network", "Connection is closed.") });
          if (bytes.byteLength > MAX_BYTES - pendingBytes || writes.length >= MAX_WRITES)
            return Promise.resolve({
              ok: false,
              error: error("rate-limited", "Transport write buffer is full."),
            });
          if (!bytes.byteLength) return Promise.resolve(success());
          return new Promise<Result<void>>((resolve) => {
            const onAbort = () => stop(error("cancelled", "Write cancelled; connection closed."));
            writes.push({ bytes: bytes.slice(), offset: 0, resolve, signal, abort: onAbort });
            pendingBytes += bytes.byteLength;
            signal.addEventListener("abort", onAbort, { once: true });
            drain();
          });
        },
        async close() {
          stop();
          return success();
        },
      };
      try {
        void Bun.connect({
          hostname: options.host,
          port: options.port,
          ...(options.tls ? { tls: { rejectUnauthorized: true, serverName: options.host } } : {}),
          socket: {
            open(opened) {
              socket = opened;
              if (ended) {
                opened.terminate();
                return;
              }
              if (!options.tls) {
                clearTimeout(timer);
                connected = true;
                settleConnect({ ok: true, value: connection });
                drain();
              }
            },
            handshake(opened, authorized, authorizationError) {
              socket = opened;
              if (ended) {
                opened.terminate();
                return;
              }
              try {
                if (
                  !authorized ||
                  authorizationError ||
                  !opened.authorized ||
                  checkServerIdentity(options.host, opened.getPeerCertificate())
                ) {
                  stop(error("tls", "TLS certificate or hostname verification failed."));
                  return;
                }
                clearTimeout(timer);
                connected = true;
                settleConnect({ ok: true, value: connection });
                drain();
              } catch {
                stop(error("tls", "TLS certificate or hostname verification failed."));
              }
            },
            data(opened, data) {
              socket = opened;
              if (ended) return;
              if (data.byteLength > MAX_BYTES - incomingBytes || chunks.length >= 4096) {
                stop(error("network", "Transport input buffer overflow."));
                return;
              }
              const copy = new Uint8Array(data).slice();
              chunks.push(copy);
              incomingBytes += copy.length;
              notify();
            },
            drain() {
              drain();
            },
            end() {
              stop();
            },
            close() {
              stop();
            },
            error() {
              stop(
                error(
                  options.tls && !connected ? "tls" : "network",
                  options.tls && !connected
                    ? "TLS verification or handshake failed."
                    : "Socket read failed.",
                ),
              );
            },
            connectError() {
              stop(error("network", "Unable to connect to server."));
            },
          },
        })
          .then((opened) => {
            socket = opened;
            if (ended) opened.terminate();
          })
          .catch(() =>
            stop(
              error(
                options.tls ? "tls" : "network",
                options.tls
                  ? "TLS verification or connection failed."
                  : "Unable to connect to server.",
              ),
            ),
          );
      } catch {
        stop(error("network", "Unable to create connection."));
      }
      return result;
    },
  };
}
