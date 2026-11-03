from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def native_architecture() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64", "x86": "ia32", "i386": "ia32"}.get(machine, machine)


def build_args(root: Path, target_platform: str) -> list[str]:
    args = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "left-or-right-gateway",
        "--distpath", str(root / "desktop" / "backend"),
        "--workpath", str(root / "output" / "backend-build"),
        "--specpath", str(root / "output" / "backend-build"),
        "--paths", str(root),
        "--collect-submodules", "services", "--collect-submodules", "libs",
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
    subprocess.run(build_args(ROOT, options.platform), cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
