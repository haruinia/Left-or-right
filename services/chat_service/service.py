from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncIterator

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import ChatStreamRequest

_ALLOWED_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}


async def iter_chat_deltas(payload: ChatStreamRequest) -> AsyncIterator[str]:
    messages = build_chat_messages(payload)
    async for delta in get_llm_client().stream_text(messages):
        yield delta


def build_chat_messages(payload: ChatStreamRequest) -> list[LLMMessage]:
    images = tuple(normalize_image_data_url(item) for item in payload.images)
    messages = [LLMMessage(role="system", content=load_prompt("liuwa_chat.md"))]
    for turn in payload.history:
        text = turn.text.strip()
        if not text:
            continue
        messages.append(LLMMessage(role=turn.role, content=text))
    user_text = payload.text.strip() or (
        "请阅读这些截图，直接给出屏幕上问题的答案或要点。" if images else ""
    )
    messages.append(LLMMessage(role="user", content=user_text, images=images))
    return messages


def normalize_image_data_url(raw: str) -> str:
    value = raw.strip()
    if not value.startswith("data:"):
        raise ValueError("image must be a data URL")
    header, separator, payload = value.partition(",")
    if not separator or not payload.strip():
        raise ValueError("image data URL is empty")
    mime = "image/png"
    if header.startswith("data:") and ";" in header:
        mime = header[5:].split(";", 1)[0].strip().lower() or mime
    if mime not in _ALLOWED_IMAGE_TYPES:
        raise ValueError(f"unsupported image type: {mime}")
    try:
        data = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image data URL is not valid base64") from exc
    if not data:
        raise ValueError("image is empty")
    settings = get_settings()
    if len(data) > settings.vision_max_image_bytes:
        raise ValueError(f"image is larger than {settings.vision_max_image_bytes} bytes")
    if mime == "image/jpg":
        mime = "image/jpeg"
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"
