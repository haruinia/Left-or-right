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
from services.memory_service import distill as distill_module
from services.memory_service.distill import distill_interview_memories
from services.memory_service.service import recall_memories


def _context() -> InterviewContext:
    turn = QATurn(
        interview_id="interview-1",
        question="讲讲你的分布式事务方案",
        answer="我们用了两阶段提交，具体补偿逻辑是同事写的。",
    )
    chain = ProbeChain(
        interview_id="interview-1",
        topic="分布式事务",
        origin="answer_claim",
        links=[
            ChainLink(
                probe_question="补偿失败时怎么兜底？",
                probe_target="验证个人负责边界",
                answer_turn_id=turn.turn_id,
                credibility_after="suspicious",
            )
        ],
        verdict="cracked",
        crack_depth=1,
    )
    return InterviewContext(
        session_id="interview-1",
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


def _prepare(tmp_path, monkeypatch, *, enabled: bool = True) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'distill.db'}")
    monkeypatch.setenv("MEMORY_ENABLED", "true" if enabled else "false")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    get_settings.cache_clear()
    init_db()


def test_distillation_requires_memory_enabled(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch, enabled=False)
    monkeypatch.setattr(distill_module, "has_active_consent", lambda *_: True)

    assert distill_interview_memories(_context()) == []


def test_distillation_requires_long_term_memory_consent(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch)
    seen: list[tuple[str, str]] = []

    def fake_consent(candidate_id: str, consent_type: str) -> bool:
        seen.append((candidate_id, consent_type))
        return False

    monkeypatch.setattr(distill_module, "has_active_consent", fake_consent)

    assert distill_interview_memories(_context()) == []
    assert seen == [("candidate-1", "long_term_memory")]


def test_deterministic_fallback_writes_recallable_memory(tmp_path, monkeypatch) -> None:
    _prepare(tmp_path, monkeypatch)
    monkeypatch.setattr(distill_module, "has_active_consent", lambda *_: True)

    written = distill_interview_memories(_context(), score_summary="hold")

    kinds = [item.kind for item in written]
    assert kinds.count("candidate_profile") == 1
    assert "probe_playbook" in kinds
    assert any("hold" in item.summary for item in written if item.kind == "candidate_profile")

    hits = recall_memories("分布式事务", limit=10)
    assert any(hit.kind == "probe_playbook" for hit in hits)


def test_distillation_caps_items_per_kind(tmp_path, monkeypatch) -> None:
    from libs.schemas import DistilledMemory, DistilledMemoryItem

    _prepare(tmp_path, monkeypatch)
    monkeypatch.setattr(distill_module, "has_active_consent", lambda *_: True)

    overflow = DistilledMemory(
        items=[
            DistilledMemoryItem(kind="candidate_profile", subject_key="c1", summary="一"),
            DistilledMemoryItem(kind="candidate_profile", subject_key="c1b", summary="二"),
            *[
                DistilledMemoryItem(kind="probe_playbook", subject_key=f"t{i}", summary="套路")
                for i in range(5)
            ],
        ]
    )
    monkeypatch.setattr(distill_module, "_distill", lambda *_: overflow)

    written = distill_interview_memories(_context())
    kinds = [item.kind for item in written]

    assert kinds.count("candidate_profile") == 1
    assert kinds.count("probe_playbook") == 4
