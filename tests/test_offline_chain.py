from __future__ import annotations

import builtins
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest

from libs.common.config import get_settings
from libs.common.database import connect, init_db, loads
from libs.common.events import event_bus
from libs.common.tasks import task_queue
from libs.schemas import (
    CandidateCreate,
    AIGCResult,
    CompetencyItem,
    CompetencyModel,
    ConsentCreate,
    ConsistencyFlag,
    CredibilitySignal,
    DimensionScore,
    EvidenceRef,
    InterviewCreate,
    InterviewContext,
    InterviewRecord,
    InterviewScore,
    InterviewStatus,
    JobCreate,
    JobRecord,
    ProbeRequest,
    ProbeResponse,
    ProbeSuggestion,
    QATurn,
    TranscriptSegment,
)
from services.aigc_detect_service.service import detect_interview, load_templates
from services.interview_orchestrator.consistency import detect_consistency, extract_fact_claim
from services.interview_orchestrator.service import (
    add_turn,
    create_candidate,
    create_consent,
    create_interview,
    end_interview,
    finish_interview,
    get_interview,
    list_turns,
    run_offline_scoring_task,
    should_probe,
    start_interview,
)
from services.jd_kb_service.service import (
    _index_probe_patterns,
    _pgvector_literal,
    create_job,
    generate_competency_model,
    retrieve_job_probe_patterns,
)
from libs.common.prompts import load_prompt
from services.probe_service.service import fallback_probe, generate_probe
from services.report_service.service import build_report
from services.scoring_service.service import fallback_score_interview, score_interview


@pytest.fixture(autouse=True)
def clear_settings_cache_between_tests():
    yield
    get_settings.cache_clear()


def _aigc_results_for(*turns: QATurn, flagged: bool = False) -> list[AIGCResult]:
    return [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.7 if flagged else 0.2,
            template_similarity=0.5 if flagged else 0.1,
            flagged=flagged,
        )
        for turn in turns
    ]


