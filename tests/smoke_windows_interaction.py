from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the packaged native Windows modifier helper emits heartbeats.")
    parser.add_argument("--binary", required=True, type=Path)
    options = parser.parse_args()
    if os.name != "nt":
        parser.error("This smoke test requires a native Windows runner.")
    binary = options.binary.resolve()
    if not binary.is_file() or binary.suffix.lower() != ".exe":
        parser.error("A built native Windows helper executable is required.")
    child = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8-sig",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    messages: queue.Queue[str | None] = queue.Queue()

    def read_output() -> None:
        try:
            for line in child.stdout:
                messages.put(line)
        finally:
            messages.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        count = 0
        deadline = time.monotonic() + 10
        while count < 2:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("The native modifier helper did not emit heartbeat updates.")
            try:
                line = messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise RuntimeError("The native modifier helper heartbeat timed out.") from exc
            if line is None:
                raise RuntimeError("The native modifier helper exited before two heartbeat updates.")
            payload = json.loads(line)
            if not isinstance(payload.get("held"), bool) or not isinstance(payload.get("foreground"), str):
                raise RuntimeError("The native modifier helper emitted an invalid state update.")
            int(payload["foreground"])
            count += 1
        child.stdin.close()
        if child.wait(timeout=5) != 0:
            raise RuntimeError("The native modifier helper did not shut down cleanly after stdin closed.")
        print(json.dumps({"native_windows_interaction_smoke": "passed", "heartbeat_updates": count, "clean_shutdown": True}))
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        if child.stdin and not child.stdin.closed:
            child.stdin.close()
        if child.stdout:
            child.stdout.close()
        reader.join(timeout=1)


if __name__ == "__main__":
    main()
