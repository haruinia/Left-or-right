from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import ExamSolution
from services.document_service.service import IMAGE_SUFFIXES, extract_image_text

VISION_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def solve_exam_screenshot(
    filename: str,
    data: bytes,
    *,
    question_hint: str = "",
) -> ExamSolution:
    if not data:
        raise ValueError("exam screenshot is empty")
    settings = get_settings()
    if len(data) > settings.vision_max_image_bytes:
        raise ValueError(
            f"exam screenshot is larger than {settings.vision_max_image_bytes} bytes"
        )
    suffix = Path(filename).suffix.lower()
    if suffix and suffix not in IMAGE_SUFFIXES:
        raise ValueError(f"unsupported exam screenshot type: {suffix}")

    if settings.vision_enabled:
        try:
            return _solve_with_vision(data, suffix, question_hint=question_hint)
        except Exception as exc:  # noqa: BLE001 - fall back to OCR on any vision failure
            vision_warning = _safe_warning(exc)
        else:
            vision_warning = ""
    else:
        vision_warning = "视觉模型未开启（VISION_ENABLED=false），已回退到本地 OCR。"

    return _solve_with_ocr(data, suffix, question_hint=question_hint, warning=vision_warning)


def _solve_with_vision(data: bytes, suffix: str, *, question_hint: str) -> ExamSolution:
    mime = VISION_MIME_TYPES.get(suffix) or mimetypes.guess_type(f"x{suffix}")[0] or "image/png"
    data_url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    messages = [
        LLMMessage(role="system", content=load_prompt("exam_solve.md")),
        LLMMessage(
            role="user",
            content=json.dumps({"question_hint": question_hint}, ensure_ascii=False),
            images=(data_url,),
        ),
    ]
    solution = get_llm_client().complete_json_sync(
        messages,
        ExamSolution,
        _placeholder_solution(),
        raise_on_error=True,
    )
    return solution.model_copy(update={"source": "vision", "used_fallback": False})


def _solve_with_ocr(
    data: bytes,
    suffix: str,
    *,
    question_hint: str,
    warning: str,
) -> ExamSolution:
    text = extract_image_text(data, suffix or ".png")
    messages = [
        LLMMessage(role="system", content=load_prompt("exam_solve.md")),
        LLMMessage(
            role="user",
            content=json.dumps(
                {"question_hint": question_hint, "exam_text": text},
                ensure_ascii=False,
            ),
        ),
    ]
    solution, used_fallback = get_llm_client().complete_json_sync_with_meta(
        messages,
        ExamSolution,
        _ocr_only_solution(text),
    )
    merged_warning = "；".join(part for part in (warning, solution.warning) if part.strip())
    return solution.model_copy(
        update={
            "source": "ocr_text",
            "used_fallback": used_fallback,
            "extracted_text": text,
            "warning": merged_warning,
        }
    )


def _placeholder_solution() -> ExamSolution:
    return ExamSolution(
        question_summary="未能解析笔试题目。",
        key_points=["请人工查看截图内容。"],
        reference_answer="模型未返回可用结果，请人工判断。",
    )


def _ocr_only_solution(text: str) -> ExamSolution:
    return ExamSolution(
        question_summary="仅完成 OCR 文本提取，未生成评分要点。",
        key_points=["模型未配置或调用失败，请人工阅读下方 OCR 文本。"],
        reference_answer="模型不可用，请人工判断。",
        extracted_text=text,
    )


def _safe_warning(error: Exception) -> str:
    detail = str(error) or type(error).__name__
    return f"视觉模型调用失败，已回退到本地 OCR：{detail[:200]}"