def test_offline_interview_chain(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="AI Engineer", jd_text="Python FastAPI LLM"))
    candidate = create_candidate(CandidateCreate(name="Ada"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    assert interview.context.session_id == interview.id
    add_turn(
        interview.id,
        QATurn(
            question="Tell me about a project.",
            answer="我主要负责整体架构设计并推动项目落地最终取得显著提升",
            answer_start_ms=0,
            answer_end_ms=1000,
        ),
    )
    report = end_interview(interview.id)
    persisted = get_interview(interview.id)
    assert report.score.total_score > 0
    assert report.aigc_results
    assert report.transcript
    assert report.transcript[0].answer == "我主要负责整体架构设计并推动项目落地最终取得显著提升"
    assert (tmp_path / "reports" / "001-Ada.report.json").exists()
    assert (tmp_path / "reports" / "001-Ada.html").exists()
    assert (tmp_path / "reports" / "001-Ada.transcript.json").exists()
    pdf_name = Path(report.pdf_path or "").name
    assert pdf_name.startswith(("合格-Ada-", "不合格-Ada-"))
    assert pdf_name.endswith(f"{report.score.total_score}.pdf")
    assert (tmp_path / "reports" / pdf_name).exists()
    report_json = loads(Path(report.json_path or "").read_text(encoding="utf-8"))
    html = Path(report.html_path or "").read_text(encoding="utf-8")
    pdf_bytes = Path(report.pdf_path or "").read_bytes()
    transcript_json = loads(Path(report.transcript_path or "").read_text(encoding="utf-8"))
    assert "data:image/png;base64" in html
    assert "亮点" in html
    assert "背稿与模板化检测" in html
    assert "本报告由确定性规则生成" in html
    assert "ai_generated_prob" not in html
    assert "疑似注水/模板化" in html
    assert "完整转写" in html
    assert report.transcript[0].answer in html
    assert report_json["interview_id"] == interview.id
    assert report_json["artifact_uris"]["json"].startswith("file://")
    assert report.artifact_uris["json"].startswith("file://")
    assert report.artifact_uris["html"].startswith("file://")
    assert report.artifact_uris["pdf"].startswith("file://")
    assert report.artifact_uris["transcript"].startswith("file://")
    assert pdf_bytes.startswith(b"%PDF")
    assert transcript_json["qa_turns"][0]["answer"] == report.transcript[0].answer
    assert "full_transcript" in transcript_json
    assert persisted.status == InterviewStatus.reported
    assert persisted.context.fact_claims
    assert persisted.context.fact_claims[0].turn_id == report.transcript[0].turn_id
    assert [turn.turn_id for turn in list_turns(interview.id)]
    assert [topic for topic, _ in event_bus.history()] == [
        "qa_turn.created",
        "interview.finished",
        "task.enqueued",
        "interview.scoring_started",
        "interview.reported",
        "task.completed",
    ]
    tasks = task_queue.history("interview.offline_scoring")
    assert len(tasks) == 1
    assert tasks[0].status == "completed"


def test_add_turn_auto_starts_created_interview(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'auto-start.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))

    record = add_turn(interview.id, QATurn(question="讲项目", answer="我写了 FastAPI 编排。"))

    assert record.status == InterviewStatus.in_progress
    assert record.started_at is not None
    assert record.context.started_at == record.started_at
    assert get_interview(interview.id).status == InterviewStatus.in_progress


def test_offline_pipeline_exposes_scoring_state(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'pipeline.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    add_turn(
        interview.id,
        QATurn(
            question="讲项目",
            answer="我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
            answer_start_ms=100,
            answer_end_ms=1200,
        ),
    )

    finished = finish_interview(interview.id)
    assert finished.status == InterviewStatus.finished
    assert get_interview(interview.id).status == InterviewStatus.finished

    report = run_offline_scoring_task(interview.id)

    assert report.interview_id == interview.id
    assert get_interview(interview.id).status == InterviewStatus.reported
    topics = [topic for topic, _ in event_bus.history()]
    assert "interview.scoring_started" in topics
    assert "interview.reported" in topics


def test_offline_scoring_requires_finished_state(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'state.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))

    with pytest.raises(ValueError, match="offline scoring requires FINISHED or SCORING"):
        run_offline_scoring_task(interview.id)


def test_interview_cannot_finish_without_candidate_turns(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'empty.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))

    with pytest.raises(ValueError, match="cannot finish interview from status CREATED"):
        finish_interview(interview.id)
    with pytest.raises(ValueError, match="cannot finish interview from status CREATED"):
        end_interview(interview.id)
    assert get_interview(interview.id).status == InterviewStatus.created

    start_interview(interview.id)
    with pytest.raises(ValueError, match="cannot finish interview without candidate turns"):
        finish_interview(interview.id)
    with pytest.raises(ValueError, match="cannot finish interview without candidate turns"):
        end_interview(interview.id)

    assert get_interview(interview.id).status == InterviewStatus.in_progress


def test_scoring_requires_candidate_turn_evidence() -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    ctx = InterviewContext(
        session_id="session-empty",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[],
    )

    with pytest.raises(ValueError, match="cannot score interview without candidate turns"):
        score_interview(ctx, [])


def test_scoring_requires_aigc_results_for_every_turn() -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(question="讲项目", answer="我写了 FastAPI 编排。")
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )

    with pytest.raises(ValueError, match="AIGC results must cover every transcript turn"):
        score_interview(ctx, [])
    with pytest.raises(ValueError, match="AIGC results must not contain duplicate"):
        score_interview(ctx, [*_aigc_results_for(turn), *_aigc_results_for(turn)])
    with pytest.raises(ValueError, match="AIGC result references unknown turn_id"):
        score_interview(
            ctx,
            [AIGCResult(turn_id="missing-turn", ai_generated_prob=0.2, template_similarity=0.1)],
        )


def test_interview_requires_existing_candidate(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'refs.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))

    with pytest.raises(KeyError, match="candidate not found"):
        create_interview(InterviewCreate(job_id=job.id, candidate_id="missing-candidate"))


def test_behavior_signal_consent_requires_existing_candidate(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'consent-ref.db'}")
    get_settings.cache_clear()
    init_db()

    with pytest.raises(KeyError, match="candidate not found"):
        create_consent(ConsentCreate(candidate_id="missing-candidate", granted=True))


def test_interview_state_machine_rejects_post_report_mutations(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'reported.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    add_turn(interview.id, QATurn(question="讲项目", answer="我写了 FastAPI 编排。"))

    end_interview(interview.id)

    with pytest.raises(ValueError, match="cannot add turn"):
        add_turn(interview.id, QATurn(question="补充", answer="继续补充"))
    with pytest.raises(ValueError, match="cannot start interview"):
        start_interview(interview.id)
    with pytest.raises(ValueError, match="cannot finish interview"):
        finish_interview(interview.id)


def test_end_interview_can_queue_offline_scoring_without_running_it(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'async.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    add_turn(
        interview.id,
        QATurn(
            question="讲项目",
            answer="我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
        ),
    )

    accepted = end_interview(interview.id, execute_inline=False)

    assert accepted.status == "queued"
    assert accepted.interview_id == interview.id
    assert accepted.task_name == "interview.offline_scoring"
    assert get_interview(interview.id).status == InterviewStatus.scoring
    assert task_queue.history("interview.offline_scoring")[0].status == "queued"
    assert [topic for topic, _ in event_bus.history()][-2:] == [
        "interview.finished",
        "task.enqueued",
    ]

    report = run_offline_scoring_task(interview.id)

    assert report.interview_id == interview.id
    assert get_interview(interview.id).status == InterviewStatus.reported


def test_async_end_interview_rejects_duplicate_queueing(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'async-duplicate.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Grace"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    add_turn(interview.id, QATurn(question="讲项目", answer="我写了 FastAPI 编排。"))

    first = end_interview(interview.id, execute_inline=False)

    assert first.status == "queued"
    assert get_interview(interview.id).status == InterviewStatus.scoring
    with pytest.raises(ValueError, match="cannot finish interview from status SCORING"):
        end_interview(interview.id, execute_inline=False)
    assert len(task_queue.history("interview.offline_scoring")) == 1


def test_report_artifact_uris_use_object_storage_when_configured(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'object.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("OBJECT_STORAGE_ENDPOINT", "http://minio:9000")
    monkeypatch.setenv("OBJECT_STORAGE_BUCKET", "reports-bucket")
    get_settings.cache_clear()
    event_bus.reset()
    task_queue.reset()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Lin"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    add_turn(
        interview.id,
        QATurn(
            question="讲项目",
            answer="我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
        ),
    )

    report = end_interview(interview.id)

    assert report.artifact_uris == {
        "html": "s3://reports-bucket/reports/001-Lin.html",
        "pdf": f"s3://reports-bucket/reports/{Path(report.pdf_path or '').name}",
        "transcript": "s3://reports-bucket/reports/001-Lin.transcript.json",
        "json": "s3://reports-bucket/reports/001-Lin.report.json",
    }
    assert Path(report.pdf_path or "").name.startswith(("合格-Lin-", "不合格-Lin-"))
    assert Path(report.json_path or "").exists()
    assert Path(report.html_path or "").exists()
    assert Path(report.pdf_path or "").exists()
    assert Path(report.transcript_path or "").exists()


def test_probe_fallback_returns_three_suggestions() -> None:
    job = create_job(JobCreate(title="Backend", jd_text="Python"))
    request = ProbeRequest(
        job_id=job.id,
        competency_model=job.competency_model,
        recent_turns=[],
        latest_answer="我主要负责优化，做了很多事情，效果比较好。",
    )
    response = fallback_probe(request)
    assert len(response.suggestions) == 3
    assert response.credibility.level in {"vague", "suspicious"}


def test_generate_probe_uses_prompt_file(monkeypatch) -> None:
    messages = []

    class FakeClient:
        async def complete_json(self, sent_messages, schema, fallback):
            messages.extend(sent_messages)
            return fallback

    model = CompetencyModel(
        job_id="job-local",
        job_title="Backend",
        items=[
            CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0),
            CompetencyItem(name="工程深度", description="验证工程判断", weight=1.0),
            CompetencyItem(name="异常处理", description="验证故障经验", weight=1.0),
        ],
    )
    request = ProbeRequest(
        job_id="job-local",
        competency_model=model,
        recent_turns=[],
        latest_answer="我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
    )

    monkeypatch.setattr("services.probe_service.service.retrieve_job_probe_patterns", lambda *args, **kwargs: [])
    monkeypatch.setattr("services.probe_service.service.get_llm_client", lambda: FakeClient())

    __import__("asyncio").run(generate_probe(request))

    assert messages[0].role == "system"
    assert messages[0].content == load_prompt("probe_system.md")


def test_generate_probe_normalizes_llm_suggestion_priorities(monkeypatch) -> None:
    model = CompetencyModel(
        job_id="job-local",
        job_title="Backend",
        items=[
            CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0),
            CompetencyItem(name="工程深度", description="验证工程判断", weight=1.0),
            CompetencyItem(name="异常处理", description="验证故障经验", weight=1.0),
        ],
    )
    request = ProbeRequest(
        job_id="job-local",
        competency_model=model,
        recent_turns=[],
        latest_answer="我主要负责 FastAPI 优化和模型调用降级。",
    )
    draft = ProbeResponse(
        suggestions=[
            ProbeSuggestion(
                question="第三优先级问题",
                target="测试能力深度",
                competency="异常处理",
                priority=3,
            ),
            ProbeSuggestion(
                question="第一优先级问题",
                target="验证项目真实性",
                competency="项目真实性",
                priority=1,
            ),
            ProbeSuggestion(
                question="第二优先级问题",
                target="测试能力深度",
                competency="工程深度",
                priority=2,
            ),
        ],
        credibility=CredibilitySignal(
            level="vague",
            reason="缺少具体细节",
            drill_down_hint="追问本人负责部分",
        ),
    )

    class FakeClient:
        async def complete_json(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.probe_service.service.retrieve_job_probe_patterns", lambda *args, **kwargs: [])
    monkeypatch.setattr("services.probe_service.service.get_llm_client", lambda: FakeClient())

    response = __import__("asyncio").run(generate_probe(request))

    assert [suggestion.question for suggestion in response.suggestions] == [
        "第一优先级问题",
        "第二优先级问题",
        "第三优先级问题",
    ]
    assert [suggestion.priority for suggestion in response.suggestions] == [1, 2, 3]


def test_score_interview_uses_prompt_and_recomputes_total(monkeypatch) -> None:
    sent_messages = []
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。具体做法是把序列化改成 orjson 并加连接池预热，因为压测发现冷启动是主要瓶颈，我写了基准脚本对比指标口径，期间排查过一次连接泄漏故障，复盘后把泄漏检测指标加进了告警面板。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    draft = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=item.name,
                score=90.0 if item.weight > 0 else 50.0,
                weight=999.0,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
            for item in model.items
        ],
        total_score=1.0,
        risk_notes=["LLM draft risk"],
        recommendation="no",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            sent_messages.extend(messages)
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn))

    assert sent_messages[0].role == "system"
    assert sent_messages[0].content == load_prompt("scoring_system.md")
    assert score.total_score == 85.0
    assert score.recommendation == "yes"
    assert all(dimension.weight != 999.0 for dimension in score.dimensions)
    assert score.risk_notes == ["LLM draft risk"]


def test_fallback_score_can_build_report_with_risk_penalties(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    follow_up = QATurn(
        question="再讲一次成果",
        answer="我后来又说团队对这个接口优化降低了 20%。",
        answer_start_ms=1300,
        answer_end_ms=1900,
    )
    ctx = InterviewContext(
        session_id="session-fallback-score",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn, follow_up],
        flags=[
            ConsistencyFlag(
                turn_id_a=turn.turn_id,
                turn_id_b=follow_up.turn_id,
                description="候选人对同一职责或技术的成果数字描述不一致。",
                severity="high",
            )
        ],
    )
    aigc_results = _aigc_results_for(turn, follow_up, flagged=True)

    score = fallback_score_interview(ctx, aigc_results)
    report, _ = build_report(ctx, score, aigc_results)

    assert report.score.total_score == score.total_score
    assert report.score.risk_notes


def test_report_includes_question_adoption_stats(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    suggested = QATurn(
        question="请讲你在网关系统里亲自写了哪段代码？",
        answer="我写了限流中间件。",
        answer_start_ms=100,
        answer_end_ms=1200,
        asked_option_id="bank-1",
        question_origin="system_suggested",
    )
    custom = QATurn(
        question="你怎么看团队协作？",
        answer="我会主动同步风险。",
        answer_start_ms=1300,
        answer_end_ms=1900,
        question_origin="interviewer_custom",
    )
    ctx = InterviewContext(
        session_id="session-question-adoption",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[suggested, custom],
        question_steering="resume_drill",
        steering_history=["resume_drill"],
        suggested_question_keys=["bank-1", "bank-2", "bank-2"],
    )
    aigc_results = _aigc_results_for(suggested, custom)
    score = fallback_score_interview(ctx, aigc_results)

    report, html = build_report(ctx, score, aigc_results)

    assert report.question_adoption.suggested_unique_count == 2
    assert report.question_adoption.adopted_suggested_count == 1
    assert report.question_adoption.custom_question_count == 1
    assert report.question_adoption.adoption_rate == 0.5
    assert report.question_adoption.steering_focus == "resume_drill"
    assert "采纳率" in html
    report_json = loads(Path(report.json_path or "").read_text(encoding="utf-8"))
    assert report_json["question_adoption"]["adoption_rate"] == 0.5


def test_report_pdf_fallback_contains_auditable_summary(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    real_import = builtins.__import__

    def fake_import(name, globals_=None, locals_=None, fromlist=(), level=0):
        if name == "weasyprint":
            raise ImportError("blocked in test")
        return real_import(name, globals_, locals_, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    competency = CompetencyItem(
        name="Backend Depth",
        description="Backend implementation depth",
        weight=1.0,
    )
    model = CompetencyModel(job_id="job-local", job_title="Backend", items=[competency])
    turn = QATurn(
        question="Describe the API project",
        answer="Built FastAPI retry logic and JSON validation.",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-fallback-pdf",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    score = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=competency.name,
                score=80.0,
                weight=competency.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
        ],
        total_score=80.0,
        risk_notes=["Needs deeper production incident evidence"],
        recommendation="yes",
    )
    aigc = [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.1,
            template_similarity=0.1,
            flagged=False,
        )
    ]

    report, _ = build_report(ctx, score, aigc)

    def pdf_hex(text: str) -> bytes:
        return text.encode("utf-16-be").hex().upper().encode("ascii")

    pdf_bytes = Path(report.pdf_path or "").read_bytes()
    assert pdf_bytes.startswith(b"%PDF")
    assert pdf_hex("综合得分：80.0（满分 100）") in pdf_bytes
    assert pdf_hex("录用建议：推荐") in pdf_bytes
    assert pdf_hex("Backend Depth") in pdf_bytes
    assert pdf_hex("完整转写：") in pdf_bytes
    assert pdf_hex("Built FastAPI retry logic and JSON") in pdf_bytes


def test_report_pdf_fallback_preserves_chinese_text(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    real_import = builtins.__import__

    def fake_import(name, globals_=None, locals_=None, fromlist=(), level=0):
        if name == "weasyprint":
            raise ImportError("blocked in test")
        return real_import(name, globals_, locals_, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    competency = CompetencyItem(
        name="项目真实性",
        description="验证项目经历",
        weight=1.0,
    )
    model = CompetencyModel(job_id="job-local", job_title="Backend", items=[competency])
    turn = QATurn(
        question="讲项目",
        answer="我写了 FastAPI 编排和 JSON 校验。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-fallback-pdf-chinese",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    score = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=competency.name,
                score=80.0,
                weight=competency.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
        ],
        total_score=80.0,
        risk_notes=["需要继续追问线上故障细节"],
        recommendation="yes",
        analysis_mode="fallback",
    )
    aigc = [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.1,
            template_similarity=0.1,
            flagged=False,
        )
    ]

    report, _ = build_report(ctx, score, aigc)

    pdf_bytes = Path(report.pdf_path or "").read_bytes()
    assert pdf_bytes.startswith(b"%PDF")
    assert b"/STSong-Light" in pdf_bytes
    assert "项目真实性".encode("utf-16-be").hex().upper().encode("ascii") in pdf_bytes
    assert "我写了".encode("utf-16-be").hex().upper().encode("ascii") in pdf_bytes
    warning = "本报告由确定性规则生成（未启用大模型分析）"
    assert warning.encode("utf-16-be").hex().upper().encode("ascii") in pdf_bytes


def test_report_deduplicates_risk_highlights(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    get_settings.cache_clear()
    competency = CompetencyItem(
        name="Backend Depth",
        description="Backend implementation depth",
        weight=1.0,
    )
    model = CompetencyModel(job_id="job-local", job_title="Backend", items=[competency])
    turn = QATurn(
        question="Describe the API project",
        answer="Built FastAPI retry logic and JSON validation.",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    follow_up = QATurn(
        question="Describe the follow-up",
        answer="Built another FastAPI retry incident review.",
        answer_start_ms=1300,
        answer_end_ms=1800,
    )
    duplicate_note = "same risk note"
    ctx = InterviewContext(
        session_id="session-risk-dedupe",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn, follow_up],
        flags=[
            ConsistencyFlag(
                turn_id_a=turn.turn_id,
                turn_id_b=follow_up.turn_id,
                description=duplicate_note,
                severity="high",
            )
        ],
    )
    score = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=competency.name,
                score=80.0,
                weight=competency.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
        ],
        total_score=80.0,
        risk_notes=[duplicate_note, "llm risk note"],
        recommendation="yes",
    )
    aigc = [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.1,
            template_similarity=0.1,
            flagged=False,
        ),
        AIGCResult(
            turn_id=follow_up.turn_id,
            ai_generated_prob=0.1,
            template_similarity=0.1,
            flagged=False,
        ),
    ]

    _, html = build_report(ctx, score, aigc)

    assert html.count(duplicate_note) == 1
    assert html.count("llm risk note") == 1


def test_score_interview_normalizes_evidence_to_real_turns(monkeypatch) -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    draft = InterviewScore.model_construct(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore.model_construct(
                dimension=item.name,
                score=80.0,
                weight=item.weight,
                evidence=[
                    # Simulate an untrusted LLM draft object that bypassed normal schema parsing.
                    EvidenceRef.model_construct(
                        turn_id=turn.turn_id,
                        quote_start_ms=-500,
                        quote_end_ms=999999,
                        excerpt="LLM 编造的不存在原文",
                    )
                ],
            )
            for item in model.items
        ],
        total_score=80.0,
        risk_notes=[],
        recommendation="yes",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn))

    for dimension in score.dimensions:
        assert dimension.evidence
        ref = dimension.evidence[0]
        assert ref.excerpt == turn.answer
        assert ref.quote_start_ms == turn.answer_start_ms
        assert ref.quote_end_ms == turn.answer_end_ms


