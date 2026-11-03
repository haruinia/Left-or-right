from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Try common OpenAI-compatible LLM auth header variants."
    )
    return parser.parse_args(argv)


def main() -> int:
    parse_args()
    from libs.common.config import get_settings

    settings = get_settings()
    key = os.getenv("LLM_API_KEY") or settings.llm_api_key
    if not key:
        print("LLM_API_KEY is not configured.")
        return 2

    url = settings.llm_base_url.rstrip("/") + "/" + settings.llm_api_path.lstrip("/")
    variants = [
        ("api-key", {"api-key": key}),
        ("Api-Key", {"Api-Key": key}),
        ("x-api-key", {"x-api-key": key}),
        ("X-API-Key", {"X-API-Key": key}),
        ("Authorization Bearer", {"Authorization": f"Bearer {key}"}),
        ("Authorization raw", {"Authorization": key}),
        ("token", {"token": key}),
    ]
    print(f"url: {url}")
    any_success = False
    for model in [settings.llm_model]:
        print(f"\nmodel: {model}")
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Return JSON {\"ok\": true}"}],
            "temperature": 0,
        }
        for name, headers in variants:
            try:
                response = httpx.post(url, headers=headers, json=payload, timeout=20)
                summary = _summarize_response(response)
                print(f"{name:22} {response.status_code} {summary}")
                any_success = any_success or response.status_code < 400
            except Exception as exc:
                print(f"{name:22} ERR {type(exc).__name__}: {repr(exc)[:160]}")
    return 0 if any_success else 1


def _summarize_response(response: httpx.Response) -> str:
    try:
        data = response.json()
    except json.JSONDecodeError:
        return response.text.replace("\n", " ")[:220]
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message", "")
            code = error.get("code", "")
            error_type = error.get("type", "")
            return f"{error_type} {code} {message}".strip()
    return json.dumps(data, ensure_ascii=False)[:220]


if __name__ == "__main__":
    raise SystemExit(main())
