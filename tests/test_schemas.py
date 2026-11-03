from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from libs.schemas import (
    AIGCDetectRequest,
    AIGCResult,
    BehaviorSignal,
    CandidateCreate,
    ChatStreamRequest,
    ConsentCreate,
    ConsentRecord,
    ConsistencyFlag,
    CredibilitySignal,
    CompetencyItem,
    CompetencyModel,
    DimensionScore,
    EvidenceRef,
    FactClaim,
    InterviewCreate,
    InterviewContext,
    InterviewRecord,
    InterviewScore,
    InterviewStatus,
    JobCreate,
    JobRecord,
    OfflineInterviewInput,
    OfflineTaskAccepted,
    ProbePatternHit,
    ProbeResponse,
    ProbeRequest,
    ProbeSuggestion,
    QATurn,
    Report,
    ReportBuildRequest,
    ScoringRequest,
    TranscriptSegment,
    UiSettings,
)


def test_chat_context_defaults_to_study_and_interview_role_is_optional() -> None:
    request = ChatStreamRequest(text="问题")
    assert request.context == "study"
    assert request.interview_role is None
    assert ChatStreamRequest(context="interview", images=["image"]).interview_role is None


@pytest.mark.parametrize("role", ["candidate", "interviewer"])
def test_chat_interview_accepts_an_explicit_role_snapshot(role) -> None:
    request = ChatStreamRequest(context="interview", interview_role=role, text="问题")
    assert request.interview_role == role


@pytest.mark.parametrize("context", ["voice", "scoring", "", None, 42])
def test_chat_rejects_unknown_context(context) -> None:
    with pytest.raises(ValidationError):
        ChatStreamRequest(context=context, text="问题")


@pytest.mark.parametrize("role", ["unknown", "system", "", 1])
def test_chat_rejects_invalid_interview_role(role) -> None:
    with pytest.raises(ValidationError):
        ChatStreamRequest(context="interview", interview_role=role, text="问题")


@pytest.mark.parametrize("context", ["study", "interview"])
def test_chat_context_still_requires_a_question_or_image(context) -> None:
    with pytest.raises(ValidationError):
        ChatStreamRequest(context=context, text=" ")


def test_new_study_settings_default_to_complete_solution() -> None:
    assert UiSettings().study_answer_style == "solution"


def test_saved_study_style_and_language_are_not_replaced_by_new_defaults() -> None:
    settings = UiSettings(study_answer_style="hints", study_language="Rust")
    assert settings.study_answer_style == "hints"
    assert settings.study_language == "Rust"


def test_behavior_signal_forbids_compliance_sensitive_extra_fields() -> None:
    signal = BehaviorSignal.model_validate(
        {
            "turn_id": "turn-1",
            "fluency": 0.8,
            "hesitation": 0.2,
            "evasiveness_hint": False,
        }
    )

    assert signal.model_dump() == {
        "turn_id": "turn-1",
        "fluency": 0.8,
        "hesitation": 0.2,
        "evasiveness_hint": False,
    }

    with pytest.raises(ValidationError):
        BehaviorSignal.model_validate(
            {
                "turn_id": "turn-1",
                "fluency": 0.8,
                "hesitation": 0.2,
                "evasiveness_hint": False,
                "personality": "confident",
                "emotion": "nervous",
                "reliability": 0.4,
            }
        )


def test_transcript_segment_rejects_invalid_time_ranges() -> None:
    segment = TranscriptSegment(
        session_id="session-1",
        speaker="candidate",
        text="回答",
        start_ms=100,
        end_ms=100,
        is_final=True,
        confidence=0.8,
    )

    assert segment.start_ms == 100
    with pytest.raises(ValidationError):
        TranscriptSegment(
            session_id="session-1",
            speaker="candidate",
            text="回答",
            start_ms=-1,
            end_ms=100,
            is_final=True,
            confidence=0.8,
        )
    with pytest.raises(ValidationError):
        TranscriptSegment(
            session_id="session-1",
            speaker="candidate",
            text="回答",
            start_ms=200,
            end_ms=100,
            is_final=True,
            confidence=0.8,
        )


def test_qa_turn_rejects_invalid_answer_time_ranges() -> None:
    turn = QATurn(question="q", answer="a", answer_start_ms=0, answer_end_ms=10)

    assert turn.answer_end_ms == 10
    with pytest.raises(ValidationError):
        QATurn(question="q", answer="a", answer_start_ms=-1, answer_end_ms=10)
    with pytest.raises(ValidationError):
        QATurn(question="q", answer="a", answer_start_ms=20, answer_end_ms=10)