def test_score_interview_deduplicates_normalized_evidence_refs(monkeypatch) -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    duplicate = EvidenceRef(
        turn_id=turn.turn_id,
        quote_start_ms=turn.answer_start_ms,
        quote_end_ms=turn.answer_end_ms,
        excerpt=turn.answer,
    )
    draft = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=item.name,
                score=80.0,
                weight=item.weight,
                evidence=[duplicate, duplicate],
            )
            for item in model.items
        ],
        total_score=80.0,
        risk_notes=[],
        recommendation="yes",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn))

    assert all(len(dimension.evidence) == 1 for dimension in score.dimensions)


def test_score_interview_preserves_deterministic_consistency_risk(monkeypatch) -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。具体做法是把序列化改成 orjson 并加连接池预热，因为压测发现冷启动是主要瓶颈，我写了基准脚本对比指标口径，期间排查过一次连接泄漏故障，复盘后把泄漏检测指标加进了告警面板。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    follow_up = QATurn(
        question="复盘成果",
        answer="我后来又说团队负责 FastAPI 接口优化，延迟降低 20%。具体经过是复盘时核对了压测报告和线上指标口径，因为统计窗口不同结论有出入，我重新跑了基准脚本核实数据，并把两次口径差异写进了复盘记录和告警阈值说明。",
        answer_start_ms=1300,
        answer_end_ms=1900,
    )
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn, follow_up],
        flags=[
            ConsistencyFlag(
                turn_id_a=turn.turn_id,
                turn_id_b=follow_up.turn_id,
                description="候选人对同一职责或技术的成果数字描述不一致。",
                severity="high",
            )
        ],
    )
    draft = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=item.name,
                score=99.0,
                weight=item.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
            for item in model.items
        ],
        total_score=99.0,
        risk_notes=[],
        recommendation="strong_yes",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn, follow_up))

    by_dimension = {dimension.dimension: dimension for dimension in score.dimensions}
    assert by_dimension["项目真实性"].score == 69.6
    assert by_dimension["注水风险"].score == 64.0
    assert score.total_score < 99.0
    assert score.risk_notes == ["候选人对同一职责或技术的成果数字描述不一致。"]


