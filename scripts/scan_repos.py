"""Pre-warm the local project memory index used to cross-check candidate claims."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Index local git repositories into project_memories. "
            "Without arguments, scans every repo directly under MEMORY_REPO_ROOTS."
        )
    )
    parser.add_argument(
        "repos",
        nargs="*",
        help="specific repository paths to scan; each must sit under MEMORY_REPO_ROOTS",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    from libs.common.database import init_db
    from services.memory_service.service import scan_configured_roots, scan_repo_memories

    init_db()
    if args.repos:
        total = 0
        for path in args.repos:
            try:
                written = scan_repo_memories(path)
            except ValueError as exc:
                print(f"skip {path}: {exc}")
                continue
            total += written
            print(f"{path}: {written} facts")
        print(f"total: {total} facts")
        return 0
    results = scan_configured_roots()
    if not results:
        print("nothing scanned; set MEMORY_REPO_ROOTS to one or more directories")
        return 1
    for path, written in results.items():
        print(f"{path}: {written} facts")
    print(f"total: {sum(results.values())} facts across {len(results)} repos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
