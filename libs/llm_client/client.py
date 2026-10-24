from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from libs.common.config import get_settings
from libs.common.observability import SlidingWindowRateLimiter, log_event

T = TypeVar("T", bound=BaseModel)
_llm_rate_limiter = SlidingWindowRateLimiter(requests_per_minute=60)

_PROTOCOL_SUFFIXES = {
    "openai_chat": "/chat/completions",
    "openai_responses": "/responses",
    "anthropic_messages": "/messages",
}


class LLMStreamIncomplete(RuntimeError):
    """The provider ended the stream without a complete answer."""


@dataclass(frozen=True)
class LLMMessage:
    role: str
    content: str
    images: tuple[str, ...] = ()


def resolve_protocol(settings=None) -> str:
    """Pick the wire protocol from an explicit choice or the endpoint path."""
    settings = settings or get_settings()
    configured = str(getattr(settings, "llm_protocol", "auto") or "auto")
    if configured in _PROTOCOL_SUFFIXES:
        return configured
    path = urlsplit(_endpoint_url(settings)).path.rstrip("/")
    for protocol, suffix in _PROTOCOL_SUFFIXES.items():
        if path.endswith(suffix):
            return protocol
    return "openai_chat"


def _endpoint_url(settings) -> str:
    base = settings.llm_base_url.rstrip("/")
    path = (settings.llm_api_path or "").strip()
    base_path = urlsplit(base).path.rstrip("/")
    for suffix in _PROTOCOL_SUFFIXES.values():
        if base_path.endswith(suffix):
            return base
    if path in {"", "/"}:
        protocol = (
            settings.llm_protocol
            if settings.llm_protocol in _PROTOCOL_SUFFIXES
            else "openai_chat"
        )
        return base + _PROTOCOL_SUFFIXES[protocol]
    return base + "/" + path.lstrip("/")


def _max_tokens(settings, protocol: str) -> int:
    configured = int(getattr(settings, "llm_max_tokens", 0) or 0)
    if configured > 0:
        return configured
    # Anthropic rejects requests without max_tokens, so its "provider default"
    # is the documented ceiling rather than an omitted field.
    return 4096 if protocol == "anthropic_messages" else 0


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

    async def list_models(self) -> list[str]:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_base_url:
            return []
        async with httpx.AsyncClient(timeout=5, transport=self._async_transport) as client:
            response = await client.get(settings.llm_base_url.rstrip("/") + "/models", headers=_auth_headers())
            response.raise_for_status()
        data = response.json()
        items = data.get("data", []) if isinstance(data, dict) else []
        return sorted({item["id"] for item in items if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip()})

    async def complete_json(
        self,
        messages: list[LLMMessage],
        schema: type[T],
        fallback: T,
        raise_on_error: bool = False,
    ) -> T:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_base_url:
            return fallback
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                if raise_on_error:
                    raise RuntimeError(limited)
                return fallback
        payload = _request_payload(messages)
        headers = _auth_headers()
        url = _endpoint_url(settings)
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
                return schema.model_validate(
                    _parse_json_response(response.json(), _json_content_path())
                )
            except Exception as exc:
                last_error = exc
                _log_llm_failure(schema, attempt, max_attempts, exc)
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
        if settings.llm_provider == "mock" or not settings.llm_base_url:
            return fallback, True
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                if raise_on_error:
                    raise RuntimeError(limited)
                return fallback, True
        payload = _request_payload(messages)
        headers = _auth_headers()
        url = _endpoint_url(settings)
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
                return schema.model_validate(
                    _parse_json_response(response.json(), _json_content_path())
                ), False
            except Exception as exc:
                last_error = exc
                _log_llm_failure(schema, attempt, max_attempts, exc)
                if attempt == max_attempts - 1:
                    if raise_on_error:
                        raise RuntimeError(_safe_error_message(last_error)) from exc
                    return fallback, True
        return fallback, True

    async def stream_text(self, messages: list[LLMMessage]) -> AsyncIterator[str]:
        settings = get_settings()
        if settings.llm_provider == "mock" or not settings.llm_base_url:
            for piece in _mock_text_chunks():
                yield piece
            return
        if settings.llm_rate_limit_enabled:
            limited = _llm_rate_limited(settings.llm_provider, settings.llm_model)
            if limited:
                raise RuntimeError(limited)
        protocol = resolve_protocol(settings)
        payload = _request_payload(messages, stream=True, json_object=False)
        headers = _auth_headers()
        url = _endpoint_url(settings)
        timeout = httpx.Timeout(max(120.0, float(settings.llm_timeout_seconds)))
        state = _StreamState(protocol)
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                transport=self._async_transport,
            ) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as response:
                    if response.status_code >= 400:
                        # Read the error body inside the stream context; accessing
                        # `.text` afterwards would raise ResponseNotRead and mask
                        # the real status from the upstream provider.
                        body = (await response.aread()).decode("utf-8", errors="replace")
                        raise RuntimeError(f"HTTP {response.status_code}: {body[:300]}")
                    async for line in response.aiter_lines():
                        for event in _parse_stream_event(protocol, line, state):
                            if event == _STREAM_DONE:
                                state.done = True
                                break
                            yield event
                        if state.done:
                            break
        except httpx.HTTPError as exc:
            raise RuntimeError(_safe_error_message(exc)) from exc
        state.raise_if_incomplete()