def test_score_interview_merges_deterministic_and_llm_risk_notes(monkeypatch) -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。具体做法是把序列化改成 orjson 并加连接池预热，因为压测发现冷启动是主要瓶颈，我写了基准脚本对比指标口径，期间排查过一次连接泄漏故障，复盘后把泄漏检测指标加进了告警面板。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    follow_up = QATurn(
        question="复盘成果",
        answer="我后来又说团队负责 FastAPI 接口优化，延迟降低 20%。具体经过是复盘时核对了压测报告和线上指标口径，因为统计窗口不同结论有出入，我重新跑了基准脚本核实数据，并把两次口径差异写进了复盘记录和告警阈值说明。",
        answer_start_ms=1300,
        answer_end_ms=1900,
    )
    deterministic_note = "候选人对同一职责或技术的成果数字描述不一致。"
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn, follow_up],
        flags=[
            ConsistencyFlag(
                turn_id_a=turn.turn_id,
                turn_id_b=follow_up.turn_id,
                description=deterministic_note,
                severity="high",
            )
        ],
    )
    draft = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=item.name,
                score=99.0,
                weight=item.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
            for item in model.items
        ],
        total_score=99.0,
        risk_notes=["LLM 认为还需要继续追问线上细节。", deterministic_note],
        recommendation="strong_yes",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn, follow_up))

    assert score.risk_notes == [
        deterministic_note,
        "LLM 认为还需要继续追问线上细节。",
    ]


