from __future__ import annotations

import argparse
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001
DOCKER_COMPOSE_PORT = 8000
SETTINGS_PORT = 9958
WEB_ROOT = ROOT / "web"


def readiness_label(ready: bool) -> str:
    return "configured" if ready else "missing"


def mode_label(provider: str, ready: bool) -> str:
    return "mock" if provider in {"mock", "stub"} else readiness_label(ready)


def display_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    return f"http://{display_host}:{port}/"


def local_port_warning_lines(host: str, port: int) -> list[str]:
    if port == DOCKER_COMPOSE_PORT:
        return []
    if port_is_available(host, DOCKER_COMPOSE_PORT):
        return []
    return [
        f"Note: port {DOCKER_COMPOSE_PORT} is already in use on {host}.",
        (f"Open {display_url(host, port)} for this local gateway, not "
         f"{display_url(host, DOCKER_COMPOSE_PORT)}."),
    ]


def _redirect_bind_host(host: str) -> str:
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


def _redirect_handler(target_url: str):
    class LocalRedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._redirect()

        def do_HEAD(self) -> None:
            self._redirect(body=False)

        def do_POST(self) -> None:
            self._redirect()

        def do_OPTIONS(self) -> None:
            self._redirect()

        def log_message(self, format: str, *args) -> None:
            return

        def _redirect(self, *, body: bool = True) -> None:
            location = f"{target_url.rstrip('/')}{self.path}"
            self.send_response(307)
            self.send_header("Location", location)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(f"Redirecting to {location}\n".encode())

    return LocalRedirectHandler


def start_port_redirect(
    host: str,
    source_port: int,
    target_port: int,
) -> tuple[ThreadingHTTPServer, str] | None:
    if target_port == source_port:
        return None
    bind_host = _redirect_bind_host(host)
    try:
        server = ThreadingHTTPServer(
            (bind_host, source_port),
            _redirect_handler(display_url(host, target_port)),
        )
    except OSError:
        return None
    thread = threading.Thread(target=server.serve_forever, name="gateway-8000-redirect", daemon=True)
    thread.start()
    return server, display_url(bind_host, server.server_address[1])


def start_default_port_redirect(host: str, port: int) -> tuple[ThreadingHTTPServer, str] | None:
    return start_port_redirect(host, DOCKER_COMPOSE_PORT, port)


def start_settings_server(host: str, port: int = SETTINGS_PORT) -> tuple[ThreadingHTTPServer, str] | None:
    """在 9958 端口起静态设置中心：默认页是 settings.html，/ 和 /settings 都指向它。"""
    bind_host = _redirect_bind_host(host)

    class SettingsHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

        def do_GET(self) -> None:
            if self.path in {"/", "/settings", "/settings/"}:
                self.path = "/settings.html"
            super().do_GET()

        def end_headers(self) -> None:
            # 页面固定 URL，升级后必须重新读取模块，避免浏览器沿用旧版交互。
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, format: str, *args) -> None:
            return

    try:
        server = ThreadingHTTPServer((bind_host, port), SettingsHandler)
    except OSError:
        return None
    thread = threading.Thread(target=server.serve_forever, name="settings-9958", daemon=True)
    thread.start()
    return server, display_url(bind_host, server.server_address[1])


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
    parser.add_argument(
        "--no-default-port-redirect",
        action="store_true",
        help="Do not redirect http://127.0.0.1:8000/ to the selected local port.",
    )
    parser.add_argument(
        "--no-settings-server",
        action="store_true",
        help=f"Do not serve the settings center on port {SETTINGS_PORT}.",
    )
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
    redirect = None
    if not args.no_default_port_redirect:
        redirect = start_default_port_redirect(args.host, args.port)
        if redirect:
            _, redirect_url = redirect
            print(f"Redirecting {redirect_url} to {url}")
    if not redirect:
        for line in local_port_warning_lines(args.host, args.port):
            print(line)
    if not args.no_settings_server:
        settings_server = start_settings_server(args.host)
        if settings_server:
            _, settings_url = settings_server
            print(f"Settings center: {settings_url}")
        else:
            print(f"Note: settings port {SETTINGS_PORT} is unavailable, skipped.", file=sys.stderr)
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