def test_qa_turn_rejects_blank_question_or_answer() -> None:
    probe_turn = QATurn(
        question="追问",
        question_source="ai_probe",
        answer="回答",
        probe_target="验证项目真实性",
    )

    assert probe_turn.probe_target == "验证项目真实性"
    with pytest.raises(ValidationError):
        QATurn(question=" ", answer="a")
    with pytest.raises(ValidationError):
        QATurn(question="q", answer=" ")
    with pytest.raises(ValidationError):
        QATurn(question="q", answer="a", probe_target=" ")
    with pytest.raises(ValidationError):
        QATurn(question="q", question_source="ai_probe", answer="a")


def test_job_candidate_and_competency_payloads_reject_blank_required_text() -> None:
    with pytest.raises(ValidationError):
        JobCreate(title=" ", jd_text="Python FastAPI")
    with pytest.raises(ValidationError):
        JobCreate(title="Backend", jd_text=" ")
    with pytest.raises(ValidationError):
        CandidateCreate(name=" ")
    with pytest.raises(ValidationError):
        CompetencyItem(name=" ", description="验证工程能力", weight=1.0)
    with pytest.raises(ValidationError):
        CompetencyItem(name="工程深度", description=" ", weight=1.0)
    with pytest.raises(ValidationError):
        CompetencyItem(name="工程深度", description="验证工程能力", weight=float("nan"))
    with pytest.raises(ValidationError):
        CompetencyItem(name="工程深度", description="验证工程能力", weight=float("inf"))
    with pytest.raises(ValidationError):
        CompetencyItem(
            name="工程深度",
            description="验证工程能力",
            probe_patterns=["请讲一个具体案例。", " "],
            weight=1.0,
        )
    with pytest.raises(ValidationError):
        CompetencyModel(
            job_id="job-1",
            job_title=" ",
            items=[
                CompetencyItem(
                    name="工程深度",
                    description="验证工程能力",
                    weight=1.0,
                )
            ],
        )
    with pytest.raises(ValidationError):
        CompetencyModel(
            job_id="job-1",
            job_title="Backend",
            items=[
                CompetencyItem(
                    name="工程深度",
                    description="验证工程能力",
                    weight=1.0,
                ),
                CompetencyItem(
                    name=" 工程深度 ",
                    description="重复维度会让评分证据归属不清",
                    weight=1.0,
                ),
            ],
        )


def test_shared_contract_models_reject_blank_identifiers() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    evidence = EvidenceRef(turn_id="turn-1", quote_start_ms=0, quote_end_ms=10, excerpt="回答")
    dimension = DimensionScore(
        dimension="项目真实性",
        score=80.0,
        weight=1.0,
        evidence=[evidence],
    )
    score = InterviewScore(
        session_id="session-1",
        dimensions=[dimension],
        total_score=80.0,
        recommendation="yes",
    )
    aigc = AIGCResult(turn_id="turn-1", ai_generated_prob=0.2, template_similarity=0.1)

    with pytest.raises(ValidationError):
        CompetencyModel(job_id=" ", job_title="Backend", items=[competency])
    with pytest.raises(ValidationError):
        ProbePatternHit(job_id=" ", competency="项目真实性", pattern="请讲具体项目。", score=1.0)
    with pytest.raises(ValidationError):
        ProbePatternHit(
            job_id="job-1",
            competency="项目真实性",
            pattern="请讲具体项目。",
            score=float("inf"),
        )
    with pytest.raises(ValidationError):
        ConsistencyFlag(turn_id_a=" ", turn_id_b="turn-2", description="矛盾", severity="high")
    with pytest.raises(ValidationError):
        ConsistencyFlag(
            turn_id_a="turn-1",
            turn_id_b="turn-1",
            description="同一回答不能构成前后一致性冲突",
            severity="high",
        )
    with pytest.raises(ValidationError):
        FactClaim(turn_id=" ")
    with pytest.raises(ValidationError):
        FactClaim(turn_id="turn-1", responsibilities=["架构", " "])
    with pytest.raises(ValidationError):
        FactClaim(turn_id="turn-1", technologies=["FastAPI", " "])
    with pytest.raises(ValidationError):
        FactClaim(turn_id="turn-1", metrics=["30%", " "])
    with pytest.raises(ValidationError):
        QATurn(turn_id=" ", question="q", answer="a")
    with pytest.raises(ValidationError):
        ProbeRequest(job_id=" ", competency_model=model, recent_turns=[], latest_answer="回答")
    with pytest.raises(ValidationError):
        EvidenceRef(turn_id=" ", quote_start_ms=0, quote_end_ms=10, excerpt="回答")
    with pytest.raises(ValidationError):
        InterviewScore(
            session_id=" ",
            dimensions=[dimension],
            total_score=80.0,
            recommendation="yes",
        )
    with pytest.raises(ValidationError):
        AIGCResult(turn_id=" ", ai_generated_prob=0.2, template_similarity=0.1)
    with pytest.raises(ValidationError):
        AIGCResult(
            turn_id="turn-1",
            ai_generated_prob=0.2,
            template_similarity=0.1,
            matched_template=" ",
        )
    with pytest.raises(ValidationError):
        BehaviorSignal(turn_id=" ", fluency=0.8, hesitation=0.1, evasiveness_hint=False)
    with pytest.raises(ValidationError):
        ConsentCreate(candidate_id=" ")
    with pytest.raises(ValidationError):
        InterviewCreate(job_id=" ", candidate_id="candidate-1")
    with pytest.raises(ValidationError):
        InterviewCreate(job_id="job-1", candidate_id=" ")
    with pytest.raises(ValidationError):
        OfflineTaskAccepted(interview_id=" ", task_id="task-1", task_name="task")
    with pytest.raises(ValidationError):
        Report(
            interview_id=" ",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            summary="报告摘要",
        )


