from __future__ import annotations

import json

import httpx

from libs.common.config import get_settings
from libs.llm_client import LLMClient, LLMMessage, reset_llm_rate_limiter
from libs.schemas import CredibilitySignal, ProbeResponse, ProbeSuggestion


def _fallback() -> ProbeResponse:
    return ProbeResponse(
        suggestions=[
            ProbeSuggestion(
                question="fallback",
                target="fallback",
                competency="fallback",
                priority=1,
            )
        ],
        credibility=CredibilitySignal(level="vague", reason="fallback", drill_down_hint="fallback"),
    )


async def _call_with_transport(transport: httpx.MockTransport) -> ProbeResponse:
    client = LLMClient(transport=transport)
    return await client.complete_json(
        [LLMMessage(role="user", content="hello")],
        ProbeResponse,
        _fallback(),
    )


def test_llm_client_uses_configurable_protocol(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "example-model")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test/api")
    monkeypatch.setenv("LLM_API_PATH", "/v2/chat")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_AUTH_HEADER", "X-API-Key")
    monkeypatch.setenv("LLM_AUTH_SCHEME", "")
    monkeypatch.setenv("LLM_RESPONSE_CONTENT_PATH", "data.output")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", '{"custom":{"enabled":true}}')
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://llm.example.test/api/v2/chat"
        assert request.headers["X-API-Key"] == "secret"
        body = json.loads(request.content)
        assert body["model"] == "example-model"
        assert body["custom"]["enabled"] is True
        return httpx.Response(
            200,
            json={
                "data": {
                    "output": json.dumps(
                        {
                            "suggestions": [
                                {
                                    "question": "真实接口追问",
                                    "target": "验证项目真实性",
                                    "competency": "项目真实性",
                                    "priority": 1,
                                }
                            ],
                            "credibility": {
                                "level": "solid",
                                "reason": "包含细节",
                                "drill_down_hint": "继续追问异常处理",
                            },
                        },
                        ensure_ascii=False,
                    )
                }
            },
        )

    response = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))
    assert response.suggestions[0].question == "真实接口追问"
    assert response.credibility.level == "solid"


def test_llm_client_accepts_decoded_json_response_content(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_RESPONSE_CONTENT_PATH", "data.output")
    get_settings.cache_clear()

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "output": {
                        "suggestions": [
                            {
                                "question": "对象响应追问",
                                "target": "验证结构化响应",
                                "competency": "项目真实性",
                                "priority": 1,
                            }
                        ],
                        "credibility": {
                            "level": "solid",
                            "reason": "供应商直接返回 JSON 对象",
                            "drill_down_hint": "继续追问边界条件",
                        },
                    }
                }
            },
        )

    response = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))

    assert response.suggestions[0].question == "对象响应追问"
    assert response.credibility.reason == "供应商直接返回 JSON 对象"


def test_llm_client_falls_back_on_bad_response(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    get_settings.cache_clear()

    transport = httpx.MockTransport(lambda _: httpx.Response(500, json={"error": "boom"}))
    response = __import__("asyncio").run(_call_with_transport(transport))
    assert response.suggestions[0].question == "fallback"


def test_llm_client_retries_once_after_bad_json(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_MAX_RETRIES", "1")
    get_settings.cache_clear()
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]})
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "suggestions": [
                                        {
                                            "question": "重试后成功",
                                            "target": "验证项目真实性",
                                            "competency": "项目真实性",
                                            "priority": 1,
                                        }
                                    ],
                                    "credibility": {
                                        "level": "solid",
                                        "reason": "重试解析成功",
                                        "drill_down_hint": "继续追问",
                                    },
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    response = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))

    assert calls == 2
    assert response.suggestions[0].question == "重试后成功"


def test_llm_client_retry_count_can_be_disabled(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_MAX_RETRIES", "0")
    get_settings.cache_clear()
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]})

    response = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))

    assert calls == 1
    assert response.suggestions[0].question == "fallback"