def test_score_interview_preserves_deterministic_aigc_risk(monkeypatch) -> None:
    model = generate_competency_model("job-local", "Backend", "Python FastAPI")
    turn = QATurn(
        question="讲项目",
        answer="我负责 FastAPI 接口优化，延迟降低 30%。具体做法是把序列化改成 orjson 并加连接池预热，因为压测发现冷启动是主要瓶颈，我写了基准脚本对比指标口径，期间排查过一次连接泄漏故障，复盘后把泄漏检测指标加进了告警面板。",
        answer_start_ms=100,
        answer_end_ms=1200,
    )
    ctx = InterviewContext(
        session_id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        competency_model=model,
        turns=[turn],
    )
    draft = InterviewScore(
        session_id=ctx.session_id,
        dimensions=[
            DimensionScore(
                dimension=item.name,
                score=99.0,
                weight=item.weight,
                evidence=[
                    EvidenceRef(
                        turn_id=turn.turn_id,
                        quote_start_ms=turn.answer_start_ms,
                        quote_end_ms=turn.answer_end_ms,
                        excerpt=turn.answer,
                    )
                ],
            )
            for item in model.items
        ],
        total_score=99.0,
        risk_notes=[],
        recommendation="strong_yes",
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, _aigc_results_for(turn, flagged=True))

    by_dimension = {dimension.dimension: dimension for dimension in score.dimensions}
    assert by_dimension["项目真实性"].score == 73.8
    assert by_dimension["注水风险"].score == 82.0
    assert score.total_score < 99.0
    assert score.risk_notes == ["部分回答疑似背稿或模板化，需要人工复核。"]