def test_aigc_detect_request_requires_candidate_turns() -> None:
    turn = QATurn(turn_id="turn-1", question="q", answer="a")

    request = AIGCDetectRequest(turns=[turn])

    assert request.turns[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        AIGCDetectRequest(turns=[])
    with pytest.raises(ValidationError):
        AIGCDetectRequest(turns=[turn, turn])


def test_offline_interview_input_rejects_duplicate_turn_ids() -> None:
    turn = QATurn(turn_id="turn-1", question="q", answer="a")
    payload = OfflineInterviewInput(
        job_title="Backend",
        jd_text="Python FastAPI",
        candidate_name="Candidate",
        turns=[turn],
    )

    assert payload.turns[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        OfflineInterviewInput(
            job_title="Backend",
            jd_text="Python FastAPI",
            candidate_name="Candidate",
            turns=[turn, turn],
        )


def test_interview_context_rejects_duplicate_turn_ids() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    turn = QATurn(turn_id="turn-1", question="q", answer="a")

    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
        turns=[turn],
    )

    assert context.turns[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        InterviewContext(
            session_id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            competency_model=model,
            turns=[turn, turn],
        )


def test_interview_context_rejects_unknown_fact_claim_or_flag_turns() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    first_turn = QATurn(turn_id="turn-1", question="q1", answer="a1")
    second_turn = QATurn(turn_id="turn-2", question="q2", answer="a2")

    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
        turns=[first_turn, second_turn],
        fact_claims=[FactClaim(turn_id="turn-1", technologies=["FastAPI"])],
        flags=[
            ConsistencyFlag(
                turn_id_a="turn-1",
                turn_id_b="turn-2",
                description="前后指标不一致",
                severity="high",
            )
        ],
    )

    assert context.fact_claims[0].turn_id == "turn-1"
    assert context.flags[0].turn_id_b == "turn-2"
    with pytest.raises(ValidationError):
        InterviewContext(
            session_id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            competency_model=model,
            turns=[first_turn],
            fact_claims=[FactClaim(turn_id="missing-turn", technologies=["FastAPI"])],
        )
    with pytest.raises(ValidationError):
        InterviewContext(
            session_id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            competency_model=model,
            turns=[first_turn, second_turn],
            flags=[
                ConsistencyFlag(
                    turn_id_a="missing-turn",
                    turn_id_b="turn-2",
                    description="前后指标不一致",
                    severity="high",
                )
            ],
        )
    with pytest.raises(ValidationError):
        InterviewContext(
            session_id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            competency_model=model,
            turns=[first_turn, second_turn],
            flags=[
                ConsistencyFlag(
                    turn_id_a="turn-1",
                    turn_id_b="missing-turn",
                    description="前后指标不一致",
                    severity="high",
                )
            ],
        )


def test_interview_timestamps_must_be_monotonic() -> None:
    started_at = datetime(2026, 6, 2, 10, 0, tzinfo=UTC)
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
        started_at=started_at,
        ended_at=started_at,
    )
    record = InterviewRecord(
        id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        status=InterviewStatus.finished,
        context=context,
        started_at=started_at,
        ended_at=started_at,
    )

    assert context.ended_at == started_at
    assert record.ended_at == started_at
    with pytest.raises(ValidationError):
        InterviewContext(
            session_id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            competency_model=model,
            started_at=started_at,
            ended_at=started_at - timedelta(seconds=1),
        )
    with pytest.raises(ValidationError):
        InterviewRecord(
            id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            status=InterviewStatus.finished,
            context=context,
            started_at=started_at,
            ended_at=started_at - timedelta(seconds=1),
        )