def test_llm_client_can_raise_safe_error(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    get_settings.cache_clear()

    transport = httpx.MockTransport(lambda _: httpx.Response(401, json={"error": "bad key"}))
    client = LLMClient(transport=transport)
    try:
        __import__("asyncio").run(
            client.complete_json(
                [LLMMessage(role="user", content="hello")],
                ProbeResponse,
                _fallback(),
                raise_on_error=True,
            )
        )
    except RuntimeError as exc:
        assert "HTTP 401" in str(exc)
        assert "secret" not in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_llm_client_sync_path_uses_mock_transport(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    get_settings.cache_clear()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "suggestions": [
                                        {
                                            "question": "同步路径追问",
                                            "target": "验证同步 LLM 封装",
                                            "competency": "可靠性",
                                            "priority": 1,
                                        }
                                    ],
                                    "credibility": {
                                        "level": "solid",
                                        "reason": "同步路径可脱网 mock",
                                        "drill_down_hint": "继续追问失败降级",
                                    },
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    client = LLMClient(sync_transport=httpx.MockTransport(handler))
    response = client.complete_json_sync(
        [LLMMessage(role="user", content="hello")],
        ProbeResponse,
        _fallback(),
    )

    assert calls == 1
    assert response.suggestions[0].question == "同步路径追问"


def test_llm_client_sync_path_retries_after_bad_json(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_MAX_RETRIES", "1")
    get_settings.cache_clear()
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]})
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "suggestions": [
                                        {
                                            "question": "同步重试后成功",
                                            "target": "验证同步重试",
                                            "competency": "可靠性",
                                            "priority": 1,
                                        }
                                    ],
                                    "credibility": {
                                        "level": "solid",
                                        "reason": "同步重试解析成功",
                                        "drill_down_hint": "继续追问",
                                    },
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    client = LLMClient(sync_transport=httpx.MockTransport(handler))
    response = client.complete_json_sync(
        [LLMMessage(role="user", content="hello")],
        ProbeResponse,
        _fallback(),
    )

    assert calls == 2
    assert response.suggestions[0].question == "同步重试后成功"


def test_llm_client_rate_limit_returns_fallback_without_http(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("LLM_RATE_LIMIT_REQUESTS_PER_MINUTE", "1")
    get_settings.cache_clear()
    reset_llm_rate_limiter()
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "suggestions": [
                                        {
                                            "question": "第一次真实调用",
                                            "target": "验证限流",
                                            "competency": "可靠性",
                                            "priority": 1,
                                        }
                                    ],
                                    "credibility": {
                                        "level": "solid",
                                        "reason": "首次调用通过",
                                        "drill_down_hint": "继续追问",
                                    },
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    first = __import__("asyncio").run(_call_with_transport(transport))
    second = __import__("asyncio").run(_call_with_transport(transport))

    assert calls == 1
    assert first.suggestions[0].question == "第一次真实调用"
    assert second.suggestions[0].question == "fallback"
    reset_llm_rate_limiter()


def test_llm_client_rate_limit_can_raise_without_secret(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("LLM_RATE_LIMIT_REQUESTS_PER_MINUTE", "1")
    get_settings.cache_clear()
    reset_llm_rate_limiter()
    client = LLMClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": json.dumps(_fallback().model_dump())}}
                    ]
                },
            )
        )
    )

    try:
        __import__("asyncio").run(
            client.complete_json(
                [LLMMessage(role="user", content="hello")],
                ProbeResponse,
                _fallback(),
            )
        )
        __import__("asyncio").run(
            client.complete_json(
                [LLMMessage(role="user", content="hello")],
                ProbeResponse,
                _fallback(),
                raise_on_error=True,
            )
        )
    except RuntimeError as exc:
        assert "LLM rate limit exceeded" in str(exc)
        assert "secret" not in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
    finally:
        reset_llm_rate_limiter()


def _text_payload_regression_case() -> dict:
    """Guard: text-only messages must serialize exactly as they did before vision support."""
    from libs.llm_client.client import _request_payload

    return _request_payload(
        [
            LLMMessage(role="system", content="system text"),
            LLMMessage(role="user", content="user text"),
        ]
    )


def test_text_only_payload_is_unchanged_by_vision_support(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "text-model")
    monkeypatch.setenv("VISION_MODEL", "vision-model")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", "")
    monkeypatch.setenv("LLM_MAX_TOKENS", "0")
    get_settings.cache_clear()

    assert _text_payload_regression_case() == {
        "model": "text-model",
        "messages": [
            {"role": "system", "content": "system text"},
            {"role": "user", "content": "user text"},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }


def test_output_budget_is_sent_and_extra_body_cannot_override_core_fields(monkeypatch) -> None:
    from libs.llm_client.client import _request_payload

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "text-model")
    monkeypatch.setenv("LLM_MAX_TOKENS", "16384")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", '{"top_p":0.9}')
    get_settings.cache_clear()
    payload = _request_payload([LLMMessage(role="user", content="hi")], stream=True, json_object=False)
    assert payload["max_tokens"] == 16384
    assert payload["top_p"] == 0.9

    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", '{"max_tokens":1}')
    get_settings.cache_clear()
    import pytest

    with pytest.raises(ValueError, match="max_tokens"):
        _request_payload([LLMMessage(role="user", content="hi")], stream=True, json_object=False)


