from __future__ import annotations

import asyncio
from time import perf_counter

from libs.schemas import (
    AIGCResult,
    CandidateCreate,
    ChainLink,
    CompetencyItem,
    CompetencyModel,
    InterviewContext,
    InterviewCreate,
    JobCreate,
    ProbeChain,
    ProbeRequest,
    QATurn,
    TranscriptSegment,
    Utterance,
)
from libs.common.config import get_settings
from libs.common.database import init_db
from services.aigc_detect_service.service import detect_interview
from services.gateway.app import _schedule_probe_task
from services.interview_orchestrator.dialogue import DialogueAssembler, FALLBACK_QUESTION
from services.interview_orchestrator.service import (
    add_turn,
    add_utterance,
    create_candidate,
    create_interview,
    get_interview,
    list_turns,
    list_utterances,
    should_probe_v2,
)
from services.jd_kb_service.service import create_job
from services.probe_service.service import fallback_probe
from services.scoring_service.service import fallback_score_interview, score_interview


def _competencies() -> CompetencyModel:
    return CompetencyModel(
        job_id="job-1",
        job_title="AI 后端",
        items=[
            CompetencyItem(name="项目真实性", description="真实性", weight=0.6),
            CompetencyItem(name="注水风险", description="风险", weight=-0.1),
            CompetencyItem(name="沟通与逻辑", description="表达", weight=0.4),
        ],
    )


def _segment(
    speaker: str,
    text: str,
    start_ms: int,
    end_ms: int,
    *,
    session_id: str = "session-1",
) -> TranscriptSegment:
    return TranscriptSegment(
        session_id=session_id,
        speaker=speaker,  # type: ignore[arg-type]
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        is_final=True,
        confidence=0.9,
    )


def test_dialogue_assembler_pairs_real_question_and_merged_answer() -> None:
    assembler = DialogueAssembler(silence_close_ms=2500)

    first = assembler.feed(_segment("interviewer", "请介绍核心项目。", 0, 900))
    assert first.turns == []
    assert first.utterances == []

    second = assembler.feed(_segment("candidate", "我负责网关。", 1200, 1800))
    assert second.turns == []
    assert second.utterances[0].speaker == "interviewer"

    assembler.feed(_segment("candidate", "主要做限流和降级。", 1900, 2600))
    sealed = assembler.feed(_segment("interviewer", "继续说指标。", 5200, 6000))

    assert sealed.utterances[0].speaker == "candidate"
    turn = sealed.turns[0]
    assert turn.question == "请介绍核心项目。"
    assert turn.answer == "我负责网关。 主要做限流和降级。"
    assert turn.question_utterance_id == second.utterances[0].utterance_id
    assert turn.answer_utterance_id == sealed.utterances[0].utterance_id


def test_dialogue_assembler_uses_explicit_fallback_for_candidate_first() -> None:
    assembler = DialogueAssembler()

    result = assembler.feed(
        _segment("candidate", "我先讲项目背景。", 0, 1000),
        force_close=True,
    )

    assert result.utterances[0].speaker == "candidate"
    assert result.turns[0].question == FALLBACK_QUESTION


def test_dialogue_assembler_applies_pending_question_annotation() -> None:
    assembler = DialogueAssembler()
    question_result = assembler.feed(
        _segment("interviewer", "网关系统你亲自写了哪段代码？", 0, 900),
        force_close=True,
    )

    assert question_result.utterances[0].speaker == "interviewer"
    assembler.annotate_pending_question(
        "请讲你在网关系统里亲自写了哪段代码？",
        asked_option_id="option-1",
        question_origin="system_suggested",
    )
    answer_result = assembler.feed(
        _segment("candidate", "我写了限流中间件和降级开关。", 1000, 1800),
        force_close=True,
    )

    turn = answer_result.turns[0]
    assert turn.question == "请讲你在网关系统里亲自写了哪段代码？"
    assert turn.asked_option_id == "option-1"
    assert turn.question_origin == "system_suggested"