def test_interview_record_status_requires_matching_timestamps() -> None:
    started_at = datetime(2026, 6, 2, 10, 0, tzinfo=UTC)
    ended_at = started_at + timedelta(minutes=30)
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
    )

    in_progress = InterviewRecord(
        id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        status=InterviewStatus.in_progress,
        context=context,
        started_at=started_at,
    )
    reported = InterviewRecord(
        id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        status=InterviewStatus.reported,
        context=context,
        started_at=started_at,
        ended_at=ended_at,
    )

    assert in_progress.ended_at is None
    assert reported.ended_at == ended_at
    with pytest.raises(ValidationError):
        InterviewRecord(
            id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            context=context,
            started_at=started_at,
        )
    with pytest.raises(ValidationError):
        InterviewRecord(
            id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            status=InterviewStatus.in_progress,
            context=context,
        )
    with pytest.raises(ValidationError):
        InterviewRecord(
            id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            status=InterviewStatus.in_progress,
            context=context,
            started_at=started_at,
            ended_at=ended_at,
        )
    with pytest.raises(ValidationError):
        InterviewRecord(
            id="session-1",
            job_id="job-1",
            candidate_id="candidate-1",
            status=InterviewStatus.finished,
            context=context,
            started_at=started_at,
        )


def test_record_models_reject_mismatched_nested_identifiers() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
    )

    job = JobRecord(id="job-1", title="Backend", jd_text="Python FastAPI", competency_model=model)
    interview = InterviewRecord(
        id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        context=context,
    )

    assert job.competency_model.job_id == job.id
    assert interview.context.session_id == interview.id
    assert interview.context.candidate_id == interview.candidate_id
    with pytest.raises(ValidationError):
        JobRecord(id="job-2", title="Backend", jd_text="Python FastAPI", competency_model=model)
    with pytest.raises(ValidationError):
        InterviewRecord(id="session-2", job_id="job-1", candidate_id="candidate-1", context=context)
    with pytest.raises(ValidationError):
        InterviewRecord(id="session-1", job_id="job-2", candidate_id="candidate-1", context=context)
    with pytest.raises(ValidationError):
        InterviewRecord(id="session-1", job_id="job-1", candidate_id="candidate-2", context=context)


def test_consent_record_rejects_revocation_before_grant() -> None:
    granted_at = datetime(2026, 6, 2, 10, 0, tzinfo=UTC)
    record = ConsentRecord(
        candidate_id="candidate-1",
        granted=True,
        granted_at=granted_at,
        revoked_at=granted_at,
    )

    assert record.revoked_at == granted_at
    with pytest.raises(ValidationError):
        ConsentRecord(
            candidate_id="candidate-1",
            granted=True,
            granted_at=granted_at,
            revoked_at=granted_at - timedelta(seconds=1),
        )


def test_scoring_and_report_requests_require_aigc_results() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    turn = QATurn(turn_id="turn-1", question="q", answer="a")
    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
        turns=[turn],
    )
    score = InterviewScore(
        session_id="session-1",
        dimensions=[
            DimensionScore(
                dimension="项目真实性",
                score=80.0,
                weight=1.0,
                evidence=[
                    EvidenceRef(
                        turn_id="turn-1",
                        quote_start_ms=0,
                        quote_end_ms=0,
                        excerpt="a",
                    )
                ],
            )
        ],
        total_score=80.0,
        recommendation="yes",
    )

    with pytest.raises(ValidationError):
        ScoringRequest(context=context, aigc_results=[])
    with pytest.raises(ValidationError):
        ReportBuildRequest(context=context, score=score, aigc_results=[])