def test_protocol_is_inferred_from_full_endpoint_and_explicit_choice_wins(monkeypatch) -> None:
    from libs.llm_client.client import _endpoint_url, resolve_protocol

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test/v1/chat/completions")
    monkeypatch.setenv("LLM_API_PATH", "/chat/completions")
    get_settings.cache_clear()
    settings = get_settings()
    assert resolve_protocol(settings) == "openai_chat"
    assert _endpoint_url(settings) == "https://llm.example.test/v1/chat/completions"

    monkeypatch.setenv("LLM_PROTOCOL", "anthropic_messages")
    get_settings.cache_clear()
    assert resolve_protocol(get_settings()) == "anthropic_messages"


def test_stream_length_finish_reports_incomplete_and_unexpected_eof_is_not_success(monkeypatch) -> None:
    import asyncio

    import pytest

    from libs.llm_client import LLMStreamIncomplete

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_AUTH_HEADER", "Authorization")
    monkeypatch.setenv("LLM_AUTH_SCHEME", "Bearer")
    monkeypatch.setenv("LLM_PROTOCOL", "openai_chat")
    get_settings.cache_clear()

    def run(content: bytes) -> list[str]:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=content)

        async def collect() -> list[str]:
            client = LLMClient(async_transport=httpx.MockTransport(handler))
            return [piece async for piece in client.stream_text([LLMMessage(role="user", content="hi")])]

        return asyncio.run(collect())

    with pytest.raises(LLMStreamIncomplete):
        run(
            'data: {"choices":[{"delta":{"content":"一半"},"finish_reason":"length"}]}\n\n'.encode()
        )
    with pytest.raises(LLMStreamIncomplete):
        run('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'.encode())
    assert "".join(run('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'.encode())) == "ok"


def test_image_message_becomes_content_parts_and_selects_vision_model(monkeypatch) -> None:
    from libs.llm_client.client import _request_payload

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "text-model")
    monkeypatch.setenv("VISION_MODEL", "vision-model")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", "")
    get_settings.cache_clear()

    payload = _request_payload(
        [
            LLMMessage(role="system", content="system text"),
            LLMMessage(role="user", content="看图", images=("data:image/png;base64,AAA",)),
        ]
    )

    assert payload["model"] == "vision-model"
    assert payload["messages"][0] == {"role": "system", "content": "system text"}
    assert payload["messages"][1] == {
        "role": "user",
        "content": [
            {"type": "text", "text": "看图"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
        ],
    }


def test_image_message_keeps_llm_model_when_vision_model_is_blank(monkeypatch) -> None:
    from libs.llm_client.client import _request_payload

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "text-model")
    monkeypatch.setenv("VISION_MODEL", "")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", "")
    get_settings.cache_clear()

    payload = _request_payload(
        [LLMMessage(role="user", content="看图", images=("data:image/png;base64,AAA",))]
    )

    assert payload["model"] == "text-model"


def test_image_message_without_text_omits_the_text_part(monkeypatch) -> None:
    from libs.llm_client.client import _serialize_message

    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    get_settings.cache_clear()

    assert _serialize_message(LLMMessage(role="user", content="", images=("http://x/y.png",))) == {
        "role": "user",
        "content": [{"type": "image_url", "image_url": {"url": "http://x/y.png"}}],
    }


def test_stream_text_parses_openai_sse_deltas(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "example-model")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test/api")
    monkeypatch.setenv("LLM_API_PATH", "/v1/chat/completions")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_AUTH_HEADER", "Authorization")
    monkeypatch.setenv("LLM_AUTH_SCHEME", "Bearer")
    monkeypatch.setenv("LLM_EXTRA_BODY_JSON", "")
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["stream"] is True
        assert "response_format" not in body
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                'data: {"choices":[{"delta":{"content":"六"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"娃"}}]}\n\n'
                "data: [DONE]\n\n"
            ).encode("utf-8"),
        )

    async def collect() -> list[str]:
        client = LLMClient(async_transport=httpx.MockTransport(handler))
        pieces: list[str] = []
        async for delta in client.stream_text([LLMMessage(role="user", content="hi")]):
            pieces.append(delta)
        return pieces

    assert __import__("asyncio").run(collect()) == ["六", "娃"]