def test_dialogue_assembler_closes_same_speaker_after_long_silence() -> None:
    assembler = DialogueAssembler(silence_close_ms=2500)

    assembler.feed(_segment("candidate", "第一段回答。", 0, 800))
    result = assembler.feed(_segment("candidate", "第二段回答。", 4000, 4800))
    flushed = assembler.flush()

    assert [item.text for item in result.utterances] == ["第一段回答。"]
    assert [item.answer for item in result.turns] == ["第一段回答。"]
    assert [item.text for item in flushed.utterances] == ["第二段回答。"]
    assert [item.answer for item in flushed.turns] == ["第二段回答。"]


def test_probe_chain_penalty_and_rehearsal_score_are_deterministic() -> None:
    first = QATurn(
        question="你具体负责哪一段？",
        answer="记不清了，主要是团队一起做的。",
        answer_start_ms=0,
        answer_end_ms=1000,
    )
    second = QATurn(
        question="那你写过哪段代码？",
        question_source="ai_probe",
        answer="这块主要也是团队负责，我参与了一些优化。",
        answer_start_ms=1500,
        answer_end_ms=2600,
        probe_target="简历写独立主导网关项目",
    )
    chain = ProbeChain(
        interview_id="session-1",
        topic="简历写独立主导网关项目",
        origin="resume_claim",
        links=[
            ChainLink(
                probe_question=first.question,
                probe_target="简历写独立主导网关项目",
                answer_turn_id=first.turn_id,
                credibility_after="suspicious",
            ),
            ChainLink(
                probe_question=second.question,
                probe_target="简历写独立主导网关项目",
                answer_turn_id=second.turn_id,
                credibility_after="vague",
            ),
        ],
        verdict="cracked",
        crack_depth=2,
    )
    ctx = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=_competencies(),
        turns=[first, second],
        probe_chains=[chain],
    )
    aigc = detect_interview(ctx.turns, probe_chains=ctx.probe_chains)
    score = fallback_score_interview(ctx, aigc)

    assert aigc[0].mode == "voice"
    assert aigc[0].rehearsal_score >= 0.0
    assert any("第 2 层追问露馅" in note for note in score.risk_notes)
    assert score.analysis_mode == "fallback"


def test_utterance_and_turn_refs_are_persisted(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'v2.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(
        CandidateCreate(name="候选人", resume_text="独立主导网关优化，响应时间提升 50%")
    )
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    question = Utterance(
        speaker="interviewer",
        text="请介绍网关项目。",
        start_ms=0,
        end_ms=800,
        sentence_count=1,
    )
    answer = Utterance(
        speaker="candidate",
        text="我负责限流和降级。",
        start_ms=1000,
        end_ms=1800,
        sentence_count=1,
    )
    add_utterance(interview.id, question)
    add_utterance(interview.id, answer)
    add_turn(
        interview.id,
        QATurn(
            question=question.text,
            answer=answer.text,
            answer_start_ms=answer.start_ms,
            answer_end_ms=answer.end_ms,
            question_utterance_id=question.utterance_id,
            answer_utterance_id=answer.utterance_id,
            asked_option_id="option-1",
            question_origin="system_suggested",
        ),
    )

    assert [item.text for item in list_utterances(interview.id)] == [question.text, answer.text]
    persisted_turn = list_turns(interview.id)[0]
    assert persisted_turn.question_utterance_id == question.utterance_id
    assert persisted_turn.answer_utterance_id == answer.utterance_id
    assert persisted_turn.asked_option_id == "option-1"
    assert persisted_turn.question_origin == "system_suggested"


def test_probe_suggestion_chain_id_is_persisted_when_answered(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'chain.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(
        CandidateCreate(name="候选人", resume_text="独立主导网关优化，响应时间提升 50%")
    )
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    chain = interview.context.probe_chains[0]
    response = fallback_probe(
        ProbeRequest(
            job_id=job.id,
            competency_model=job.competency_model,
            latest_answer="我主要负责优化，效果比较明显。",
            recent_turns=[],
            probe_chains=interview.context.probe_chains,
        )
    )
    suggestion = response.suggestions[0]

    assert suggestion.chain_id == chain.chain_id
    assert suggestion.chain_label

    add_turn(
        interview.id,
        QATurn(
            question=suggestion.question,
            question_source="ai_probe",
            answer="记不清了，主要是团队一起做的。",
            answer_start_ms=0,
            answer_end_ms=1000,
            probe_target=suggestion.target,
            probe_chain_id=suggestion.chain_id,
        ),
    )
    persisted = get_interview(interview.id)
    persisted_chain = persisted.context.probe_chains[0]

    assert persisted.context.turns[0].probe_chain_id == chain.chain_id
    assert persisted_chain.links[0].answer_turn_id == persisted.context.turns[0].turn_id
    assert persisted_chain.links[0].credibility_after == "suspicious"


