"""Optional Linux/macOS production TTY smoke test; requires Python 3 and Bun."""

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
with tempfile.TemporaryDirectory(prefix="openirc-pty-") as root:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 110, 0, 0))
    environment = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    child = subprocess.Popen(
        ["bun", "run", "src/main.ts", "--config-dir", root + "/config", "--data-dir", root + "/data"],
        cwd=project,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=environment,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and child.poll() is None:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
        try:
            code = child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
        while select.select([master], [], [], 0)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                output.extend(chunk)
            except OSError:
                break
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    screen = output.decode("utf8", "replace")
    result = {
        "exitCode": code,
        "renderedOpenIRC": "OpenIRC" in screen,
        "renderedSettings": "Settings" in screen,
        "capturedBytes": len(output),
        "hasTypeError": "TypeError" in screen,
    }
    print(json.dumps(result))
    if code != 0 or not result["renderedOpenIRC"] or not result["renderedSettings"] or result["hasTypeError"]:
        raise SystemExit("Terminal startup/shutdown smoke test failed; no private config was used.")
