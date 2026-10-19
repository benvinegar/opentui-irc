# Bun TCP/TLS transport

`createBunTransport(): TransportFactory` is exported from `bun.ts`. No reconnect or plaintext downgrade is performed. Limits are currently fixed at 1 MiB queued input, 1 MiB pending write bytes, 256 writes and 4096 queued chunks per connection. Backpressure is handled using Bun's partial `Socket.write()` return value and `drain` callback, not an unbounded user-space buffer.

TLS is exposed only after an explicit successful authorized handshake **and** `node:tls.checkServerIdentity()` hostname/IP verification. Bun 1.3.14's open callback with `rejectUnauthorized: true` alone did not reject the test fixture's untrusted certificate, so using only open is intentionally insufficient here. No insecure acceptance option is exposed. Default system trust (including explicitly configured process-local extra CAs) is used.

The connect signal remains attached for the connection's entire lifetime. Aborting a pending partial write terminates the connection, because its partial bytes cannot safely be rolled back. Close is idempotent and unblocks pending reads and writes. Every yielded byte chunk is an owned copy. Connection and read errors are sanitized without underlying causes or byte payloads.

Local Bun integration tests cover TCP echo/EOF, abort before/during connection and during a stalled TLS handshake, timeout, refused endpoints, concurrent backpressure, write bounds, close, trusted test CA, untrusted certificate and wrong hostname. TLS test trust is scoped to a new subprocess and is never globally disabled. See `tests/transport/*.bun.test.ts`; these are excluded from Node Vitest.
