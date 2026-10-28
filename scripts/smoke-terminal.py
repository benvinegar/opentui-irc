"""Optional production TTY + agent-control smoke test; requires Python 3 and Bun."""

import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

project = Path(__file__).resolve().parent.parent


def smoke(root, authorized_shutdown=False, launcher=None):
    """`launcher` runs an installed command from outside the project, where bunfig.toml is absent."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 110, 0, 0))
    config = root + "/config"
    os.makedirs(root, exist_ok=True)
    cwd = root if launcher else project
    app = launcher or ["bun", "run", "src/main.ts"]
    ctl = launcher or ["bun", "run", "src/ctl.ts"]
    args = [*app, "--config-dir", config, "--data-dir", root + "/data"]
    if authorized_shutdown:
        args += ["--control-allow", "destructive"]
    child = subprocess.Popen(
        args, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
        env=dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor"),
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()

    def pump(wait=0.02):
        if select.select([master], [], [], wait)[0]:
            try:
                chunk = os.read(master, 65536)
                output.extend(chunk)
                return bool(chunk)
            except OSError:
                return False
        return True

    def control(*arguments):
        command = subprocess.Popen(
            [*ctl, "--config-dir", config, *arguments],
            cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 7
            # Keep draining terminal output while a live theme update triggers a repaint.
            while command.poll() is None:
                if time.monotonic() > deadline:
                    raise RuntimeError("Agent control command timed out")
                pump()
            stdout, _stderr = command.communicate(timeout=1)
            envelope = json.loads(stdout)
            if command.returncode != (0 if envelope["ok"] else 1):
                raise RuntimeError("Agent command exit status does not match JSON result")
            return envelope
        finally:
            if command.poll() is None:
                command.kill()
                command.wait()

    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and child.poll() is None:
            if not pump(0.1):
                break
        status = control("status")
        if not status["ok"] or not status["result"]["running"]:
            raise RuntimeError("Production control server did not become ready")
        if authorized_shutdown:
            response = control("shutdown", "--allow-destructive", "--confirm")
            if not response["ok"]:
                raise RuntimeError("Explicitly authorized shutdown was rejected")
        else:
            applied = control("config", "set", "tui.theme", '"light"')
            current = control("config", "get")
            if not applied["ok"] or not current["ok"] or current["result"]["tui"]["theme"] != "light":
                raise RuntimeError("Live agent configuration did not update the real application")
            for command in [
                ("history", "search", "--text", "private", "--allow-read"),
                ("shutdown", "--allow-destructive", "--confirm"),
            ]:
                denied = control(*command)
                if denied["ok"] or denied["error"]["code"] != "permission-denied":
                    raise RuntimeError("Client flags unexpectedly escalated server permission")
            child.send_signal(signal.SIGTERM)
        try:
            code = child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
        while select.select([master], [], [], 0)[0]:
            if not pump(0):
                break
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    screen = output.decode("utf8", "replace")
    result = {
        "exitCode": code,
        "renderedName": "opentui-irc" in screen,
        "renderedSettings": "Settings" in screen,
        "capturedBytes": len(output),
        "hasTypeError": "TypeError" in screen,
        "agentControl": True,
        "authorizedShutdown": authorized_shutdown,
        "launcher": " ".join(launcher) if launcher else "bun run src/main.ts",
    }
    if code != 0 or not result["renderedName"] or not result["renderedSettings"] or result["hasTypeError"]:
        raise RuntimeError("Terminal/control smoke test failed; no private config was used")
    return result


with tempfile.TemporaryDirectory(prefix="openirc-pty-") as root:
    results = [
        smoke(root + "/default"),
        smoke(root + "/authorized", authorized_shutdown=True),
        smoke(root + "/installed", launcher=["bun", str(project / "bin" / "openirc.ts")]),
    ]
    # Optional: verify a compiled `bun run build` binary, e.g. OPENIRC_SMOKE_BINARY=dist/openirc.
    if os.environ.get("OPENIRC_SMOKE_BINARY"):
        binary = str(Path(os.environ["OPENIRC_SMOKE_BINARY"]).resolve())
        results.append(smoke(root + "/compiled", launcher=[binary]))
    print(json.dumps({"scenarios": results}))
