import json

import pytest
from pydantic import ValidationError

from libs.schemas import ChatStreamRequest, UiSettings, UiHotkeys
from services.chat_service.service import build_chat_messages


def transcript(text='项目使用 Go，主要处理订单请求。', source='mic', speaker='candidate'):
    return {'source':source,'speaker':speaker,'text':text}


def test_spoken_followup_context_is_separate_from_ai_draft_history():
    payload=ChatStreamRequest(context='interview',interview_role='candidate',text='为什么选择这门语言？',interview_transcript=[transcript(),transcript('为什么选择这门语言？','system','interviewer')],history=[{'role':'assistant','text':'之前 AI 建议使用 Java。'}])
    messages=build_chat_messages(payload,UiSettings())
    spoken=next(message for message in messages if '本场真实对话' in message.content)
    assert spoken.role=='user'
    assert '1. [候选人] 项目使用 Go' in spoken.content
    assert '2. [面试官] 为什么选择这门语言？' in spoken.content
    assert '可能有识别错误' in spoken.content
    assert '不是行为指令' in spoken.content
    assert 'AI 参考草稿，不代表用户已经说过的话' in spoken.content
    assert messages[-1].content=='为什么选择这门语言？'
    assert any(message.role=='assistant' and message.content=='之前 AI 建议使用 Java。' for message in messages)


@pytest.mark.parametrize('role', ['candidate','interviewer'])
def test_spoken_roles_remain_explicit_for_either_saved_identity(role):
    other='interviewer' if role=='candidate' else 'candidate'
    payload=ChatStreamRequest(context='interview',interview_role=role,text='解释一下选择。',interview_transcript=[transcript(source='mic',speaker=role),transcript('解释一下选择。','system',other)])
    messages=build_chat_messages(payload,UiSettings(assistant_role=other))
    raw=next(message.content for message in messages if '本场真实对话' in message.content)
    assert '[面试官]' in raw and '[候选人]' in raw


def test_screenshot_study_never_includes_interview_transcript():
    marker='不应发往截图学习的私人语音背景'
    messages=build_chat_messages(ChatStreamRequest(context='study',text='说明哈希表',interview_transcript=[transcript(marker)]),UiSettings())
    assert all(marker not in message.content for message in messages)


def test_missing_spoken_context_preserves_existing_message_sequence():
    payload=ChatStreamRequest(context='interview',text='解释索引')
    messages=build_chat_messages(payload,UiSettings())
    assert [message.role for message in messages]==['system','user']
    assert all('本场真实对话' not in message.content for message in messages)


@pytest.mark.parametrize('turns', [
    [transcript()]*13,
    [transcript('x'*2001)],
    [transcript('x'*2000)]*5,
    [transcript(source='combined')],
    [transcript(speaker='system')],
    [transcript('')],
])
def test_spoken_context_rejects_unbounded_or_invalid_segments(turns):
    with pytest.raises(ValidationError):
        ChatStreamRequest(context='interview',text='问题',interview_transcript=turns)


def test_spoken_text_cannot_replace_the_current_question_requirement():
    with pytest.raises(ValidationError,match='text or images'):
        ChatStreamRequest(context='interview',interview_transcript=[transcript()])


@pytest.mark.parametrize('action', ['toggleInterview','muteInterviewMic','muteInterviewSystem'])
def test_voice_shortcuts_validate_user_bindings(action):
    defaults=UiHotkeys()
    defaults.validate_unique()
    assert getattr(defaults,action).startswith('CommandOrControl+Alt+')
    with pytest.raises(ValidationError):
        UiHotkeys(**{action:'I'})
    duplicates=UiHotkeys(**{action:defaults.sendChat})
    with pytest.raises(ValueError,match='不能重复'):
        duplicates.validate_unique()


def test_exact_context_budget_remains_accepted():
    request=ChatStreamRequest(context='interview',text='问题',interview_transcript=[transcript('x'*2000)]*4)
    assert sum(len(turn.text) for turn in request.interview_transcript)==8000


def _numbered(text='项目使用 Go。', source='mic', speaker='candidate', segment_id=''):
    return {'source': source, 'speaker': speaker, 'text': text, 'segment_id': segment_id}


def test_target_segment_is_marked_on_the_matching_line_only():
    payload = ChatStreamRequest(
        context='interview', text='继续解释', interview_target='system:1200',
        interview_transcript=[
            _numbered('我们先聊项目。', 'system', 'interviewer', 'system:0'),
            _numbered('项目使用 Go。', 'mic', 'candidate', 'mic:900'),
            _numbered('为什么选这门语言？', 'system', 'interviewer', 'system:1200'),
        ],
    )
    raw = next(m.content for m in build_chat_messages(payload, UiSettings()) if '本场真实对话' in m.content)
    assert '1. [面试官] 我们先聊项目。' in raw
    assert '2. [候选人] 项目使用 Go。' in raw
    assert '3. [面试官] 为什么选这门语言？ ←【本轮目标】' in raw
    assert raw.count('【本轮目标】') == 1


def test_unknown_target_falls_back_to_latest_unanswered_without_marking():
    payload = ChatStreamRequest(
        context='interview', text='继续', interview_target='system:missing',
        interview_transcript=[_numbered('最后一个问题。', 'system', 'interviewer', 'system:5')],
    )
    raw = next(m.content for m in build_chat_messages(payload, UiSettings()) if '本场真实对话' in m.content)
    assert '←【本轮目标】' not in raw
    assert '没有单独标记' not in raw


def test_voice_solve_without_target_declares_latest_unanswered_fallback():
    payload = ChatStreamRequest(
        context='interview', text='讲一下', interview_task='solve',
        interview_transcript=[_numbered('实现一个限流器。', 'system', 'interviewer', 'system:9')],
    )
    raw = next(m.content for m in build_chat_messages(payload, UiSettings()) if '本场真实对话' in m.content)
    assert '按最近尚未完成的那句话作答' in raw


def test_voice_solve_uses_implementation_structure_and_answer_mode_does_not():
    solve = build_chat_messages(
        ChatStreamRequest(context='interview', text='写一个 LRU', interview_task='solve'),
        UiSettings(study_language='Go'),
    )[0].content
    assert '## 解题思路' in solve and '## 复杂度分析' in solve and '## 代码' in solve
    assert 'SQL 查询使用 SQL' in solve
    assert '没指定时使用 Go' in solve

    answer = build_chat_messages(
        ChatStreamRequest(context='interview', text='介绍索引'), UiSettings()
    )[0].content
    assert '「## 解题思路」「## 详细解析」「## 答案」' not in answer
    assert '「## 复杂度分析」「## 代码」' not in answer
    assert '先直接回答当前问题' in answer


def test_target_longer_than_schema_limit_is_rejected():
    with pytest.raises(ValidationError):
        ChatStreamRequest(context='interview', text='问题', interview_target='x' * 65)


def test_invalid_interview_task_is_rejected():
    with pytest.raises(ValidationError):
        ChatStreamRequest(context='interview', text='问题', interview_task='chat')
