from __future__ import annotations

import argparse
import multiprocessing
import os
import sys
from pathlib import Path


def prepare_runtime(data: Path) -> None:
    data.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None or sys.stderr is None:
        log = (data / "gateway-console.log").open("a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{(data / 'shuihuo_killer.db').as_posix()}")
    os.environ.setdefault("REPORT_DIR", str(data / "reports"))
    os.environ.setdefault("LLM_PROFILES_PATH", str(data / "model_profiles.json"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the desktop application's local service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9958)
    args = parser.parse_args()
    prepare_runtime(Path.cwd())

    import uvicorn
    from services.gateway.app import app

    uvicorn.run(app, host=args.host, port=args.port, loop="asyncio", http="h11", ws="websockets", use_colors=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
