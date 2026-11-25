from __future__ import annotations

import argparse
import os
import platform
import sqlite3
import subprocess
import sys
from importlib import import_module
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def native_architecture() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64", "x86": "ia32", "i386": "ia32"}.get(machine, machine)


def check_socks_dependencies() -> None:
    try:
        for name in ["socksio", "httpcore._sync.socks_proxy", "httpcore._async.socks_proxy"]:
            import_module(name)
    except ImportError as error:
        raise RuntimeError(
            'SOCKS support is required in the bundled service; install the desktop Python dependencies '
            'with httpx[socks] before building.'
        ) from error


def check_knowledge_dependencies() -> None:
    try:
        import_module("python_multipart")
        import_module("pypdf")
        with sqlite3.connect(":memory:") as connection:
            connection.execute("CREATE VIRTUAL TABLE knowledge_probe USING fts5(tokens)")
    except (ImportError, sqlite3.Error) as error:
        raise RuntimeError("The bundled knowledge library requires python-multipart, pypdf and SQLite FTS5.") from error


def build_args(root: Path, target_platform: str) -> list[str]:
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "left-or-right-gateway",
        "--distpath", str(root / "desktop" / "backend"),
        "--workpath", str(root / "output" / "backend-build"),
        "--specpath", str(root / "output" / "backend-build"),
        "--paths", str(root),
        "--collect-submodules", "services", "--collect-submodules", "libs",
        "--collect-submodules", "socksio",
        "--collect-submodules", "python_multipart",
        "--collect-submodules", "multipart",
        "--collect-submodules", "pypdf",
        "--hidden-import", "httpcore._sync.socks_proxy",
        "--hidden-import", "httpcore._async.socks_proxy",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.asyncio",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.protocols.websockets.websockets_impl",
        "--hidden-import", "uvicorn.lifespan.on",
        "--exclude-module", "tkinter", "--exclude-module", "IPython",
        "--exclude-module", "pytest",
    ]
    if target_platform == "win32":
        args.append("--windowed")
    for directory in ["prompts", "db", "services/report_service/templates", "services/aigc_detect_service/templates"]:
        args.extend(["--add-data", f"{root / directory}{os.pathsep}{directory}"])
    args.append(str(root / "scripts" / "desktop_gateway.py"))
    return args


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the desktop application's bundled local service.")
    parser.add_argument("--platform", choices=["darwin", "win32"], default=sys.platform)
    parser.add_argument("--arch", default=native_architecture())
    options = parser.parse_args()
    if options.platform not in {"darwin", "win32"} or options.platform != sys.platform or options.arch != native_architecture():
        parser.error("Build on the target operating system with a native Python interpreter of the target architecture.")
    try:
        check_socks_dependencies()
        check_knowledge_dependencies()
    except RuntimeError as error:
        parser.error(str(error))
    subprocess.run(build_args(ROOT, options.platform), cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