def test_probe_chain_lifecycle_marks_repeated_evasion_as_cracked(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'chain-crack.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(
        CandidateCreate(name="候选人", resume_text="独立主导网关优化，响应时间提升 50%")
    )
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    chain = interview.context.probe_chains[0]

    add_turn(
        interview.id,
        QATurn(
            question="你独立主导的具体模块是什么？",
            question_source="ai_probe",
            answer="记不清了，主要是团队一起做的。",
            answer_start_ms=0,
            answer_end_ms=1000,
            probe_target=chain.topic,
            probe_chain_id=chain.chain_id,
        ),
    )
    record = add_turn(
        interview.id,
        QATurn(
            question="那你本人写过哪段核心代码？",
            question_source="ai_probe",
            answer="这块主要也是团队负责，我参与了一些优化。",
            answer_start_ms=3000,
            answer_end_ms=4200,
            probe_target=chain.topic,
            probe_chain_id=chain.chain_id,
        ),
    )
    cracked = record.context.probe_chains[0]

    assert len(cracked.links) == 2
    assert cracked.verdict == "cracked"
    assert cracked.crack_depth == 2


def test_suspicious_answer_opens_chain_without_counting_as_probe_layer(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'answer-chain.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(CandidateCreate(name="候选人", resume_text="普通项目经历"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))

    record = add_turn(
        interview.id,
        QATurn(
            question="请介绍项目。",
            answer="记不清了，主要是团队做的，我只是参与了一些内容。",
            answer_start_ms=0,
            answer_end_ms=1000,
        ),
    )

    answer_chains = [chain for chain in record.context.probe_chains if chain.origin == "answer_claim"]
    assert len(answer_chains) == 1
    assert answer_chains[0].links == []
    assert record.context.turns[0].probe_chain_id == answer_chains[0].chain_id


def test_resume_chain_requires_ownership_and_metric_and_cracks_on_conflict(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'resume-chain.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    ordinary = create_candidate(
        CandidateCreate(name="普通候选人", resume_text="负责网关优化，响应时间提升 50%")
    )
    no_metric = create_candidate(
        CandidateCreate(name="无指标候选人", resume_text="独立主导网关架构重构")
    )
    high_risk = create_candidate(
        CandidateCreate(name="高风险候选人", resume_text="独立主导网关优化，响应时间提升 50%")
    )

    assert create_interview(
        InterviewCreate(job_id=job.id, candidate_id=ordinary.id)
    ).context.probe_chains == []
    assert create_interview(
        InterviewCreate(job_id=job.id, candidate_id=no_metric.id)
    ).context.probe_chains == []
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=high_risk.id))
    chain = interview.context.probe_chains[0]

    record = add_turn(
        interview.id,
        QATurn(
            question="你独立主导的具体部分是什么？",
            question_source="ai_probe",
            answer="这块主要是团队负责，我参与了一些优化。",
            answer_start_ms=0,
            answer_end_ms=1000,
            probe_target=chain.topic,
            probe_chain_id=chain.chain_id,
        ),
    )

    cracked = record.context.probe_chains[0]
    assert cracked.verdict == "cracked"
    assert cracked.crack_depth == 1


