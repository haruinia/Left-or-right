from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_backend_is_windowed_and_embeds_only_explicit_runtime_resources(monkeypatch) -> None:
    builder = load_script("build_desktop_backend")
    monkeypatch.setattr(builder.os, "pathsep", ";")
    args = builder.build_args(ROOT, "win32")
    assert "--windowed" in args
    resources = [args[index + 1] for index, value in enumerate(args) if value == "--add-data"]
    assert len(resources) == 4
    assert all(";" in value for value in resources)
    assert not any(".env" in value or "/data;" in value for value in resources)
    assert args[-1] == str(ROOT / "scripts" / "desktop_gateway.py")
    assert "--windowed" not in builder.build_args(ROOT, "darwin")


def test_backend_builder_rejects_non_native_target_before_pyinstaller(monkeypatch) -> None:
    builder = load_script("build_desktop_backend")
    other_platform = "darwin" if sys.platform == "win32" else "win32"
    monkeypatch.setattr(sys, "argv", ["build_desktop_backend.py", "--platform", other_platform])
    called = []
    monkeypatch.setattr(builder, "native_architecture", lambda: "x64")
    monkeypatch.setattr(builder.subprocess, "run", lambda *args, **kwargs: called.append(args))
    with pytest.raises(SystemExit) as error:
        builder.main()
    assert error.value.code == 2
    assert called == []


def test_native_python_architecture_normalization(monkeypatch) -> None:
    builder = load_script("build_desktop_backend")
    for raw, expected in [("AMD64", "x64"), ("x86_64", "x64"), ("ARM64", "arm64"), ("aarch64", "arm64")]:
        monkeypatch.setattr(builder.platform, "machine", lambda: raw)
        assert builder.native_architecture() == expected


def test_windowed_runtime_repairs_absent_standard_streams_in_private_data_directory(tmp_path, monkeypatch) -> None:
    gateway = load_script("desktop_gateway")
    original_stdout, original_stderr = sys.stdout, sys.stderr
    log = None
    try:
        monkeypatch.setattr(sys, "stdout", None)
        monkeypatch.setattr(sys, "stderr", None)
        with patch.dict(os.environ, {}, clear=True):
            gateway.prepare_runtime(tmp_path)
            log = sys.stdout
            assert log is sys.stderr
            assert Path(log.name).parent == tmp_path
            log.write("startup ready\n")
            log.flush()
            assert os.environ["DATABASE_URL"] == f"sqlite:///{(tmp_path / 'shuihuo_killer.db').as_posix()}"
            assert os.environ["LLM_PROFILES_PATH"] == str(tmp_path / "model_profiles.json")
    finally:
        sys.stdout, sys.stderr = original_stdout, original_stderr
        if log:
            log.close()
    assert (tmp_path / "gateway-console.log").read_text(encoding="utf-8") == "startup ready\n"


def test_runtime_does_not_override_explicit_private_storage_configuration(tmp_path) -> None:
    gateway = load_script("desktop_gateway")
    with patch.dict(os.environ, {"DATABASE_URL": "sqlite:///custom.db", "REPORT_DIR": "custom-reports", "LLM_PROFILES_PATH": "custom-profiles.json"}):
        gateway.prepare_runtime(tmp_path)
        assert os.environ["DATABASE_URL"] == "sqlite:///custom.db"
        assert os.environ["REPORT_DIR"] == "custom-reports"
        assert os.environ["LLM_PROFILES_PATH"] == "custom-profiles.json"