def test_scoring_and_report_requests_require_aigc_turn_coverage() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    first_turn = QATurn(turn_id="turn-1", question="q1", answer="a1")
    second_turn = QATurn(turn_id="turn-2", question="q2", answer="a2")
    context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=model,
        turns=[first_turn, second_turn],
    )
    score = InterviewScore(
        session_id="session-1",
        dimensions=[
            DimensionScore(
                dimension="项目真实性",
                score=80.0,
                weight=1.0,
                evidence=[
                    EvidenceRef(
                        turn_id="turn-1",
                        quote_start_ms=0,
                        quote_end_ms=0,
                        excerpt="a1",
                    )
                ],
            )
        ],
        total_score=80.0,
        recommendation="yes",
    )
    first_aigc = AIGCResult(turn_id="turn-1", ai_generated_prob=0.2, template_similarity=0.1)
    second_aigc = AIGCResult(turn_id="turn-2", ai_generated_prob=0.3, template_similarity=0.1)
    unknown_aigc = AIGCResult(turn_id="missing-turn", ai_generated_prob=0.2, template_similarity=0.1)

    scoring_request = ScoringRequest(context=context, aigc_results=[first_aigc, second_aigc])
    report_request = ReportBuildRequest(context=context, score=score, aigc_results=[first_aigc, second_aigc])

    assert scoring_request.aigc_results[1].turn_id == "turn-2"
    assert report_request.aigc_results[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        ScoringRequest(context=context, aigc_results=[first_aigc])
    with pytest.raises(ValidationError):
        ScoringRequest(context=context, aigc_results=[first_aigc, first_aigc])
    with pytest.raises(ValidationError):
        ScoringRequest(context=context, aigc_results=[first_aigc, unknown_aigc])
    with pytest.raises(ValidationError):
        ReportBuildRequest(context=context, score=score, aigc_results=[first_aigc])
    with pytest.raises(ValidationError):
        ReportBuildRequest(context=context, score=score, aigc_results=[first_aigc, first_aigc])
    with pytest.raises(ValidationError):
        ReportBuildRequest(context=context, score=score, aigc_results=[first_aigc, unknown_aigc])


def test_report_requires_aigc_results_and_summary() -> None:
    turn = QATurn(turn_id="turn-1", question="q1", answer="回答", answer_start_ms=0, answer_end_ms=10)
    second_turn = QATurn(turn_id="turn-2", question="q2", answer="补充回答")
    evidence = EvidenceRef(
        turn_id="turn-1",
        quote_start_ms=0,
        quote_end_ms=10,
        excerpt="回答",
    )
    score = InterviewScore(
        session_id="session-1",
        dimensions=[
            DimensionScore(
                dimension="项目真实性",
                score=80.0,
                weight=1.0,
                evidence=[evidence],
            )
        ],
        total_score=80.0,
        recommendation="yes",
    )
    aigc = AIGCResult(turn_id="turn-1", ai_generated_prob=0.2, template_similarity=0.1)
    unknown_aigc = AIGCResult(turn_id="missing-turn", ai_generated_prob=0.2, template_similarity=0.1)

    report = Report(
        interview_id="session-1",
        score=score,
        aigc_results=[aigc],
        consistency_flags=[],
        transcript=[turn],
        summary="报告摘要",
    )

    assert report.aigc_results[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        Report(
            interview_id="interview-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[turn],
            summary=" ",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
            pdf_path=" ",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
            artifact_uris={"pdf": " "},
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
            artifact_uris={" ": "file:///tmp/report.pdf"},
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc, AIGCResult(turn_id="turn-2", ai_generated_prob=0.2, template_similarity=0.1)],
            consistency_flags=[],
            transcript=[turn, turn],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[],
            transcript=[second_turn],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[unknown_aigc],
            consistency_flags=[],
            transcript=[turn],
            summary="报告摘要",
        )
    with pytest.raises(ValidationError):
        Report(
            interview_id="session-1",
            score=score,
            aigc_results=[aigc],
            consistency_flags=[
                ConsistencyFlag(
                    turn_id_a="turn-1",
                    turn_id_b="missing-turn",
                    description="未知来源的一致性标记",
                    severity="high",
                )
            ],
            transcript=[turn],
            summary="报告摘要",
        )


def test_evidence_ref_rejects_invalid_quote_time_ranges() -> None:
    ref = EvidenceRef(
        turn_id="turn-1",
        quote_start_ms=100,
        quote_end_ms=100,
        excerpt="回答片段",
    )

    assert ref.quote_start_ms == 100
    with pytest.raises(ValidationError):
        EvidenceRef(
            turn_id="turn-1",
            quote_start_ms=-1,
            quote_end_ms=100,
            excerpt="回答片段",
        )
    with pytest.raises(ValidationError):
        EvidenceRef(
            turn_id="turn-1",
            quote_start_ms=200,
            quote_end_ms=100,
            excerpt="回答片段",
        )
    with pytest.raises(ValidationError):
        EvidenceRef(
            turn_id="turn-1",
            quote_start_ms=0,
            quote_end_ms=100,
            excerpt=" ",
        )


def test_dimension_scores_require_evidence_and_score_requires_dimensions() -> None:
    evidence = EvidenceRef(
        turn_id="turn-1",
        quote_start_ms=0,
        quote_end_ms=100,
        excerpt="回答片段",
    )
    dimension = DimensionScore(
        dimension="项目真实性",
        score=80.0,
        weight=0.25,
        evidence=[evidence],
    )

    assert dimension.evidence[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        DimensionScore(
            dimension="项目真实性",
            score=80.0,
            weight=0.25,
            evidence=[],
        )
    with pytest.raises(ValidationError):
        DimensionScore(
            dimension="项目真实性",
            score=80.0,
            weight=float("nan"),
            evidence=[evidence],
        )
    with pytest.raises(ValidationError):
        DimensionScore(
            dimension="项目真实性",
            score=80.0,
            weight=float("inf"),
            evidence=[evidence],
        )
    with pytest.raises(ValidationError):
        InterviewScore(
            session_id="session-1",
            dimensions=[],
            total_score=80.0,
            recommendation="yes",
        )
    with pytest.raises(ValidationError):
        InterviewScore(
            session_id="session-1",
            dimensions=[dimension],
            total_score=80.0,
            risk_notes=[" "],
            recommendation="yes",
        )
    with pytest.raises(ValidationError):
        InterviewScore(
            session_id="session-1",
            dimensions=[
                dimension,
                DimensionScore(
                    dimension=" 项目真实性 ",
                    score=70.0,
                    weight=0.25,
                    evidence=[evidence],
                ),
            ],
            total_score=80.0,
            recommendation="yes",
        )


def test_probe_response_requires_one_to_three_suggestions() -> None:
    credibility = CredibilitySignal(
        level="vague",
        reason="缺少具体细节",
        drill_down_hint="追问本人负责部分",
    )
    suggestion = ProbeSuggestion(
        question="请讲清楚你本人负责哪一段？",
        target="验证项目真实性",
        competency="项目真实性",
        priority=1,
    )

    response = ProbeResponse(suggestions=[suggestion], credibility=credibility)

    assert response.suggestions[0].priority == 1
    with pytest.raises(ValidationError):
        ProbeResponse(suggestions=[], credibility=credibility)
    with pytest.raises(ValidationError):
        ProbeResponse(
            suggestions=[
                suggestion.model_copy(update={"priority": priority})
                for priority in [1, 2, 3, 3]
            ],
            credibility=credibility,
        )


def test_probe_contract_rejects_blank_answer_and_card_text() -> None:
    competency = CompetencyItem(name="项目真实性", description="验证项目经历", weight=1.0)
    model = CompetencyModel(job_id="job-1", job_title="Backend", items=[competency])
    turn = QATurn(turn_id="turn-1", question="q", answer="a")

    request = ProbeRequest(
        job_id="job-1",
        competency_model=model,
        recent_turns=[turn],
        latest_answer="回答",
    )

    assert request.recent_turns[0].turn_id == "turn-1"
    with pytest.raises(ValidationError):
        ProbeRequest(
            job_id="job-1",
            competency_model=model,
            recent_turns=[],
            latest_answer=" ",
        )
    with pytest.raises(ValidationError):
        ProbeRequest(
            job_id="job-1",
            competency_model=model,
            recent_turns=[turn, turn],
            latest_answer="回答",
        )
    with pytest.raises(ValidationError):
        ProbeSuggestion(
            question=" ",
            target="验证项目真实性",
            competency="项目真实性",
            priority=1,
        )
    with pytest.raises(ValidationError):
        ProbeSuggestion(
            question="请讲清楚你本人负责哪一段？",
            target=" ",
            competency="项目真实性",
            priority=1,
        )
    with pytest.raises(ValidationError):
        CredibilitySignal(level="vague", reason=" ", drill_down_hint="追问本人负责部分")
    with pytest.raises(ValidationError):
        CredibilitySignal(level="vague", reason="缺少具体细节", drill_down_hint=" ")