def test_should_probe_v2_ignores_deprecated_keyword_gate(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'probe-v2.db'}")
    monkeypatch.setenv("PROBE_MIN_ANSWER_CHARS", "20")
    monkeypatch.setenv("PROBE_REQUIRE_TOPIC_MATCH", "true")
    monkeypatch.setenv("PROBE_TOPIC_KEYWORDS", "绝不会命中的词")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(CandidateCreate(name="候选人", resume_text="普通项目经历"))
    record = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))

    evasive = QATurn(
        question="具体做了什么？",
        answer="记不清了，主要是团队做的，我只是参与了一些内容。",
        answer_start_ms=0,
        answer_end_ms=1000,
    )
    solid = QATurn(
        question="具体做了什么？",
        answer="我写了限流模块，因为突发流量会击穿下游，压测指标从 800 QPS 提升到 1500 QPS。",
        answer_start_ms=2000,
        answer_end_ms=3000,
    )

    assert should_probe_v2(evasive, record) is True
    assert should_probe_v2(solid, record) is True
    assert should_probe_v2(
        QATurn(question="继续", answer="嗯，好的。", answer_start_ms=4000, answer_end_ms=4500),
        record,
    ) is False

    for index in range(3):
        record = add_turn(
            record.id,
            QATurn(
                question="继续核验项目真实性。",
                answer="我写了限流模块，因为下游容量固定，并用压测指标验证了回滚方案。",
                answer_start_ms=5000 + index * 2000,
                answer_end_ms=6000 + index * 2000,
            ),
        )
    repeated_dimension = solid.model_copy(update={"answer_start_ms": 12000, "answer_end_ms": 13000})
    assert should_probe_v2(repeated_dimension, record) is True


def test_probe_fallback_is_emitted_without_waiting_for_llm(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'probe-background.db'}")
    get_settings.cache_clear()
    init_db()
    job = create_job(JobCreate(title="AI 后端", jd_text="FastAPI LLM"))
    candidate = create_candidate(CandidateCreate(name="候选人", resume_text="普通项目经历"))
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    turn = QATurn(
        question="具体做了什么？",
        answer="记不清了，主要是团队做的，我只是参与了一些内容。",
        answer_start_ms=0,
        answer_end_ms=1000,
    )
    record = add_turn(interview.id, turn)

    async def exercise() -> None:
        llm_release = asyncio.Event()
        fallback_seen = asyncio.Event()

        class Sender:
            def __init__(self) -> None:
                self.messages: list[dict] = []

            async def send_json(self, payload: dict) -> None:
                self.messages.append(payload)
                if payload.get("type") == "probe":
                    fallback_seen.set()

        async def slow_generate(request):
            await llm_release.wait()
            return fallback_probe(request)

        monkeypatch.setattr("services.gateway.app.generate_probe", slow_generate)
        sender = Sender()
        started = perf_counter()
        _schedule_probe_task(sender, record, turn)  # type: ignore[arg-type]
        schedule_elapsed = perf_counter() - started

        await asyncio.wait_for(fallback_seen.wait(), timeout=0.5)
        assert schedule_elapsed < 0.05
        assert sender.messages[0]["type"] == "probe"
        llm_release.set()
        await asyncio.sleep(0)

    asyncio.run(exercise())


def test_each_cracked_chain_applies_exact_project_authenticity_penalty() -> None:
    first = QATurn(
        question="你负责什么？",
        answer=(
            "我具体写了限流模块和故障降级开关，因为下游容量固定，我用压测确定了阈值口径，"
            "上线后网关超时率指标从 2.1% 降到 0.4%，期间排查过一次令牌桶时钟漂移故障并补了监控告警，"
            "复盘后我把时钟源切换逻辑写进了部署检查清单，并加了漂移指标的告警阈值。"
        ),
        answer_start_ms=0,
        answer_end_ms=1000,
    )
    second = QATurn(
        question="请继续说明。",
        answer=(
            "我补充了压测指标口径和回滚方案：压测覆盖峰值三倍流量，回滚靠配置开关在 30 秒内生效，"
            "因为之前一次发布故障让我们意识到必须先验证降级路径，我具体写了回滚演练脚本并记录了指标，"
            "每次发布前演练一遍，演练结果和指标截图归档到发布单里供复盘使用。"
        ),
        answer_start_ms=1500,
        answer_end_ms=2500,
    )
    chain = ProbeChain(
        interview_id="session-1",
        topic="网关项目真实性",
        origin="answer_claim",
        links=[
            ChainLink(
                probe_question=first.question,
                probe_target="网关项目真实性",
                answer_turn_id=first.turn_id,
                credibility_after="suspicious",
            ),
            ChainLink(
                probe_question=second.question,
                probe_target="网关项目真实性",
                answer_turn_id=second.turn_id,
                credibility_after="vague",
            ),
        ],
        verdict="cracked",
        crack_depth=2,
    )
    aigc = [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.0,
            template_similarity=0.0,
            rehearsal_score=0.0,
            mode="voice",
            flagged=False,
        )
        for turn in (first, second)
    ]
    base_context = InterviewContext(
        session_id="session-1",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=_competencies(),
        turns=[first, second],
    )
    cracked_context = base_context.model_copy(update={"probe_chains": [chain]})

    base_score = fallback_score_interview(base_context, aigc)
    cracked_score = fallback_score_interview(cracked_context, aigc)
    base_project = next(item for item in base_score.dimensions if item.dimension == "项目真实性")
    cracked_project = next(
        item for item in cracked_score.dimensions if item.dimension == "项目真实性"
    )

    assert base_project.score - cracked_project.score == get_settings().chain_crack_penalty


