# Bun TCP/TLS transport

`createBunTransport(): TransportFactory` is exported from `bun.ts`. It uses Bun's tested `node:net` / `node:tls` compatibility APIs, deliberately: these expose a socket **before** connect completes, so abort/timeout can destroy a pending connection. `Bun.connect()` does not expose a pre-open cancellation handle; simply ignoring its late promise result would leave a native attempt alive after cancellation.

No reconnect or plaintext downgrade is performed. Limits are 1 MiB queued input, 1 MiB total pending write bytes (including the active stream write), 256 writes and 4096 queued chunks per connection. Writes are serialized, honor the stream's writable high-water mark and drain event, and resolve only after their write callback succeeds. No unbounded secondary queue is used.

TLS is exposed only after secureConnect with an authorized certificate **and** `node:tls.checkServerIdentity()` hostname/IP verification. IP endpoints omit DNS SNI but still require matching IP certificate SANs. No insecure acceptance option is exposed. Default system trust (including explicitly configured process-local extra CAs) is used. Tests previously demonstrated why relying on Bun.connect's open callback plus rejectUnauthorized alone was insufficient; the current adapter also tests verified secureConnect explicitly.

The connect signal remains attached for the connection's entire lifetime. Aborting a pending write terminates the connection because partial bytes cannot safely be rolled back. Close is idempotent and unblocks pending reads and writes. Every yielded chunk is an owned copy. Errors are sanitized without underlying causes or byte payloads.

Local Bun integration tests cover TCP echo/EOF, abort before/during connection and during a stalled TLS handshake, timeout, refused endpoints, concurrent backpressure, write bounds, close, trusted test CA, untrusted certificate and wrong hostname. TLS test trust is scoped to a fresh subprocess via NODE_EXTRA_CA_CERTS and is never disabled. See `tests/transport/*.bun.test.ts`; these are excluded from Node Vitest.
