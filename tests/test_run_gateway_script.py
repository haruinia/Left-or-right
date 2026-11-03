from __future__ import annotations

import importlib.util
from io import BytesIO
import socket
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace


def _load_run_gateway():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_gateway.py"
    spec = importlib.util.spec_from_file_location("run_gateway", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_gateway_script_defaults_to_the_shared_web_port() -> None:
    run_gateway = _load_run_gateway()
    args = run_gateway.parse_args([])

    assert args.host == "127.0.0.1"
    assert args.port == 9958
    assert args.no_reload is False
    assert run_gateway.display_url("127.0.0.1", 9958) == "http://127.0.0.1:9958/"
    assert run_gateway.display_url("0.0.0.0", 9958) == "http://127.0.0.1:9958/"


def test_gateway_script_reports_occupied_port(capsys) -> None:
    run_gateway = _load_run_gateway()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        port = sock.getsockname()[1]

        result = run_gateway.main(["--port", str(port)])

    captured = capsys.readouterr()
    assert result == 2
    assert f"Port {port} is already in use" in captured.err
    assert "python scripts/run_gateway.py --port 8002" in captured.err


def test_gateway_script_runtime_summary_hides_secrets() -> None:
    run_gateway = _load_run_gateway()
    status = SimpleNamespace(
        llm_provider="openai_compatible",
        llm_model="deepseek-v4-pro",
        llm_base_url_configured=True,
        llm_api_key_configured=True,
        asr_provider="aliyun_nls_ws",
        aliyun_nls_app_key_configured=True,
        aliyun_nls_token_configured=True,
        aliyun_nls_token_auto_configured=False,
        aliyun_nls_endpoint_configured=True,
        aliyun_asr_api_key_configured=False,
        aliyun_asr_endpoint_configured=False,
        asr_base_url_configured=False,
        database_url="sqlite:///data/shuihuo_killer.db",
    )

    lines = run_gateway.runtime_summary_lines(status)
    summary = "\n".join(lines)

    assert "Model: openai_compatible / deepseek-v4-pro (configured)" in summary
    assert "ASR: aliyun_nls_ws (configured)" in summary
    assert "Database: sqlite:///data/shuihuo_killer.db" in summary
    assert "secret" not in summary.lower()
    assert "token" not in summary.lower()
    assert "key" not in summary.lower()


def test_gateway_script_runtime_summary_marks_mock_modes() -> None:
    run_gateway = _load_run_gateway()
    status = SimpleNamespace(
        llm_provider="mock",
        llm_model="example-model",
        llm_base_url_configured=True,
        llm_api_key_configured=False,
        asr_provider="stub",
        aliyun_nls_app_key_configured=False,
        aliyun_nls_token_configured=False,
        aliyun_nls_token_auto_configured=False,
        aliyun_nls_endpoint_configured=True,
        aliyun_asr_api_key_configured=False,
        aliyun_asr_endpoint_configured=True,
        asr_base_url_configured=False,
        database_url="sqlite:///data/shuihuo_killer.db",
    )

    lines = run_gateway.runtime_summary_lines(status)
    summary = "\n".join(lines)

    assert "Model: mock / example-model (mock)" in summary
    assert "ASR: stub (mock)" in summary
    assert "Model: mock / example-model (configured)" not in summary
    assert "ASR: stub (configured)" not in summary


def test_gateway_script_runtime_summary_accepts_nls_auto_token() -> None:
    run_gateway = _load_run_gateway()
    status = SimpleNamespace(
        llm_provider="mock",
        llm_model="example-model",
        llm_base_url_configured=True,
        llm_api_key_configured=False,
        asr_provider="aliyun_nls_ws",
        aliyun_nls_app_key_configured=True,
        aliyun_nls_token_configured=False,
        aliyun_nls_token_auto_configured=True,
        aliyun_nls_endpoint_configured=True,
        aliyun_asr_api_key_configured=False,
        aliyun_asr_endpoint_configured=False,
        asr_base_url_configured=False,
        database_url="sqlite:///data/shuihuo_killer.db",
    )

    assert "ASR: aliyun_nls_ws (configured)" in "\n".join(
        run_gateway.runtime_summary_lines(status)
    )


def test_gateway_script_reports_runtime_config_error(monkeypatch, capsys) -> None:
    run_gateway = _load_run_gateway()
    runtime_module = ModuleType("libs.common.runtime")

    def fail_runtime_status():
        raise ValueError("ASR_PROVIDER=aliyun_nls_ws requires ALIYUN_NLS_TOKEN")

    runtime_module.get_runtime_status = fail_runtime_status
    monkeypatch.setitem(sys.modules, "libs.common.runtime", runtime_module)

    result = run_gateway.main(["--port", "0"])

    captured = capsys.readouterr()
    assert result == 3
    assert "Runtime configuration error" in captured.err
    assert "ALIYUN_NLS_TOKEN" in captured.err
