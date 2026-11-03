from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_all_utility_scripts_support_help_without_running() -> None:
    scripts = sorted((ROOT / "scripts").glob("*.py"))
    assert scripts
    for script in scripts:
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(script), "--help"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        assert "usage:" in result.stdout
        assert "Traceback" not in result.stderr
