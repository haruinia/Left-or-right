from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncIterator

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import ChatStreamRequest, UiSettings

_ALLOWED_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}


async def iter_chat_deltas(
    payload: ChatStreamRequest, study_settings: UiSettings | None = None
) -> AsyncIterator[str]:
    messages = build_chat_messages(payload, study_settings)
    async for delta in get_llm_client().stream_text(messages):
        yield delta


# Keep in sync with web/modules/study-presets.js and the settings datalist.
_EXAM_GUIDES = {
    "行测": "按行政职业能力测验作答：先判断题型（言语理解、数量关系、判断推理、资料分析、常识判断），再给该题型的解题步骤和答案。不要写程序代码。",
    "申论": "按申论作答：概括材料、点明问题，并给出对策或写作结构。不要写程序代码。",
    "考研": "按考研科目作答：先识别科目和题型，再讲思路与关键步骤。不要默认写成编程题。",
    "英语": "按英语题作答：先点出考点，再给答案和简短解析。例句保持英文，讲解用中文。",
    "金融": "按金融或经济题作答：先给结论和公式，再说明适用条件与计算步骤。",
    "法学": "按法学题作答：先给结论，再对应构成要件或法条，不确定处要标明。",
    "医学": "按医学题作答：先给结论和鉴别要点，并提醒这不能替代诊疗。",
    "会计": "按会计或财务管理题作答：先列公式和口径，再分步计算。",
    "教师资格": "按教师资格考试作答：先判断题型，再给要点和答题结构。",
}
_CODE_STYLES = {
    "hints": "只给分层提示和关键观察，先不提供完整代码或最终答案。",
    "walkthrough": "先讲解题思路，再用小例子演示，最后分析复杂度和易错点；按需给代码。",
    "solution": "给出解题思路、完整参考代码、时间和空间复杂度以及边界用例。",
}
_EXAM_STYLES = {
    "hints": "只给分层提示和关键观察，先不给出最终答案。",
    "walkthrough": "先讲题型和解题思路，再用小例子演示，最后点出易错点。",
    "solution": "给出题型判断、解题步骤、答案和易错点。",
}
_LEGACY_GOAL = "力扣刷题与笔面试复习"
_NEUTRAL_GOAL = "看懂眼前这段代码或报错"
_EXAM_GOAL = "按该考试的题型看懂题目并做对"


def study_preface(study_settings: UiSettings) -> str:
    specialty = study_settings.study_specialty.strip() or "通用学习"
    guide = _EXAM_GUIDES.get(specialty)
    language = study_settings.study_language.strip()
    goal = study_settings.study_goal.strip() or _NEUTRAL_GOAL
    if goal == _LEGACY_GOAL:
        goal = _NEUTRAL_GOAL
    if guide and goal == _NEUTRAL_GOAL:
        goal = _EXAM_GOAL
    language_line = "作答语言：中文" if guide else f"语言偏好：{language or '按题目要求'}"
    style = (_EXAM_STYLES if guide else _CODE_STYLES)[study_settings.study_answer_style]
    lines = [
        "用户的复习预设（本次明确提问优先于默认偏好）：",
        f"专业 / 方向：{specialty}",
        language_line,
        f"复习目标：{goal}",
        f"讲解方式：{style}",
    ]
    if guide:
        lines.append(f"方向要求：{guide}")
    lines.append(f"补充偏好：{study_settings.study_instructions.strip()}")
    return "\n".join(lines)


def build_chat_messages(
    payload: ChatStreamRequest, study_settings: UiSettings | None = None
) -> list[LLMMessage]:
    images = tuple(normalize_image_data_url(item) for item in payload.images)
    messages = [LLMMessage(role="system", content=load_prompt("liuwa_chat.md"))]
    if study_settings is not None:
        messages.append(LLMMessage(role="system", content=study_preface(study_settings)))
    for turn in payload.history:
        text = turn.text.strip()
        if not text:
            continue
        messages.append(LLMMessage(role=turn.role, content=text))
    user_text = payload.text.strip() or (
        "请阅读这些截图，按照我的复习预设讲解题目和解题思路。" if images else ""
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