@dataclass
class _StreamState:
    protocol: str
    done: bool = False
    finish_reason: str = ""
    saw_content: bool = False

    def raise_if_incomplete(self) -> None:
        reason = self.finish_reason
        if reason in {"length", "max_tokens"}:
            raise LLMStreamIncomplete(
                "输出额度已用完，回答被截断；可在设置中调大输出额度后重试。"
            )
        if reason in {"content_filter", "refusal", "safety"}:
            raise LLMStreamIncomplete("回答被模型安全策略截断。")
        if self.done:
            return
        if self.saw_content:
            raise LLMStreamIncomplete("模型连接中断，回答不完整，请重试。")


@dataclass(frozen=True)
class _StreamDone:
    pass


_STREAM_DONE = _StreamDone()


def _parse_stream_event(protocol: str, line: str, state: _StreamState):
    """Return text deltas and the end marker for one provider SSE line."""
    raw = line.strip()
    if not raw:
        return []
    if protocol in {"anthropic_messages", "openai_responses"} and raw.startswith("event:"):
        return []
    if raw.startswith("data:"):
        raw = raw[5:].strip()
    if not raw:
        return []
    if raw == "[DONE]":
        state.done = True
        return [_STREAM_DONE]
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    if protocol == "anthropic_messages":
        return _parse_anthropic_event(payload, state)
    if protocol == "openai_responses":
        return _parse_responses_event(payload, state)
    return _parse_chat_event(payload, state)


def _record_finish(state: _StreamState, reason: object) -> None:
    if isinstance(reason, str) and reason:
        state.finish_reason = reason
        if reason in {"stop", "end_turn", "tool_calls", "function_call"}:
            state.done = True


def _text_delta(state: _StreamState, text: object) -> list:
    if isinstance(text, str) and text:
        state.saw_content = True
        return [text]
    return []


def _stream_error(payload: dict) -> list:
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("type") or "unknown"
    else:
        message = error
    if message:
        raise RuntimeError(f"上游错误：{str(message)[:240]}")
    return []


def _parse_chat_event(payload: dict, state: _StreamState) -> list:
    if payload.get("error"):
        return _stream_error(payload)
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    choice = choices[0] if isinstance(choices[0], dict) else {}
    delta = choice.get("delta")
    content = delta.get("content") if isinstance(delta, dict) else None
    _record_finish(state, choice.get("finish_reason"))
    return _text_delta(state, content)