def test_stream_text_surfaces_provider_error_body(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "example-model")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_AUTH_HEADER", "Authorization")
    monkeypatch.setenv("LLM_AUTH_SCHEME", "Bearer")
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": {"message": "所选账号的上游服务不支持当前地区使用 API"}},
        )

    async def collect() -> str:
        client = LLMClient(async_transport=httpx.MockTransport(handler))
        pieces: list[str] = []
        try:
            async for delta in client.stream_text([LLMMessage(role="user", content="hi")]):
                pieces.append(delta)
        except RuntimeError as exc:
            return str(exc)
        raise AssertionError("stream_text should raise on HTTP error status")

    message = __import__("asyncio").run(collect())
    assert "HTTP 400" in message
    assert "地区" in message
    assert "read()" not in message


def test_stream_text_mock_mode_does_not_call_http(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("MOCK_REPLY_TEXT", "## 解题思路\n离线验证\n\n## 答案\n42")
    get_settings.cache_clear()

    async def collect() -> str:
        def reject_http(request: httpx.Request) -> httpx.Response:
            raise AssertionError("mock mode must not contact the model provider")

        client = LLMClient(async_transport=httpx.MockTransport(reject_http))
        bits: list[str] = []
        async for delta in client.stream_text([LLMMessage(role="user", content="hi")]):
            bits.append(delta)
        return "".join(bits)

    assert __import__("asyncio").run(collect()) == "## 解题思路\n离线验证\n\n## 答案\n42"


def test_model_discovery_uses_configured_endpoint_and_credentials(monkeypatch):
    monkeypatch.setenv('LLM_PROVIDER','openai_compatible')
    monkeypatch.setenv('LLM_BASE_URL','https://models.test/v1')
    monkeypatch.setenv('LLM_API_KEY','test-model-key')
    get_settings.cache_clear()
    def handle(request):
        assert str(request.url)=='https://models.test/v1/models'
        assert 'test-model-key' in request.headers.values() or any('test-model-key' in v for v in request.headers.values())
        return httpx.Response(200,json={'data':[{'id':'vision-one'},{'id':'text-two'},{'id':'vision-one'},{}]})
    import asyncio
    assert asyncio.run(LLMClient(transport=httpx.MockTransport(handle)).list_models()) == ['text-two','vision-one']


def _probe_json() -> str:
    return json.dumps(
        {
            "suggestions": [
                {
                    "question": "q",
                    "target": "t",
                    "competency": "c",
                    "priority": 1,
                }
            ],
            "credibility": {"level": "vague", "reason": "r", "drill_down_hint": "d"},
        },
        ensure_ascii=False,
    )


def _configure_json_client(monkeypatch, model: str) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", model)
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret")
    monkeypatch.setenv("LLM_AUTH_HEADER", "Authorization")
    monkeypatch.setenv("LLM_AUTH_SCHEME", "Bearer")
    monkeypatch.setenv("LLM_RESPONSE_CONTENT_PATH", "choices.0.message.content")
    get_settings.cache_clear()


def test_llm_client_accepts_markdown_fenced_json_content(monkeypatch) -> None:
    """Providers that honour response_format=json_object still wrap output in ```json."""
    _configure_json_client(monkeypatch, "fenced-model")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "```json\n" + _probe_json() + "\n```",
                        }
                    }
                ]
            },
        )

    result = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))
    assert result.suggestions[0].question == "q"
    assert result.credibility.level == "vague"


def test_llm_client_accepts_json_wrapped_in_prose(monkeypatch) -> None:
    _configure_json_client(monkeypatch, "prose-model")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "好的，结果如下：\n" + _probe_json() + "\n以上。",
                        }
                    }
                ]
            },
        )

    result = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))
    assert result.suggestions[0].question == "q"


def test_llm_client_still_falls_back_on_non_json_content(monkeypatch) -> None:
    _configure_json_client(monkeypatch, "broken-model")
    monkeypatch.setenv("LLM_MAX_RETRIES", "0")
    get_settings.cache_clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "抱歉，我无法完成。"}}]},
        )

    result = __import__("asyncio").run(_call_with_transport(httpx.MockTransport(handler)))
    assert result.suggestions[0].question == "fallback"
