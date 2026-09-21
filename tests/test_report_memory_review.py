from __future__ import annotations

from libs.common.config import get_settings
from libs.common.database import init_db
from libs.schemas import (
    ChainLink,
    CompetencyItem,
    CompetencyModel,
    InterviewContext,
    ProbeChain,
    QATurn,
)
from services.memory_service.service import save_interview_memory
from services.report_service.service import build_report
from services.scoring_service.service import fallback_score_interview
from services.aigc_detect_service.service import detect_interview


def _context(*, cracked: bool) -> InterviewContext:
    turn = QATurn(
        interview_id="interview-review",
        question="讲讲你在结算服务里的性能优化",
        answer="我主导了结算服务的性能优化，把 P99 从 800ms 降到 200ms。",
        answer_start_ms=0,
        answer_end_ms=900,
    )
    chain = ProbeChain(
        interview_id="interview-review",
        topic="结算服务性能优化",
        origin="answer_claim",
        links=[
            ChainLink(
                probe_question="具体改了哪一段？",
                probe_target="验证个人负责边界",
                answer_turn_id=turn.turn_id,
                credibility_after="suspicious" if cracked else "solid",
            )
        ],
        verdict="cracked" if cracked else "held_up",
        crack_depth=1 if cracked else None,
    )
    return InterviewContext(
        session_id="interview-review",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=CompetencyModel(
            job_id="job-1",
            job_title="后端工程师",
            items=[
                CompetencyItem(
                    name="项目真实性",
                    weight=1.0,
                    description="能讲出个人贡献",
                    rubric="能讲出个人贡献",
                )
            ],
        ),
        turns=[turn],
        probe_chains=[chain],
    )


def _prepare(tmp_path, monkeypatch, *, memory_enabled: bool) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'review.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("MEMORY_ENABLED", "true" if memory_enabled else "false")
    get_settings.cache_clear()
    init_db()


def _build(ctx):
    aigc = detect_interview(ctx.turns, probe_chains=ctx.probe_chains)
    score = fallback_score_interview(ctx, aigc)
    return build_report(ctx, score, aigc)


def test_report_memory_review_is_empty_when_memory_is_disabled(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch, memory_enabled=False)

    report, html = _build(_context(cracked=True))

    assert report.memory_review == []
    assert "本场没有记忆命中" in html


def test_report_memory_review_marks_cracked_turns_as_conflicted(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch, memory_enabled=True)
    save_interview_memory(
        kind="probe_playbook",
        subject_key="结算服务性能优化",
        summary="追问 P99 指标的口径和归属，容易问出真实负责边界。",
        source_interview_id="interview-earlier",
    )

    ctx = _context(cracked=True)
    report, html = _build(ctx)

    assert report.memory_review
    item = report.memory_review[0]
    assert item.turn_id == ctx.turns[0].turn_id
    assert item.verdict == "conflicted"
    assert "结算服务性能优化" in item.memory_subject
    assert "复盘：记忆对照" in html


def test_report_memory_review_marks_held_up_turns_as_supported(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch, memory_enabled=True)
    save_interview_memory(
        kind="probe_playbook",
        subject_key="结算服务性能优化",
        summary="追问 P99 指标的口径和归属，容易问出真实负责边界。",
        source_interview_id="interview-earlier",
    )

    report, _ = _build(_context(cracked=False))

    assert report.memory_review[0].verdict == "supported"