def _parse_anthropic_event(payload: dict, state: _StreamState) -> list:
    if payload.get("type") == "error":
        return _stream_error(payload)
    if payload.get("type") == "content_block_delta":
        delta = payload.get("delta")
        text = delta.get("text") if isinstance(delta, dict) else None
        return _text_delta(state, text)
    if payload.get("type") == "message_delta":
        delta = payload.get("delta")
        stop_reason = delta.get("stop_reason") if isinstance(delta, dict) else None
        if stop_reason == "max_tokens":
            state.finish_reason = "max_tokens"
        elif stop_reason in {"refusal", "content_filter"}:
            state.finish_reason = "content_filter"
        elif stop_reason == "end_turn":
            state.done = True
        return []
    if payload.get("type") == "message_stop":
        state.done = True
        return [_STREAM_DONE]
    return []


def _parse_responses_event(payload: dict, state: _StreamState) -> list:
    event_type = payload.get("type")
    if event_type in {"error", "response.failed"}:
        return _stream_error(payload)
    if event_type == "response.output_text.delta":
        return _text_delta(state, payload.get("delta"))
    if event_type == "response.completed":
        response = payload.get("response")
        status = response.get("status") if isinstance(response, dict) else None
        if status == "incomplete":
            state.finish_reason = "length"
        else:
            state.done = True
        return [_STREAM_DONE] if state.done else []
    if event_type == "response.incomplete":
        state.finish_reason = "length"
        return [_STREAM_DONE]
    return []


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
    protocol = resolve_protocol(settings)
    payload: dict[str, Any] = {
        "model": _payload_model(messages),
        "messages": [_serialize_message(message) for message in messages],
        "temperature": 0.2,
    }
    max_tokens = _max_tokens(settings, protocol)
    if protocol == "openai_chat":
        if max_tokens:
            payload["max_tokens"] = max_tokens
        if json_object:
            payload["response_format"] = {"type": "json_object"}
        if settings.llm_extra_body_json:
            _merge_extra_body(payload, settings.llm_extra_body_json)
        if stream:
            payload["stream"] = True
        return payload
    if protocol == "openai_responses":
        payload["input"] = [_responses_input(message) for message in messages]
        payload.pop("messages")
        payload.pop("temperature", None)
        if max_tokens:
            payload["max_output_tokens"] = max_tokens
        if json_object:
            payload["text"] = {"format": {"type": "json_object"}}
        if settings.llm_extra_body_json:
            _merge_extra_body(payload, settings.llm_extra_body_json)
        if stream:
            payload["stream"] = True
        return payload
    system_parts = [
        message.content for message in messages if message.role == "system" and message.content
    ]
    payload.pop("messages")
    payload.pop("temperature", None)
    anthropic_messages = [
        _anthropic_message(message) for message in messages if message.role != "system"
    ]
    payload["messages"] = anthropic_messages
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if settings.llm_extra_body_json:
        _merge_extra_body(payload, settings.llm_extra_body_json)
    if stream:
        payload["stream"] = True
    return payload


_RESERVED_PAYLOAD_KEYS = {
    "model",
    "messages",
    "input",
    "system",
    "stream",
    "tools",
    "tool_choice",
    "response_format",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
}


def _merge_extra_body(payload: dict[str, Any], raw: str) -> None:
    extra_body = json.loads(raw)
    if not isinstance(extra_body, dict):
        raise ValueError("LLM_EXTRA_BODY_JSON must decode to an object")
    rejected = sorted(set(extra_body) & _RESERVED_PAYLOAD_KEYS)
    if rejected:
        raise ValueError(f"LLM_EXTRA_BODY_JSON cannot override: {', '.join(rejected)}")
    payload.update(extra_body)


def _responses_input(message: LLMMessage) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if message.content:
        parts.append({"type": "input_text", "text": message.content})
    parts.extend({"type": "input_image", "image_url": url} for url in message.images)
    if not parts:
        parts.append({"type": "input_text", "text": ""})
    return {"role": message.role, "content": parts}


def _anthropic_message(message: LLMMessage) -> dict[str, Any]:
    if not message.images:
        return {"role": message.role, "content": message.content}
    parts: list[dict[str, Any]] = []
    if message.content:
        parts.append({"type": "text", "text": message.content})
    for url in message.images:
        header, _, data = url.partition(",")
        media_type = header[5:].split(";", 1)[0] if header.startswith("data:") else ""
        if not media_type or not data:
            raise ValueError("Anthropic 协议只接受 data URL 图片")
        parts.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }
        )
    return {"role": message.role, "content": parts}


