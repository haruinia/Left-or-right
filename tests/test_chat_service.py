from __future__ import annotations

import base64

import pytest

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.schemas import ChatStreamRequest, UiSettings
from services.chat_service.service import build_chat_messages, normalize_image_data_url, study_preface

_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def test_build_chat_messages_uses_liuwa_prompt_and_images(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "1024")
    get_settings.cache_clear()
    data_url = f"data:image/png;base64,{_PNG}"
    messages = build_chat_messages(
        ChatStreamRequest(text="", images=[data_url], history=[{"role": "user", "text": "上一问"}])
    )
    assert messages[0].role == "system"
    assert messages[0].content == load_prompt("liuwa_chat.md").replace("{language}", "Python")
    assert "{language}" not in messages[0].content
    assert messages[1].content == "上一问"
    assert messages[-1].images == (data_url,)
    assert "截图" in messages[-1].content


def test_study_preface_enforces_selected_answer_and_code_language() -> None:
    preface = study_preface(UiSettings(study_language="Go", answer_language="en-US"))
    assert "所有自然语言正文必须使用 English" in preface
    assert "所有代码必须使用该语言" in preface


def test_normalize_image_rejects_empty_and_oversize(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "8")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="empty"):
        normalize_image_data_url("data:image/png;base64,")
    with pytest.raises(ValueError, match="larger than"):
        normalize_image_data_url(f"data:image/png;base64,{base64.b64encode(b'123456789').decode()}")
    with pytest.raises(ValueError, match="unsupported image type"):
        normalize_image_data_url("data:application/pdf;base64,AAAA")
