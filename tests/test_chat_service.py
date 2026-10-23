from __future__ import annotations

import base64

import pytest

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.schemas import ChatStreamRequest, UiSettings
from services.chat_service.service import _exam_prompt, build_chat_messages, normalize_image_data_url

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
    expected = (
        load_prompt("liuwa_chat.md")
        .replace("{language}", "Python")
        .replace("{answer_language}", "中文")
    )
    assert messages[0].content == expected
    assert "{language}" not in messages[0].content
    assert "{answer_language}" not in messages[0].content
    assert messages[1].content == "上一问"
    assert messages[-1].images == (data_url,)
    assert "截图" in messages[-1].content


def test_exam_direction_still_honours_the_answer_language() -> None:
    # 行测等方向不发送编程语言，但作答语言仍是用户的选择；两者不能绑在一起。
    settings = UiSettings(study_specialty="行测", study_language="Python", answer_language="en-US")
    content = _exam_prompt(settings)
    assert "正文语言：English" in content
    assert "正文语言：中文" in _exam_prompt(UiSettings())


def test_normalize_image_rejects_empty_and_oversize(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "8")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="empty"):
        normalize_image_data_url("data:image/png;base64,")
    with pytest.raises(ValueError, match="larger than"):
        normalize_image_data_url(f"data:image/png;base64,{base64.b64encode(b'123456789').decode()}")
    with pytest.raises(ValueError, match="unsupported image type"):
        normalize_image_data_url("data:application/pdf;base64,AAAA")
