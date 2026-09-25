"""内容级回声消除：麦克风(面试官)路转写出与扬声器(候选人)近期内容高度相似的文本时，
判定为外放串音并抑制；真实问题、无候选人参考、超时间窗口则不抑制。"""
from __future__ import annotations

from libs.schemas import TranscriptSegment
from services.gateway.app import (
    ECHO_TIME_WINDOW_MS,
    _DialogueSessionRuntime,
    _suppress_candidate_echo,
)
from services.interview_orchestrator.dialogue import DialogueAssembler


def _runtime() -> _DialogueSessionRuntime:
    return _DialogueSessionRuntime(assembler=DialogueAssembler(silence_close_ms=2500))


def _seg(speaker: str, text: str, end_ms: int) -> TranscriptSegment:
    return TranscriptSegment(
        session_id="sess",
        speaker=speaker,  # type: ignore[arg-type]
        text=text,
        start_ms=max(0, end_ms - 1500),
        end_ms=end_ms,
        is_final=True,
        confidence=0.9,
    )


def test_mic_echo_of_candidate_is_suppressed() -> None:
    rt = _runtime()
    answer = "我负责支付对账系统的增量对账和分片并行优化"
    # 扬声器(候选人)先转写出回答 → 进参考缓冲，不抑制。
    assert _suppress_candidate_echo(rt, _seg("candidate", answer, 5000)) is False
    # 麦克风(面试官)拾取到外放回声，转写出几乎相同的文本 → 应判定回声并抑制。
    echo = _seg("interviewer", answer, 5400)
    assert _suppress_candidate_echo(rt, echo) is True


def test_genuine_interviewer_question_not_suppressed() -> None:
    rt = _runtime()
    _suppress_candidate_echo(rt, _seg("candidate", "我做了增量对账和水位线设计", 5000))
    question = _seg("interviewer", "那你怎么保证对账不漏单？", 6000)
    assert _suppress_candidate_echo(rt, question) is False


def test_no_candidate_reference_never_suppresses() -> None:
    # 没接会议声音：候选人参考缓冲为空，麦克风内容永不被误删。
    rt = _runtime()
    assert _suppress_candidate_echo(rt, _seg("interviewer", "请做个自我介绍。", 3000)) is False


def test_echo_outside_time_window_not_suppressed() -> None:
    rt = _runtime()
    answer = "我用账务流水的版本号做水位线只拉增量"
    _suppress_candidate_echo(rt, _seg("candidate", answer, 1000))
    late = _seg("interviewer", answer, 1000 + ECHO_TIME_WINDOW_MS + 2000)
    assert _suppress_candidate_echo(rt, late) is False