def _json_content_path() -> str:
    settings = get_settings()
    configured = settings.llm_response_content_path
    default = "choices.0.message.content"
    if configured != default:
        return configured
    protocol = resolve_protocol(settings)
    if protocol == "openai_responses":
        return "output.0.content.0.text"
    if protocol == "anthropic_messages":
        return "content.0.text"
    return configured


_MOCK_DEMO_REPLY = """## 解题思路

这是经典「**在排序数组中查找元素的第一个和最后一个位置**」问题（LeetCode 34），核心是 **两次二分查找**。

### 关键思路

1. **找第一个位置**：`nums[mid] == target` 时**不返回**，继续向左（`right = mid - 1`）。
2. **找最后一个位置**：找到后**继续向右**（`left = mid + 1`）。

### 参考实现（Python）

```python
def search_range(nums, target):
    def bound(find_first):
        left, right, ans = 0, len(nums) - 1, -1
        while left <= right:
            mid = left + (right - left) // 2  # 防溢出
            if nums[mid] == target:
                ans = mid
                if find_first:
                    right = mid - 1
                else:
                    left = mid + 1
            elif nums[mid] < target:
                left = mid + 1
            else:
                right = mid - 1
        return ans

    first = bound(True)
    if first == -1:
        return [-1, -1]
    return [first, bound(False)]
```

### 复杂度

| 指标 | 复杂度 |
|------|--------|
| 时间 | `O(log n)` |
| 空间 | `O(1)` |

> ⚠️ 区间定义要统一（本题解用左闭右闭）；`mid = left + (right - left) // 2` 防溢出。"""


def _mock_text_chunks() -> list[str]:
    override = os.environ.get("MOCK_REPLY_TEXT", "").strip()
    text = override or _MOCK_DEMO_REPLY
    return [text[index : index + 2] for index in range(0, len(text), 2)]


def _auth_headers() -> dict[str, str]:
    settings = get_settings()
    protocol = resolve_protocol(settings)
    api_key = settings.llm_api_key
    if not api_key:
        if protocol == "anthropic_messages":
            return {"anthropic-version": "2023-06-01"}
        return {}
    if protocol == "anthropic_messages" and settings.llm_auth_header in {
        "api-key",
        "Authorization",
    }:
        return {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    auth_value = f"{settings.llm_auth_scheme} {api_key}" if settings.llm_auth_scheme else api_key
    return {settings.llm_auth_header: auth_value}


def _parse_json_response(payload: Any, content_path: str) -> Any:
    content = _extract_path(payload, content_path)
    if isinstance(content, str):
        return _loads_json_content(content)
    if isinstance(content, (dict, list)):
        return content
    raise ValueError("LLM response content path did not resolve to JSON data")


def _loads_json_content(content: str) -> Any:
    """Parse JSON even when the provider wraps it in a Markdown fence.

    Several OpenAI-compatible providers return ``response_format=json_object``
    payloads as ```json ... ``` blocks anyway.  Strip a single leading fence
    and, if the rest still has prose around the object, decode the first JSON
    value instead of failing the whole request.
    """
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:] if lines and lines[0].lstrip().startswith("```") else lines
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if not starts:
            raise
        value, _ = json.JSONDecoder().raw_decode(text[min(starts) :])
        return value


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


def _log_llm_failure(schema: type, attempt: int, max_attempts: int, error: Exception) -> None:
    log_event(
        "llm.call.failed",
        schema=schema.__name__,
        attempt=attempt + 1,
        max_attempts=max_attempts,
        error=_safe_error_message(error),
    )


def _safe_error_message(error: Exception | None) -> str:
    if error is None:
        return "unknown LLM error"
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        body = response.text[:500]
        return f"HTTP {response.status_code}: {body}"
    detail = str(error) or repr(error)
    return f"{type(error).__name__}: {detail[:500]}"
