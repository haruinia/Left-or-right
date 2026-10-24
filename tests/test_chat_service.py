from __future__ import annotations

import base64

import pytest

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.schemas import ChatStreamRequest, UiSettings
from services.chat_service.service import (
    _exam_prompt,
    build_chat_messages,
    normalize_image_data_url,
    study_preface,
)

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
        .replace("{code_line}", "编程题按题目要求的语言给出完整可运行实现")
        .replace("{answer_language}", "中文")
    )
    assert messages[0].content == expected
    assert "{code_line}" not in messages[0].content
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


def test_study_preface_enforces_selected_answer_and_code_language() -> None:
    preface = study_preface(UiSettings(study_language="Go", answer_language="en-US"))
    assert "所有自然语言正文必须使用 English" in preface
    assert "所有代码必须使用该语言" in preface
    blank = study_preface(UiSettings(study_language="", answer_language="zh-CN"))
    assert "编程语言：按题目要求。" in blank


def test_english_direction_does_not_force_chinese_explanation() -> None:
    settings = UiSettings(study_specialty="英语", answer_language="en-US")
    assert "讲解用中文" not in _exam_prompt(settings)
    assert "正文语言：English" in _exam_prompt(settings)
    assert "编程题按题目要求的语言" in _exam_prompt(settings)


def test_normalize_image_rejects_empty_and_oversize(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "8")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="empty"):
        normalize_image_data_url("data:image/png;base64,")
    with pytest.raises(ValueError, match="larger than"):
        normalize_image_data_url(f"data:image/png;base64,{base64.b64encode(b'123456789').decode()}")
    with pytest.raises(ValueError, match="unsupported image type"):
        normalize_image_data_url("data:application/pdf;base64,AAAA")
