from __future__ import annotations

import pytest

from libs.common.config import get_settings
from libs.schemas import ExamSolution
from services.exam_service import service as exam_service


def _solution() -> ExamSolution:
    return ExamSolution(
        question_summary="实现一个 LRU 缓存",
        key_points=["能说清 O(1) 访问", "能说清淘汰时机"],
        reference_answer="哈希表 + 双向链表。",
        pitfalls=["只用 dict 做不到 O(1) 淘汰"],
    )


def test_vision_path_marks_source_vision(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("VISION_ENABLED", "true")
    get_settings.cache_clear()

    captured: dict[str, object] = {}

    class _Client:
        def complete_json_sync(self, messages, schema, fallback, raise_on_error=False):
            captured["messages"] = messages
            return _solution()

    monkeypatch.setattr(exam_service, "get_llm_client", lambda: _Client())

    result = exam_service.solve_exam_screenshot("exam.png", b"fake-png", question_hint="缓存题")

    assert result.source == "vision"
    assert result.used_fallback is False
    assert result.key_points == ["能说清 O(1) 访问", "能说清淘汰时机"]
    messages = captured["messages"]
    assert messages[1].images and messages[1].images[0].startswith("data:image/png;base64,")


def test_vision_failure_falls_back_to_ocr(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("VISION_ENABLED", "true")
    get_settings.cache_clear()

    class _Client:
        def complete_json_sync(self, messages, schema, fallback, raise_on_error=False):
            raise RuntimeError("HTTP 500: vision unavailable")

        def complete_json_sync_with_meta(self, messages, schema, fallback, raise_on_error=False):
            return _solution(), False

    monkeypatch.setattr(exam_service, "get_llm_client", lambda: _Client())
    monkeypatch.setattr(exam_service, "extract_image_text", lambda data, suffix: "实现 LRU 缓存")

    result = exam_service.solve_exam_screenshot("exam.png", b"fake-png")

    assert result.source == "ocr_text"
    assert result.extracted_text == "实现 LRU 缓存"
    assert "视觉模型调用失败" in result.warning


def test_vision_disabled_uses_ocr_and_says_so(monkeypatch) -> None:
    monkeypatch.setenv("VISION_ENABLED", "false")
    get_settings.cache_clear()

    class _Client:
        def complete_json_sync_with_meta(self, messages, schema, fallback, raise_on_error=False):
            return fallback, True

    monkeypatch.setattr(exam_service, "get_llm_client", lambda: _Client())
    monkeypatch.setattr(exam_service, "extract_image_text", lambda data, suffix: "OCR 出来的题干")

    result = exam_service.solve_exam_screenshot("exam.png", b"fake-png")

    assert result.source == "ocr_text"
    assert result.used_fallback is True
    assert result.extracted_text == "OCR 出来的题干"
    assert "VISION_ENABLED=false" in result.warning


def test_empty_and_oversize_and_unsupported_inputs_are_rejected(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "16")
    get_settings.cache_clear()

    with pytest.raises(ValueError, match="empty"):
        exam_service.solve_exam_screenshot("exam.png", b"")
    with pytest.raises(ValueError, match="larger than"):
        exam_service.solve_exam_screenshot("exam.png", b"x" * 17)
    with pytest.raises(ValueError, match="unsupported exam screenshot type"):
        exam_service.solve_exam_screenshot("exam.pdf", b"x")


def test_exam_solution_rejects_blank_key_points() -> None:
    with pytest.raises(ValueError):
        ExamSolution(
            question_summary="题目",
            key_points=["  "],
            reference_answer="答案",
        )
    with pytest.raises(ValueError):
        ExamSolution(question_summary="题目", key_points=[], reference_answer="答案")
