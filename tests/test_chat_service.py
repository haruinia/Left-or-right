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


@pytest.mark.parametrize("specialty", ["行测", "申论", "考研", "英语", "金融", "法学", "医学", "会计", "教师资格"])
def test_exam_presets_do_not_inject_the_saved_programming_language(specialty) -> None:
    settings = UiSettings(study_specialty=specialty, study_language="Rust", answer_language="en-US")
    preface = study_preface(settings)
    assert f"专业 / 方向：{specialty}" in preface
    assert "Rust" not in preface
    assert "Rust" not in _exam_prompt(settings)
    assert "English" in preface


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


@pytest.mark.parametrize(
    ("role", "other_role", "label"),
    [("candidate", "interviewer", "候选人"), ("interviewer", "candidate", "面试官")],
)
def test_interview_role_snapshot_overrides_preferences_without_mutating_them(role, other_role, label) -> None:
    settings = UiSettings(
        assistant_role=other_role,
        study_specialty="行测",
        study_answer_style="hints",
        resume_text="负责过订单服务",
        jd_text="需要数据库设计能力",
    )
    before = settings.model_dump()
    messages = build_chat_messages(
        ChatStreamRequest(context="interview", interview_role=role, text="如何保证订单幂等？"), settings
    )
    prompt = messages[0].content
    assert ("不要代替候选人用第一人称回答" if role == "interviewer" else "帮候选人应对一场真实进行中的面试") in prompt
    assert "只有问题确实需要时才补充" in prompt
    assert ("候选人说过的话或已经掌握的能力" if role == "interviewer" else "缺少案例时用") in prompt
    assert "行政职业能力测验" not in prompt
    assert "不要写最终答案" not in prompt
    assert settings.model_dump() == before


@pytest.mark.parametrize("role,label", [("candidate", "候选人"), ("interviewer", "面试官")])
def test_interview_role_defaults_to_the_saved_identity(role, label) -> None:
    messages = build_chat_messages(
        ChatStreamRequest(context="interview", text="介绍一下索引"), UiSettings(assistant_role=role)
    )
    assert ("不要代替候选人用第一人称回答" if role == "interviewer" else "帮候选人应对一场真实进行中的面试") in messages[0].content


@pytest.mark.parametrize("language,label", [("zh-CN", "中文"), ("en-US", "English")])
def test_interview_uses_answer_language_and_code_preference(language, label) -> None:
    messages = build_chat_messages(
        ChatStreamRequest(context="interview", text="解释并实现 LRU"),
        UiSettings(answer_language=language, study_language="Go"),
    )
    assert f"用 {label} 回答" in messages[0].content
    assert "需要代码时使用 Go" in messages[0].content


def test_interview_materials_are_labelled_user_data_and_history_stays_in_order() -> None:
    settings = UiSettings(resume_text="  简历事实A  ", jd_text="  岗位要求B  ")
    messages = build_chat_messages(
        ChatStreamRequest(
            context="interview",
            text=" 当前问题 ",
            history=[{"role": "user", "text": "前一问"}, {"role": "assistant", "text": "前一答"}],
        ),
        settings,
    )
    assert [message.role for message in messages] == ["system", "user", "user", "assistant", "user"]
    assert messages[-1].content == "当前问题"
    assert "【简历：用户提供的参考资料】\n简历事实A" in messages[1].content
    assert "【岗位 JD：用户提供的参考资料】\n岗位要求B" in messages[1].content
    assert [message.content for message in messages[2:]] == ["前一问", "前一答", "当前问题"]


def test_interview_materials_have_independent_context_bounds() -> None:
    messages = build_chat_messages(
        ChatStreamRequest(context="interview", text="介绍项目"),
        UiSettings(resume_text="甲" * 16000 + "简历尾部", jd_text="乙" * 12000 + "岗位尾部"),
    )
    assert messages[1].content.count("甲") == 16000
    assert messages[1].content.count("乙") == 12000
    assert "简历尾部" not in messages[1].content
    assert "岗位尾部" not in messages[1].content


def test_interview_without_materials_does_not_invent_a_reference_message() -> None:
    messages = build_chat_messages(ChatStreamRequest(context="interview", text="什么是哈希表？"))
    assert [message.role for message in messages] == ["system", "user"]
    assert "帮候选人应对一场真实进行中的面试" in messages[0].content
    assert "用 中文 回答" in messages[0].content
    assert "参考资料：" not in messages[-1].content


def test_default_study_messages_remain_identical_and_never_include_interview_materials(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "1024")
    get_settings.cache_clear()
    image = f"data:image/png;base64,{_PNG}"
    settings = UiSettings(resume_text="不能出现在截图请求的简历", jd_text="不能出现在截图请求的岗位")
    payload = {"images": [image], "history": [{"role": "assistant", "text": "此前回答"}]}
    messages = build_chat_messages(ChatStreamRequest(**payload), settings)
    explicit = build_chat_messages(ChatStreamRequest(**payload, context="study", interview_role="interviewer"), settings)
    assert messages == explicit
    assert [message.content for message in messages] == [
        _exam_prompt(settings), study_preface(settings), "此前回答", "请阅读这些截图，按照我的复习预设讲解题目和解题思路。"
    ]
    assert messages[-1].images == (image,)
    assert settings.resume_text not in "\n".join(message.content for message in messages)
    assert settings.jd_text not in "\n".join(message.content for message in messages)


def test_interview_image_requests_keep_image_validation_and_use_interview_fallback(monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "1024")
    get_settings.cache_clear()
    image = f"data:image/png;base64,{_PNG}"
    messages = build_chat_messages(ChatStreamRequest(context="interview", images=[image]))
    assert messages[-1].images == (image,)
    assert messages[-1].content == "请解答这些面试截图中的问题。"
    with pytest.raises(ValueError, match="unsupported image type"):
        build_chat_messages(ChatStreamRequest(context="interview", images=["data:application/pdf;base64,AAAA"]))
