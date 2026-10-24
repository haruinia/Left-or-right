from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_HOST = "127.0.0.1"
# 页面、模型配置 API 和学习资产同一进程、同一端口，桌面与浏览器都用同一个地址。
DEFAULT_PORT = 9958


def readiness_label(ready: bool) -> str:
    return "configured" if ready else "missing"


def mode_label(provider: str, ready: bool) -> str:
    return "mock" if provider in {"mock", "stub"} else readiness_label(ready)


def display_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    return f"http://{display_host}:{port}/"


def port_is_available(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # 与 uvicorn 一致，允许重启时复用 TIME_WAIT 连接留下的端口。
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
    except OSError:
        return False
    return True


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Shuihuo Killer gateway.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-reload", action="store_true", help="Disable uvicorn auto-reload.")
    return parser.parse_args(argv)


def runtime_summary_lines(status) -> list[str]:
    llm_ready = (
        status.llm_provider == "openai_compatible"
        and status.llm_base_url_configured
        and status.llm_api_key_configured
    )
    lines = [
        (f"Model: {status.llm_provider} / {status.llm_model} "
         f"({mode_label(status.llm_provider, llm_ready)})"),
    ]
    if status.asr_provider == "aliyun_nls_ws":
        asr_ready = (
            status.aliyun_nls_app_key_configured
            and (status.aliyun_nls_token_configured or status.aliyun_nls_token_auto_configured)
            and status.aliyun_nls_endpoint_configured
        )
    elif status.asr_provider == "aliyun_ws":
        asr_ready = status.aliyun_asr_api_key_configured and status.aliyun_asr_endpoint_configured
    elif status.asr_provider == "http":
        asr_ready = status.asr_base_url_configured
    else:
        asr_ready = False
    lines.append(f"ASR: {status.asr_provider} ({mode_label(status.asr_provider, asr_ready)})")
    lines.append(f"Database: {status.database_url}")
    return lines


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    url = display_url(args.host, args.port)
    if not port_is_available(args.host, args.port):
        print(
            f"Port {args.port} is already in use on {args.host}. "
            f"Choose another port, for example: python scripts/run_gateway.py --port 8002",
            file=sys.stderr,
        )
        return 2

    try:
        from libs.common.runtime import get_runtime_status

        status = get_runtime_status()
    except Exception as exc:  # noqa: BLE001 - report startup config failures at the CLI boundary
        print(f"Runtime configuration error: {exc}", file=sys.stderr)
        return 3

    print(f"Starting Shuihuo Killer gateway at {url}")
    print(f"API docs: {url}docs")
    for line in runtime_summary_lines(status):
        print(line)
    import uvicorn

    uvicorn.run(
        "services.gateway.app:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

