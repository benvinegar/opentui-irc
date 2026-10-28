import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBunTransport } from "../../src/transport/bun";

// Trust is scoped to a fresh test child. Verification is never disabled, even for local fixtures.
test("TLS accepts a trusted localhost certificate; rejects untrusted CA and wrong hostname", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openirc-tls-"));
  let listener: Bun.TCPSocketListener<undefined> | undefined;
  try {
    await writeFile(
      join(directory, "ext.cnf"),
      "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    );
    const openssl = (args: string[]) => {
      const result = Bun.spawnSync(["openssl", ...args], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error("Unable to create local TLS fixture with openssl");
    };
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-days",
      "1",
      "-subj",
      "/CN=opentui-irc test CA",
    ]);
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=localhost",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.crt",
      "-days",
      "1",
      "-extfile",
      "ext.cnf",
    ]);
    listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        key: await readFile(join(directory, "server.key")),
        cert: await readFile(join(directory, "server.crt")),
      },
      socket: {
        data(socket, bytes) {
          socket.write(bytes);
        },
      },
    });
    const untrusted = await createBunTransport().connect(
      { host: "localhost", port: listener.port, tls: true, timeoutMs: 2000 },
      new AbortController().signal,
    );
    expect(untrusted.ok).toBe(false);
    const modulePath = resolve("src/transport/bun.ts");
    for (const [host, expected] of [
      ["localhost", true],
      ["127.0.0.1", false],
    ] as const) {
      const script = `import {createBunTransport} from ${JSON.stringify(modulePath)};
        const result = await createBunTransport().connect({host:${JSON.stringify(host)},port:${listener.port},tls:true,timeoutMs:2000},new AbortController().signal);
        if(result.ok) await result.value.close();
        console.log(JSON.stringify({ok:result.ok}));
        process.exit(result.ok === ${expected} ? 0 : 1);`;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, "ca.crt") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect({ code: await child.exited, output, stderr }).toEqual({
        code: 0,
        output: JSON.stringify({ ok: expected }) + "\n",
        stderr: "",
      });
    }
  } finally {
    listener?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
