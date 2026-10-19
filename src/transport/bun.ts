import { connect as connectTcp, isIP } from "node:net";
import type { Socket } from "node:net";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import type { TLSSocket } from "node:tls";
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

/** Uses Bun's Node-compatible sockets: unlike Bun.connect, these expose a cancellable socket before open. */
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
      )
        return {
          ok: false,
          error: error("invalid-input", "Invalid connection endpoint or timeout."),
        };
      let socket: Socket | undefined;
      let ended = false;
      let readError: AppError | undefined;
      let connected = false;
      let incomingBytes = 0;
      let pendingBytes = 0;
      let activeWrite = false;
      let blocked = false;
      let wake: (() => void) | undefined;
      const chunks: Uint8Array[] = [];
      const writes: {
        bytes: Uint8Array;
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
        // destroy also cancels the pre-open connect; late connect/secureConnect handlers cannot expose it.
        socket?.destroy();
      }
      const abort = () => stop(error("cancelled", "Connection cancelled."));
      const timer = setTimeout(
        () => stop(error("network", "Connection timed out.")),
        options.timeoutMs,
      );
      lifetime.addEventListener("abort", abort, { once: true });
      function drain() {
        if (!socket || ended || activeWrite || blocked || !writes.length) return;
        const write = writes[0]!;
        activeWrite = true;
        try {
          const accepted = socket.write(write.bytes, (failure?: Error | null) => {
            if (ended) return;
            if (failure) {
              stop(error("network", "Socket write failed."));
              return;
            }
            activeWrite = false;
            writes.shift();
            pendingBytes -= write.bytes.length;
            write.signal.removeEventListener("abort", write.abort);
            write.resolve(success());
            // The write callback can run before drain. Never bypass the writable high-water mark.
            queueMicrotask(drain);
          });
          if (!accepted) blocked = true;
        } catch {
          stop(error("network", "Socket write failed."));
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
            writes.push({ bytes: bytes.slice(), resolve, signal, abort: onAbort });
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
      const opened = () => {
        if (ended) {
          socket?.destroy();
          return;
        }
        clearTimeout(timer);
        connected = true;
        settleConnect({ ok: true, value: connection });
        drain();
      };
      const onData = (data: Buffer) => {
        if (ended) return;
        if (data.byteLength > MAX_BYTES - incomingBytes || chunks.length >= 4096) {
          stop(error("network", "Transport input buffer overflow."));
          return;
        }
        const copy = new Uint8Array(data).slice();
        chunks.push(copy);
        incomingBytes += copy.length;
        notify();
      };
      const onDrain = () => {
        blocked = false;
        drain();
      };
      const onEnd = () => stop();
      const onError = (failure: NodeJS.ErrnoException) => {
        const networkFailure = [
          "ECONNREFUSED",
          "ECONNRESET",
          "ENOTFOUND",
          "EAI_AGAIN",
          "ETIMEDOUT",
          "ENETUNREACH",
          "EHOSTUNREACH",
        ].includes(failure.code ?? "");
        stop(
          error(
            options.tls && !connected && !networkFailure ? "tls" : "network",
            options.tls && !connected && !networkFailure
              ? "TLS verification or handshake failed."
              : "Socket connection failed.",
          ),
        );
      };
      const onClose = () => {
        stop();
        socket?.removeListener("data", onData);
        socket?.removeListener("drain", onDrain);
        socket?.removeListener("end", onEnd);
        socket?.removeListener("error", onError);
        socket?.removeListener("close", onClose);
        socket?.removeListener("connect", opened);
        socket?.removeListener("secureConnect", secureOpened);
      };
      let tlsSocket: TLSSocket | undefined;
      const secureOpened = () => {
        if (ended) {
          socket?.destroy();
          return;
        }
        try {
          if (
            !tlsSocket?.authorized ||
            checkServerIdentity(options.host, tlsSocket.getPeerCertificate())
          ) {
            stop(error("tls", "TLS certificate or hostname verification failed."));
            return;
          }
          opened();
        } catch {
          stop(error("tls", "TLS certificate or hostname verification failed."));
        }
      };
      try {
        if (options.tls) {
          tlsSocket = connectTls({
            host: options.host,
            port: options.port,
            ...(isIP(options.host) === 0 ? { servername: options.host } : {}),
            rejectUnauthorized: true,
            checkServerIdentity,
          });
          socket = tlsSocket;
          socket.once("secureConnect", secureOpened);
        } else {
          socket = connectTcp({ host: options.host, port: options.port });
          socket.once("connect", opened);
        }
        socket.on("data", onData);
        socket.on("drain", onDrain);
        socket.once("end", onEnd);
        socket.on("error", onError);
        socket.once("close", onClose);
        if (ended || lifetime.aborted) {
          if (!ended) abort();
          socket.destroy();
        }
      } catch {
        stop(error("network", "Unable to create connection."));
      }
      return result;
    },
  };
}
