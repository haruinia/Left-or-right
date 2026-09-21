from __future__ import annotations

import subprocess

import pytest

from libs.common.config import get_settings
from libs.common.database import init_db
from libs.schemas import (
    CompetencyItem,
    CompetencyModel,
    InterviewContext,
    MemoryHit,
    ProbeRequest,
    QATurn,
)
from services.memory_service import repo_scan
from services.memory_service.service import (
    delete_candidate_memories,
    recall_memories,
    save_interview_memory,
    scan_repo_memories,
)


def _use_temp_db(tmp_path, monkeypatch, *, enabled: bool = True, **extra: str) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'memory.db'}")
    monkeypatch.setenv("MEMORY_ENABLED", "true" if enabled else "false")
    for key, value in extra.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    init_db()


def _make_git_repo(root) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "README.md").write_text("订单结算服务，使用 FastAPI 与 PostgreSQL。", encoding="utf-8")
    (root / "settlement.py").write_text("def settle():\n    return 1\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\nname='settlement'\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m",
         "优化结算接口性能，修掉一次超时故障"],
        cwd=root,
        check=True,
    )


def test_scanned_repo_facts_are_recallable(tmp_path, monkeypatch) -> None:
    repo = tmp_path / "roots" / "settlement"
    _make_git_repo(repo)
    _use_temp_db(tmp_path, monkeypatch, MEMORY_REPO_ROOTS=str(tmp_path / "roots"))

    written = scan_repo_memories(str(repo))
    assert written > 0

    hits = recall_memories("我在结算服务里做过 FastAPI 性能优化", limit=5)
    assert hits
    assert all(isinstance(hit, MemoryHit) for hit in hits)
    assert all(hit.kind == "project" for hit in hits)
    assert all(hit.subject.startswith("settlement · ") for hit in hits)


def test_rescanning_the_same_repo_is_idempotent(tmp_path, monkeypatch) -> None:
    repo = tmp_path / "roots" / "settlement"
    _make_git_repo(repo)
    _use_temp_db(tmp_path, monkeypatch, MEMORY_REPO_ROOTS=str(tmp_path / "roots"))

    first = scan_repo_memories(str(repo))
    second = scan_repo_memories(str(repo))
    assert first == second

    hits = recall_memories("结算服务", limit=50)
    assert len(hits) <= first


def test_repo_scan_refuses_paths_outside_the_allowlist(tmp_path, monkeypatch) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    _use_temp_db(tmp_path, monkeypatch, MEMORY_REPO_ROOTS=str(tmp_path / "roots"))

    with pytest.raises(ValueError, match="outside MEMORY_REPO_ROOTS"):
        repo_scan.resolve_repo_path(str(outside))


def test_repo_scan_refuses_when_no_roots_are_configured(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch, MEMORY_REPO_ROOTS="")

    with pytest.raises(ValueError, match="MEMORY_REPO_ROOTS is not configured"):
        repo_scan.resolve_repo_path(str(tmp_path))


def test_recall_returns_nothing_when_memory_is_disabled(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch, enabled=True)
    save_interview_memory(
        kind="candidate_profile",
        subject_key="candidate-1",
        summary="分布式事务讲得很笼统。",
        source_interview_id="interview-1",
        candidate_id="candidate-1",
    )
    assert recall_memories("分布式事务")

    monkeypatch.setenv("MEMORY_ENABLED", "false")
    get_settings.cache_clear()
    assert recall_memories("分布式事务") == []


def test_recall_honours_the_limit_and_excludes_the_current_interview(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch, MEMORY_RECALL_LIMIT="2")
    for index in range(5):
        save_interview_memory(
            kind="probe_playbook",
            subject_key=f"分布式事务-{index}",
            summary="追问两阶段提交的失败补偿细节。",
            source_interview_id=f"interview-{index}",
        )

    assert len(recall_memories("分布式事务 两阶段提交")) == 2
    excluded = recall_memories("分布式事务 两阶段提交", limit=50, exclude_interview_id="interview-0")
    assert all(hit.origin != "interview:interview-0" for hit in excluded)


def test_recall_order_is_deterministic(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch)
    for index in range(4):
        save_interview_memory(
            kind="job_insight",
            subject_key=f"岗位要点-{index}",
            summary="这个岗位需要考察消息队列积压处理。",
            source_interview_id=f"interview-{index}",
        )

    first = [hit.memory_id for hit in recall_memories("消息队列积压", limit=10)]
    second = [hit.memory_id for hit in recall_memories("消息队列积压", limit=10)]
    assert first == second


def test_save_interview_memory_validates_inputs(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="unknown interview memory kind"):
        save_interview_memory(
            kind="gossip",
            subject_key="x",
            summary="y",
            source_interview_id="interview-1",
        )
    with pytest.raises(ValueError, match="subject_key must not be blank"):
        save_interview_memory(
            kind="job_insight",
            subject_key="  ",
            summary="y",
            source_interview_id="interview-1",
        )
    with pytest.raises(ValueError, match="summary must not be blank"):
        save_interview_memory(
            kind="job_insight",
            subject_key="x",
            summary="  ",
            source_interview_id="interview-1",
        )


def test_candidate_memories_can_be_deleted(tmp_path, monkeypatch) -> None:
    _use_temp_db(tmp_path, monkeypatch)
    save_interview_memory(
        kind="candidate_profile",
        subject_key="candidate-1",
        summary="缓存穿透讲得清楚。",
        source_interview_id="interview-1",
        candidate_id="candidate-1",
    )

    assert delete_candidate_memories("candidate-1") == 1
    assert recall_memories("缓存穿透") == []
    with pytest.raises(ValueError, match="candidate_id must not be blank"):
        delete_candidate_memories("  ")


def test_probe_request_accepts_memory_hits_and_defaults_to_empty() -> None:
    competency_model = CompetencyModel(
        job_id="job-1",
        job_title="后端工程师",
        items=[CompetencyItem(
                name="项目真实性",
                weight=1.0,
                description="能讲出个人贡献",
                rubric="能讲出个人贡献",
            )],
    )
    turn = QATurn(
        interview_id="interview-1",
        question="讲讲你的结算服务",
        answer="我主导了结算服务的性能优化，把 P99 从 800ms 降到 200ms。",
    )

    bare = ProbeRequest(
        job_id="job-1",
        competency_model=competency_model,
        recent_turns=[turn],
        latest_answer=turn.answer,
    )
    assert bare.memory_hits == []

    with_memory = ProbeRequest(
        job_id="job-1",
        competency_model=competency_model,
        recent_turns=[turn],
        latest_answer=turn.answer,
        memory_hits=[
            MemoryHit(
                memory_id="m-1",
                kind="project",
                subject="settlement · 提交活动",
                summary="结算服务的性能优化提交由另一位作者完成。",
                score=0.42,
                origin="repo:settlement",
            )
        ],
    )
    assert with_memory.memory_hits[0].kind == "project"


def test_interview_context_still_builds_without_memory() -> None:
    context = InterviewContext(
        session_id="interview-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=CompetencyModel(
            job_id="job-1",
            job_title="后端工程师",
            items=[CompetencyItem(
                name="项目真实性",
                weight=1.0,
                description="能讲出个人贡献",
                rubric="能讲出个人贡献",
            )],
        ),
    )
    assert context.turns == []