def test_held_up_chain_bonus_cannot_be_erased_by_llm_draft(monkeypatch) -> None:
    first = QATurn(
        question="具体模块是什么？",
        answer=(
            "我具体实现了令牌桶限流模块，因为突发流量会击穿下游，我用压测确定了桶容量和补充速率口径，"
            "上线后限流误杀率指标稳定在 0.2% 以下，期间排查过一次时钟回拨导致的令牌溢出故障，"
            "修复方案是改用单调时钟并补了溢出计数指标的告警，复盘记录我写进了团队故障库。"
        ),
        answer_start_ms=0,
        answer_end_ms=1000,
    )
    second = QATurn(
        question="为什么这样设计？",
        answer=(
            "因为下游容量固定，我用压测数据确定阈值并验证了故障降级路径：具体做法是先在影子流量验证，"
            "再灰度放量，关键指标是降级开关生效时间 30 秒以内，失败时我写了自动回滚脚本兜底，"
            "灰度期间我每天核对限流命中率和误杀率指标，确认口径一致后才放到全量。"
        ),
        answer_start_ms=1500,
        answer_end_ms=2600,
    )
    chain = ProbeChain(
        interview_id="session-held",
        topic="网关限流设计",
        origin="answer_claim",
        links=[
            ChainLink(
                probe_question=first.question,
                probe_target="网关限流设计",
                answer_turn_id=first.turn_id,
                credibility_after="solid",
            ),
            ChainLink(
                probe_question=second.question,
                probe_target="网关限流设计",
                answer_turn_id=second.turn_id,
                credibility_after="solid",
            ),
        ],
        verdict="held_up",
    )
    ctx = InterviewContext(
        session_id="session-held",
        job_id="job-1",
        candidate_id="candidate-1",
        competency_model=_competencies(),
        turns=[first, second],
        probe_chains=[chain],
    )
    aigc = [
        AIGCResult(
            turn_id=turn.turn_id,
            ai_generated_prob=0.0,
            template_similarity=0.0,
            rehearsal_score=0.0,
            mode="voice",
            flagged=False,
        )
        for turn in (first, second)
    ]
    fallback = fallback_score_interview(ctx, aigc)
    draft = fallback.model_copy(
        update={
            "dimensions": [
                item.model_copy(update={"score": 20.0 if item.dimension == "项目真实性" else item.score})
                for item in fallback.dimensions
            ],
            "analysis_mode": "llm",
        }
    )

    class FakeClient:
        def complete_json_sync(self, messages, schema, fallback_score):
            return draft

    monkeypatch.setattr("services.scoring_service.service.get_llm_client", lambda: FakeClient())

    score = score_interview(ctx, aigc)
    project = next(item for item in score.dimensions if item.dimension == "项目真实性")
    fallback_project = next(
        item for item in fallback.dimensions if item.dimension == "项目真实性"
    )

    assert project.score == fallback_project.score
    assert project.score == 81.0