def test_competency_generation_uses_prompt_and_overrides_ids(monkeypatch) -> None:
    sent_messages = []
    draft = CompetencyModel(
        job_id="wrong",
        job_title="wrong",
        items=[
            CompetencyItem(
                name="工程深度",
                description="验证设计和排障能力",
                probe_patterns=["请讲一次线上故障的定位过程。"],
                weight=1.0,
            ),
            CompetencyItem(
                name="注水风险",
                description="验证模板化回答和前后矛盾",
                probe_patterns=["请追问回答中最像模板的细节。"],
                weight=99.0,
            )
        ],
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback):
            sent_messages.extend(messages)
            return draft

    monkeypatch.setattr("services.jd_kb_service.service.get_llm_client", lambda: FakeClient())

    model = generate_competency_model("job-local", "Backend", "Python FastAPI")

    assert sent_messages[0].role == "system"
    assert sent_messages[0].content == load_prompt("competency_gen.md")
    assert "Python FastAPI" in sent_messages[1].content
    assert model.job_id == "job-local"
    assert model.job_title == "Backend"
    names = [item.name for item in model.items]
    assert names[:5] == ["专业能力深度", "项目真实性", "岗位匹配度", "沟通与逻辑", "注水风险"]
    assert names[-1] == "工程深度"
    risk = next(item for item in model.items if item.name == "注水风险")
    custom = next(item for item in model.items if item.name == "工程深度")
    assert risk.weight == -0.10
    assert "请追问回答中最像模板的细节。" in risk.probe_patterns
    assert "请讲一次线上故障的定位过程。" in custom.probe_patterns


