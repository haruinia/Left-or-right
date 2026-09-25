from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel

from libs.common.config import get_settings
from libs.common.observability import SlidingWindowRateLimiter

T = TypeVar("T", bound=BaseModel)
_llm_rate_limiter = SlidingWindowRateLimiter(requests_per_minute=60)


@dataclass(frozen=True)
class LLMMessage:
    role: str
    content: str
    images: tuple[str, ...] = ()


class LLMClient:
    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | httpx.BaseTransport | None = None,
        *,
        async_transport: httpx.AsyncBaseTransport | None = None,
        sync_transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._async_transport = async_transport or transport
        self._sync_transport = sync_transport or transport

    async def complete_json(
        self,
        messages: list[LLMMessage],
        schema: type[T],
        fallback: T,
        raise_on_error: bool = False,
    ) -> T:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_api_key or not settings.llm_base_url:
            return fallback
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                if raise_on_error:
                    raise RuntimeError(limited)
                return fallback
        payload = _request_payload(messages)
        headers = _auth_headers()
        url = settings.llm_base_url.rstrip("/") + "/" + settings.llm_api_path.lstrip("/")
        last_error: Exception | None = None
        max_attempts = max(1, settings.llm_max_retries + 1)
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(
                    timeout=settings.llm_timeout_seconds,
                    transport=self._async_transport,
                ) as client:
                    response = await client.post(url, headers=headers, json=payload)
                    response.raise_for_status()
                return _parse_json_response(response.json(), schema)
            except Exception as exc:
                last_error = exc
                if attempt == max_attempts - 1:
                    if raise_on_error:
                        raise RuntimeError(_safe_error_message(last_error)) from exc
                    return fallback
        return fallback

    def complete_json_sync(
        self,
        messages: list[LLMMessage],
        schema: type[T],
        fallback: T,
        raise_on_error: bool = False,
    ) -> T:
        result, _ = self.complete_json_sync_with_meta(
            messages,
            schema,
            fallback,
            raise_on_error=raise_on_error,
        )
        return result

    def complete_json_sync_with_meta(
        self,
        messages: list[LLMMessage],
        schema: type[T],
        fallback: T,
        raise_on_error: bool = False,
    ) -> tuple[T, bool]:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_api_key or not settings.llm_base_url:
            return fallback, True
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                if raise_on_error:
                    raise RuntimeError(limited)
                return fallback, True
        payload = _request_payload(messages)
        headers = _auth_headers()
        url = settings.llm_base_url.rstrip("/") + "/" + settings.llm_api_path.lstrip("/")
        last_error: Exception | None = None
        max_attempts = max(1, settings.llm_max_retries + 1)
        for attempt in range(max_attempts):
            try:
                with httpx.Client(
                    timeout=settings.llm_timeout_seconds,
                    transport=self._sync_transport,
                ) as client:
                    response = client.post(url, headers=headers, json=payload)
                    response.raise_for_status()
                return _parse_json_response(response.json(), schema), False
            except Exception as exc:
                last_error = exc
                if attempt == max_attempts - 1:
                    if raise_on_error:
                        raise RuntimeError(_safe_error_message(last_error)) from exc
                    return fallback, True
        return fallback, True

    async def stream_text(self, messages: list[LLMMessage]) -> AsyncIterator[str]:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_api_key or not settings.llm_base_url:
            for piece in _mock_text_chunks():
                yield piece
            return
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                raise RuntimeError(limited)
        payload = _request_payload(messages, stream=True, json_object=False)
        headers = _auth_headers()
        url = settings.llm_base_url.rstrip("/") + "/" + settings.llm_api_path.lstrip("/")
        timeout = httpx.Timeout(max(120.0, float(settings.llm_timeout_seconds)))
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                transport=self._async_transport,
            ) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        delta = _parse_stream_line(line)
                        if delta:
                            yield delta
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(_safe_error_message(exc)) from exc


def get_llm_client() -> LLMClient:
    return LLMClient()


def reset_llm_rate_limiter() -> None:
    _llm_rate_limiter.reset()


def _llm_rate_limited(provider: str, model: str) -> str:
    settings = get_settings()
    _llm_rate_limiter.requests_per_minute = settings.llm_rate_limit_requests_per_minute
    decision = _llm_rate_limiter.check(f"{provider}:{model}")
    if decision.allowed:
        return ""
    return f"LLM rate limit exceeded; retry after {decision.retry_after_seconds}s"


def _serialize_message(message: LLMMessage) -> dict[str, Any]:
    if not message.images:
        return {"role": message.role, "content": message.content}
    parts: list[dict[str, Any]] = []
    if message.content:
        parts.append({"type": "text", "text": message.content})
    parts.extend({"type": "image_url", "image_url": {"url": url}} for url in message.images)
    return {"role": message.role, "content": parts}


def _payload_model(messages: list[LLMMessage]) -> str:
    settings = get_settings()
    if any(message.images for message in messages) and settings.vision_model.strip():
        return settings.vision_model.strip()
    return settings.llm_model


def _request_payload(
    messages: list[LLMMessage],
    *,
    stream: bool = False,
    json_object: bool | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    if json_object is None:
        json_object = not stream
    payload: dict[str, Any] = {
        "model": _payload_model(messages),
        "messages": [_serialize_message(message) for message in messages],
        "temperature": 0.2,
    }
    if json_object:
        payload["response_format"] = {"type": "json_object"}
    if settings.llm_extra_body_json:
        extra_body = json.loads(settings.llm_extra_body_json)
        if not isinstance(extra_body, dict):
            raise ValueError("LLM_EXTRA_BODY_JSON must decode to an object")
        payload.update(extra_body)
    if stream:
        payload["stream"] = True
    return payload


def _mock_text_chunks() -> list[str]:
    text = "我是左右。当前是演示模式，尚未连接真实 AI。连接模型后，我会根据截图和你的复习预设讲解思路。"
    return [text[index : index + 2] for index in range(0, len(text), 2)]


def _parse_stream_line(line: str) -> str:
    raw = line.strip()
    if raw.startswith("data:"):
        raw = raw[5:].strip()
    if not raw or raw == "[DONE]":
        return ""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    try:
        content = payload["choices"][0]["delta"].get("content")
    except (KeyError, IndexError, TypeError, AttributeError):
        return ""
    return content if isinstance(content, str) else ""


def _auth_headers() -> dict[str, str]:
    settings = get_settings()
    auth_value = (
        f"{settings.llm_auth_scheme} {settings.llm_api_key}"
        if settings.llm_auth_scheme
        else settings.llm_api_key
    )
    return {settings.llm_auth_header: auth_value}


def _parse_json_response(payload: Any, schema: type[T]) -> T:
    content = _extract_path(payload, get_settings().llm_response_content_path)
    if isinstance(content, str):
        data: Any = json.loads(content)
    elif isinstance(content, (dict, list)):
        data = content
    else:
        raise ValueError("LLM response content path did not resolve to JSON data")
    return schema.model_validate(data)


def _extract_path(payload: Any, path: str) -> Any:
    value = payload
    for part in path.split("."):
        if isinstance(value, list):
            value = value[int(part)]
        elif isinstance(value, dict):
            value = value[part]
        else:
            raise KeyError(path)
    return value


def _safe_error_message(error: Exception | None) -> str:
    if error is None:
        return "unknown LLM error"
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        body = response.text[:500]
        return f"HTTP {response.status_code}: {body}"
    detail = str(error) or repr(error)
    return f"{type(error).__name__}: {detail[:500]}"
