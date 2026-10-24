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
    stream = get_llm_client().stream_text(messages)
    try:
        async for delta in stream:
            yield delta
    finally:
        # 客户端停止或断连时显式关闭上游，让 httpx 连接立即释放。
        await stream.aclose()


# Keep in sync with web/modules/study-presets.js and the settings datalist.
_EXAM_GUIDES = {
    "行测": "按行政职业能力测验作答：识别言语理解、数量关系、判断推理、资料分析、常识判断等题型；先给答案，再给相应解题步骤。不要写程序代码。",
    "申论": "按申论作答：先交付符合材料、体裁和字数要求的参考作答，再解释写作思路、材料概括、问题与对策；不要只给提纲，不要写程序代码。",
    "考研": "按考研科目作答：先识别科目和题型，再讲思路与关键步骤。不要默认写成编程题。",
    "英语": "按英语题作答：先给答案，再点出考点和简短解析。例句保持英文，讲解使用设置中的作答语言。",
    "金融": "按金融或经济题作答：先给结论和公式，再说明适用条件与计算步骤。",
    "法学": "按法学题作答：先给结论，再对应构成要件或法条，不确定处要标明。",
    "医学": "按医学题作答：先给结论和鉴别要点，并提醒这不能替代诊疗。",
    "会计": "按会计或财务管理题作答：先列公式和口径，再分步计算。",
    "教师资格": "按教师资格考试作答：先判断题型，再给要点和答题结构。",
}
# 系统提示词按题型给出分区和顺序，这里只调整讲解深度。
# hints 是唯一会覆盖结构要求的选项——它必须明确说「不要写答案小节」，
# 否则模型会同时看到「只给提示」和「必须有 ## 答案」两条互相否定的指令，
# 实际表现就是设置成 hints 却仍然拿到完整答案。
_CODE_STYLES = {
    "hints": "只给分层提示和关键观察。本条覆盖默认的输出结构：类型标记用 <!-- liuwa:type=reasoning -->，先写「## 解题思路」。不要写最终答案，不要给出完整可运行代码，也不要生成「## 答案」或「## 参考作答」小节。",
    "walkthrough": "按题解结构完整讲解，代码给出可直接运行的实现。",
    "solution": "按题解结构完整讲解，代码给出可直接运行的实现，并补充复杂度分析。",
}
_EXAM_STYLES = {
    "hints": "只给分层提示和关键观察。本条覆盖默认的输出结构：类型标记用 <!-- liuwa:type=reasoning -->，先写「## 解题思路」。不要给出最终答案，也不要生成「## 答案」或「## 参考作答」小节。",
    "walkthrough": "按对应题型的分区顺序完整讲解，先交付答案或参考作答。",
    "solution": "按对应题型的分区顺序完整讲解，先交付答案或参考作答，并点出易错点。",
}
_LEGACY_GOAL = "力扣刷题与笔面试复习"
_NEUTRAL_GOAL = "看懂眼前这段代码或报错"
_EXAM_GOAL = "按该考试的题型看懂题目并做对"


def study_preface(study_settings: UiSettings) -> str:
    specialty = study_settings.study_specialty.strip() or "通用学习"
    guide = _EXAM_GUIDES.get(specialty)
    # 考试方向不发送编程语言，否则模型仍会按语言生成代码。
    language = "" if guide else study_settings.study_language.strip()
    goal = study_settings.study_goal.strip() or _NEUTRAL_GOAL
    if goal == _LEGACY_GOAL:
        goal = _NEUTRAL_GOAL
    if guide and goal == _NEUTRAL_GOAL:
        goal = _EXAM_GOAL
    answer_language = "English" if study_settings.answer_language == "en-US" else "中文"
    # 中文和英文名之间留一个空格，避免出现「必须使用English」这种粘连。
    language_gap = " " if answer_language.isascii() else ""
    language_line = (
        f"作答语言：{answer_language}。除固定分区标题外，所有自然语言正文必须使用{language_gap}{answer_language}；"
        "如用户本次明确要求其他语言，以用户要求为准。"
    )
    style = (_EXAM_STYLES if guide else _CODE_STYLES)[study_settings.study_answer_style]
    identity_line = (
        "我的身份：面试官。明确解题要求照常完成；讨论面试话题时，从考察点、追问和评价依据展开，不替候选人虚构经历。"
        if study_settings.assistant_role == "interviewer"
        else "我的身份：面试者。说明可直接用于回答的要点；不要编造我的个人经历。"
    )
    lines = [
        "用户的复习预设（本次明确提问优先于默认偏好）：",
        f"专业 / 方向：{specialty}",
        language_line,
        (
            f"编程语言：{language}。除非用户本次明确要求其他语言，所有代码必须使用该语言。"
            if language
            else "编程语言：按题目要求。"
        ),
        identity_line,
        f"复习目标：{goal}",
        f"讲解方式：{style}",
    ]
    if guide:
        lines.append(f"方向要求：{guide}")
    if study_settings.study_instructions.strip():
        lines.append(f"补充偏好：{study_settings.study_instructions.strip()}")
    return "\n".join(lines)


def _exam_prompt(study_settings: UiSettings | None) -> str:
    # 行测、申论这类方向根本不该出现代码：设置页也明确告诉用户不会发送编程语言。
    # 之前无论什么方向都填 Python，系统提示词就会要求「用 Python 提供完整实现」。
    guide = _EXAM_GUIDES.get((study_settings.study_specialty.strip() if study_settings else ""))
    # 保留用户留空：主提示词里的 {language} 在留空时改说「题目指定语言」，
    # 不能再悄悄回退成 Python，否则设置里的「按题目要求」形同虚设。
    language = (study_settings.study_language.strip() if study_settings and not guide else "")
    # 语言名会被放进 ``` 代码围栏，含反引号或换行会破坏整个提示词结构。
    language = " ".join(language.split())[:40].replace("`", "")
    code_line = (
        f"编程题使用 {language} 给出完整可运行实现"
        if language
        else "编程题按题目要求的语言给出完整可运行实现"
    )
    # 作答语言写在首页提示词里：只在复习预设那一段提一句时，模型实际仍会整篇用中文作答。
    answer_language = (
        "English"
        if study_settings and study_settings.answer_language == "en-US"
        else "中文"
    )
    return (
        load_prompt("liuwa_chat.md")
        .replace("{code_line}", code_line)
        .replace("{answer_language}", answer_language)
    )


def build_chat_messages(
    payload: ChatStreamRequest, study_settings: UiSettings | None = None
) -> list[LLMMessage]:
    images = tuple(normalize_image_data_url(item) for item in payload.images)
    messages = [
        LLMMessage(role="system", content=_exam_prompt(study_settings))
    ]
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