def test_jd_kb_retrieves_relevant_probe_patterns(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'kb.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="LLM Backend", jd_text="Python FastAPI LLM 可靠性"))

    hits = retrieve_job_probe_patterns(job.id, "LLM 调用失败降级和 FastAPI 异常处理", limit=3)

    assert hits
    assert hits[0].score > 0
    assert any("LLM" in hit.pattern or "FastAPI" in hit.pattern for hit in hits)


def test_jd_kb_indexes_probe_pattern_embeddings(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'kb-vector.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="LLM Backend", jd_text="Python FastAPI LLM 可靠性"))

    with connect() as conn:
        rows = conn.execute(
            "SELECT competency, pattern, embedding FROM probe_patterns WHERE job_id = ?",
            (job.id,),
        ).fetchall()

    hits = retrieve_job_probe_patterns(job.id, "模型调用失败时怎么降级", limit=2)

    assert rows
    assert all(loads(row["embedding"]) for row in rows)
    assert hits
    assert hits[0].score > 0


def test_jd_kb_pgvector_retrieval_uses_nearest_neighbor_sql(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/app")
    monkeypatch.setenv("JD_VECTOR_BACKEND", "pgvector")
    get_settings.cache_clear()
    executed: list[tuple[str, tuple]] = []

    class Result:
        def fetchall(self):
            return [
                {
                    "competency": "专业能力深度",
                    "pattern": "请追问 LLM 调用、评估、成本、失败降级和安全边界。",
                    "score": 0.83,
                }
            ]

    class FakeConnection:
        def execute(self, query: str, params: tuple):
            executed.append((query, params))
            return Result()

    @contextmanager
    def fake_connect():
        yield FakeConnection()

    monkeypatch.setattr("services.jd_kb_service.service.init_db", lambda: None)
    monkeypatch.setattr("services.jd_kb_service.service.connect", fake_connect)

    hits = retrieve_job_probe_patterns("00000000-0000-0000-0000-000000000001", "LLM 降级", limit=3)

    assert hits[0].score == 0.83
    query, params = executed[0]
    assert "embedding_vector <=>" in query
    assert params[0].startswith("[")
    assert params[0] == params[2]
    assert params[3] == 3


def test_jd_kb_pgvector_index_writes_vector_column(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/app")
    monkeypatch.setenv("JD_VECTOR_BACKEND", "pgvector")
    get_settings.cache_clear()
    inserted: list[tuple[str, tuple]] = []
    job = JobRecord(
        id="00000000-0000-0000-0000-000000000001",
        title="LLM Backend",
        jd_text="Python FastAPI LLM",
        competency_model=generate_competency_model(
            "00000000-0000-0000-0000-000000000001",
            "LLM Backend",
            "Python FastAPI LLM",
        ),
    )

    class FakeConnection:
        def execute(self, query: str, params: tuple):
            inserted.append((query, params))

    @contextmanager
    def fake_connect():
        yield FakeConnection()

    monkeypatch.setattr("services.jd_kb_service.service.connect", fake_connect)

    _index_probe_patterns(job)

    assert inserted
    query, params = inserted[0]
    assert "embedding_vector" in query
    assert "?::vector" in query
    assert params[5] == _pgvector_literal(loads(params[4]))


def test_probe_fallback_uses_retrieved_patterns() -> None:
    job = create_job(JobCreate(title="LLM Backend", jd_text="Python FastAPI LLM 可靠性"))
    response = fallback_probe(
        ProbeRequest(
            job_id=job.id,
            competency_model=job.competency_model,
            recent_turns=[],
            latest_answer="我主要负责 LLM 调用和 FastAPI 优化，效果比较好。",
        )
    )

    assert any("LLM" in suggestion.question or "FastAPI" in suggestion.question for suggestion in response.suggestions)


def test_aigc_detection_flags_template() -> None:
    results = detect_interview(
        [
            QATurn(
                question="q",
                answer="我主要负责整体架构设计并推动项目落地最终取得显著提升",
            )
        ]
    )
    assert results[0].flagged
    assert results[0].template_similarity > 0.9
    assert results[0].rehearsal_score >= 0.55


def test_aigc_detection_uses_template_corpus_for_paraphrase() -> None:
    results = detect_interview(
        [
            QATurn(
                question="q",
                answer="首先我分析业务痛点，然后制定技术方案，最后推动落地并持续优化。",
            )
        ]
    )
    assert len(load_templates()) >= 40
    assert results[0].matched_template
    assert results[0].template_similarity >= 0.45


def test_aigc_detection_can_use_http_detector(monkeypatch) -> None:
    monkeypatch.setenv("AIGC_DETECTOR_PROVIDER", "http")
    monkeypatch.setenv("AIGC_DETECTOR_BASE_URL", "https://aigc.example.test/api")
    monkeypatch.setenv("AIGC_DETECTOR_API_PATH", "/v1/detect")
    monkeypatch.setenv("AIGC_DETECTOR_API_KEY", "secret")
    monkeypatch.setenv("AIGC_DETECTOR_AUTH_HEADER", "X-Detector-Key")
    monkeypatch.setenv("AIGC_DETECTOR_AUTH_SCHEME", "")
    get_settings.cache_clear()
    turn = QATurn(question="q", answer="我写了 FastAPI 编排和 JSON 校验。")

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://aigc.example.test/api/v1/detect"
        assert request.headers["X-Detector-Key"] == "secret"
        payload = __import__("json").loads(request.content)
        assert payload["turn_id"] == turn.turn_id
        assert payload["answer"] == turn.answer
        assert "local_template_similarity" in payload
        return httpx.Response(200, json={"ai_generated_prob": 0.91, "flagged": "false"})

    result = detect_interview([turn], transport=httpx.MockTransport(handler))[0]

    assert result.ai_generated_prob == 0.91
    assert result.flagged is True
    assert result.template_similarity >= 0.0


def test_aigc_http_detector_flagged_false_still_uses_probability_threshold(monkeypatch) -> None:
    monkeypatch.setenv("AIGC_DETECTOR_PROVIDER", "http")
    monkeypatch.setenv("AIGC_DETECTOR_BASE_URL", "https://aigc.example.test")
    monkeypatch.setenv("AIGC_AI_PROB_THRESHOLD", "0.65")
    get_settings.cache_clear()
    turn = QATurn(question="q", answer="我写了 FastAPI 编排和 JSON 校验。")
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, json={"ai_generated_prob": "0.7", "flagged": "false"})
    )

    result = detect_interview([turn], transport=transport)[0]

    assert result.ai_generated_prob == 0.7
    assert result.flagged is True


def test_aigc_http_detector_falls_back_on_failure(monkeypatch) -> None:
    monkeypatch.setenv("AIGC_DETECTOR_PROVIDER", "http")
    monkeypatch.setenv("AIGC_DETECTOR_BASE_URL", "https://aigc.example.test")
    get_settings.cache_clear()
    turn = QATurn(question="q", answer="我主要负责整体架构设计并推动项目落地最终取得显著提升")
    transport = httpx.MockTransport(lambda _: httpx.Response(500, json={"error": "boom"}))

    result = detect_interview([turn], transport=transport)[0]

    assert result.flagged is True
    assert result.template_similarity > 0.9


def test_fact_claim_extraction() -> None:
    turn = QATurn(
        question="q",
        answer="我独立负责 FastAPI 编排和重试，接口耗时降低 30%。",
    )
    claim = extract_fact_claim(turn)
    assert claim.contribution_scope == "solo"
    assert "FastAPI" in claim.technologies
    assert "重试" in claim.responsibilities
    assert claim.metrics


def test_consistency_detects_contribution_conflict() -> None:
    turns = [
        QATurn(question="q1", answer="这个项目是我独立完成的，我负责整体架构。"),
        QATurn(question="q2", answer="其实核心链路是团队负责，同事负责主要实现。"),
    ]
    flags = detect_consistency(turns)
    assert flags
    assert flags[0].severity == "high"


def test_consistency_treats_team_led_work_as_team_scope() -> None:
    solo = QATurn(question="q1", answer="这个项目是我独立完成的，我负责整体架构。")
    team_led = QATurn(question="q2", answer="后来确认核心链路其实是团队主导，我只负责配合联调。")

    team_claim = extract_fact_claim(team_led)
    flags = detect_consistency([solo, team_led])

    assert team_claim.contribution_scope == "team"
    assert flags
    assert flags[0].severity == "high"


def test_consistency_detects_metric_conflict_for_shared_context() -> None:
    turns = [
        QATurn(question="q1", answer="我负责 FastAPI 优化，接口耗时降低 30%。"),
        QATurn(question="q2", answer="后来复盘 FastAPI 优化其实只降低 5%。"),
    ]

    flags = detect_consistency(turns)

    assert flags
    assert flags[0].severity == "high"
    assert "成果数字描述不一致" in flags[0].description
    assert "降低 30%" in flags[0].description
    assert "降低 5%" in flags[0].description


def test_consistency_ignores_unrelated_metric_differences() -> None:
    turns = [
        QATurn(question="q1", answer="我负责 FastAPI 优化，接口耗时降低 30%。"),
        QATurn(question="q2", answer="我参与 Redis 排查，缓存命中提升 5%。"),
    ]

    flags = detect_consistency(turns)

    assert not flags


def test_consistency_treats_same_direction_metric_verbs_as_consistent() -> None:
    turns = [
        QATurn(question="q1", answer="我负责 FastAPI 优化，接口耗时降低 30%。"),
        QATurn(question="q2", answer="复盘 FastAPI 优化后确认耗时减少 30%。"),
    ]

    flags = detect_consistency(turns)

    assert not flags


def test_add_turn_maintains_fact_claim_table(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'facts.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="Backend", jd_text="Python FastAPI"))
    candidate = create_candidate(CandidateCreate(name="Ada"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    first = QATurn(question="q1", answer="这个项目是我独立负责 FastAPI 编排和重试。")
    second = QATurn(question="q2", answer="其实核心链路是团队负责，同事负责主要实现。")

    add_turn(interview.id, first)
    record = add_turn(interview.id, second)
    reloaded = get_interview(interview.id)

    assert [claim.turn_id for claim in record.context.fact_claims] == [
        first.turn_id,
        second.turn_id,
    ]
    assert record.context.fact_claims[0].contribution_scope == "solo"
    assert "FastAPI" in record.context.fact_claims[0].technologies
    assert reloaded.context.fact_claims[1].contribution_scope == "team"
    assert reloaded.context.flags


def test_should_probe_uses_configurable_thresholds(monkeypatch) -> None:
    monkeypatch.setenv("PROBE_MIN_ANSWER_CHARS", "5")
    monkeypatch.setenv("PROBE_MIN_INTERVAL_MS", "2500")
    get_settings.cache_clear()
    model = generate_competency_model("job-local", "Backend", "Python 服务端岗位")
    record = InterviewRecord(
        id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        context=InterviewContext(
            session_id="session-local",
            job_id=model.job_id,
            candidate_id="candidate-local",
            competency_model=model,
        ),
    )
    record.context.turns.append(
        QATurn(question="q", answer="上一段回答", answer_start_ms=0, answer_end_ms=1000)
    )

    early = TranscriptSegment(
        session_id=record.id,
        speaker="candidate",
        text="我负责项目里的接口优化",
        start_ms=3000,
        end_ms=3200,
        is_final=True,
        confidence=0.9,
    )
    late = early.model_copy(update={"start_ms": 3600})

    assert should_probe(early, record) is False
    assert should_probe(late, record) is True


def test_should_probe_ignores_deprecated_topic_keywords(monkeypatch) -> None:
    monkeypatch.delenv("PROBE_REQUIRE_TOPIC_MATCH", raising=False)
    monkeypatch.setenv("PROBE_TOPIC_KEYWORDS", "FastAPI,架构")
    monkeypatch.setenv("PROBE_MIN_ANSWER_CHARS", "5")
    get_settings.cache_clear()
    model = generate_competency_model("job-local", "Backend", "Python 服务端岗位")
    record = InterviewRecord(
        id="session-local",
        job_id=model.job_id,
        candidate_id="candidate-local",
        context=InterviewContext(
            session_id="session-local",
            job_id=model.job_id,
            candidate_id="candidate-local",
            competency_model=model,
        ),
    )
    evasive_without_keyword = TranscriptSegment(
        session_id=record.id,
        speaker="candidate",
        text="记不清了，主要是团队做的。",
        start_ms=0,
        end_ms=1000,
        is_final=True,
        confidence=0.9,
    )
    explicit_keyword = evasive_without_keyword.model_copy(
        update={"text": "我负责项目里的 FastAPI 架构优化。"}
    )

    assert should_probe(evasive_without_keyword, record) is True
    assert should_probe(explicit_keyword, record) is True
