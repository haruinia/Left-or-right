from __future__ import annotations

import re
from datetime import UTC, datetime

from libs.common.config import get_settings
from libs.common.database import connect, dumps, init_db, loads
from libs.common.events import event_bus
from libs.common.tasks import task_queue
from libs.schemas import (
    CandidateCreate,
    CandidateRecord,
    ChainLink,
    ConsentCreate,
    ConsentRecord,
    InterviewContext,
    InterviewCreate,
    InterviewRecord,
    InterviewStatus,
    OfflineTaskAccepted,
    ProbeChain,
    QuestionBank,
    QATurn,
    TranscriptSegment,
    Utterance,
    new_id,
)
from services.aigc_detect_service.service import detect_interview, llm_review_aigc
from services.interview_orchestrator.consistency import detect_claim_conflicts, extract_fact_claim
from services.jd_kb_service.service import get_job
from services.probe_service.service import assess_credibility
from services.report_service.service import build_report
from services.scoring_service.service import score_interview


def create_candidate(payload: CandidateCreate) -> CandidateRecord:
    init_db()
    record = CandidateRecord(name=payload.name, resume_text=payload.resume_text)
    with connect() as conn:
        conn.execute(
            "INSERT INTO candidates (id, name, resume_text, created_at) VALUES (?, ?, ?, ?)",
            (record.id, record.name, record.resume_text, record.created_at.isoformat()),
        )
    return record


def get_or_create_candidate(payload: CandidateCreate) -> CandidateRecord:
    init_db()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM candidates
            WHERE name = ? AND resume_text = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (payload.name, payload.resume_text),
        ).fetchone()
    if row is None:
        return create_candidate(payload)
    return CandidateRecord(
        id=row["id"],
        name=row["name"],
        resume_text=row["resume_text"],
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def get_candidate(candidate_id: str) -> CandidateRecord:
    init_db()
    with connect() as conn:
        row = conn.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
    if row is None:
        raise KeyError(f"candidate not found: {candidate_id}")
    return CandidateRecord(
        id=row["id"],
        name=row["name"],
        resume_text=row["resume_text"],
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def create_consent(payload: ConsentCreate) -> ConsentRecord:
    init_db()
    get_candidate(payload.candidate_id)
    now = datetime.now(UTC)
    if not payload.granted:
        with connect() as conn:
            conn.execute(
                """
                UPDATE consents
                SET revoked_at = ?
                WHERE candidate_id = ?
                  AND consent_type = ?
                  AND granted = ?
                  AND revoked_at IS NULL
                """,
                (now.isoformat(), payload.candidate_id, payload.consent_type, True),
            )
    record = ConsentRecord(
        candidate_id=payload.candidate_id,
        consent_type=payload.consent_type,
        granted=payload.granted,
        granted_at=now,
        revoked_at=now if not payload.granted else None,
    )
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO consents
            (id, candidate_id, consent_type, granted, granted_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.candidate_id,
                record.consent_type,
                record.granted,
                record.granted_at.isoformat(),
                record.revoked_at.isoformat() if record.revoked_at else None,
            ),
        )
    return record


def has_active_consent(candidate_id: str, consent_type: str) -> bool:
    init_db()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT 1 FROM consents
            WHERE candidate_id = ?
              AND consent_type = ?
              AND granted = ?
              AND revoked_at IS NULL
            LIMIT 1
            """,
            (candidate_id, consent_type, True),
        ).fetchone()
    return row is not None


def create_interview(payload: InterviewCreate) -> InterviewRecord:
    init_db()
    job = get_job(payload.job_id)
    candidate = get_candidate(payload.candidate_id)
    if payload.signal_enabled:
        if not get_settings().signal_enabled:
            raise PermissionError("behavior signal requires admin enablement")
        if not has_active_consent(payload.candidate_id, "behavior_signal"):
            raise PermissionError("behavior signal requires explicit candidate consent")
    interview_id = new_id()
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS total FROM interviews").fetchone()
    interview_seq = int(row["total"]) + 1
    ctx = InterviewContext(
        session_id=interview_id,
        job_id=payload.job_id,
        candidate_id=payload.candidate_id,
        competency_model=job.competency_model,
        candidate_name=candidate.name,
        interview_seq=interview_seq,
        candidate_resume_text=candidate.resume_text,
        probe_chains=_preopen_resume_chains(interview_id, candidate.resume_text),
    )
    record = InterviewRecord(
        id=interview_id,
        job_id=payload.job_id,
        candidate_id=payload.candidate_id,
        context=ctx,
        signal_enabled=payload.signal_enabled,
    )
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO interviews
            (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.job_id,
                record.candidate_id,
                record.status.value,
                dumps(record.context.model_dump()),
                record.signal_enabled,
                record.created_at.isoformat(),
                None,
                None,
            ),
        )
        _persist_probe_chains(conn, interview_id, record.context.probe_chains)
    return record


def get_interview(interview_id: str) -> InterviewRecord:
    init_db()
    with connect() as conn:
        row = conn.execute("SELECT * FROM interviews WHERE id = ?", (interview_id,)).fetchone()
    if row is None:
        raise KeyError(f"interview not found: {interview_id}")
    return InterviewRecord(
        id=row["id"],
        job_id=row["job_id"],
        candidate_id=row["candidate_id"],
        status=InterviewStatus(row["status"]),
        context=InterviewContext.model_validate(loads(row["context"])),
        signal_enabled=bool(row["signal_enabled"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        started_at=datetime.fromisoformat(row["started_at"]) if row["started_at"] else None,
        ended_at=datetime.fromisoformat(row["ended_at"]) if row["ended_at"] else None,
    )


def save_interview(record: InterviewRecord) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE interviews
            SET status = ?, context = ?, signal_enabled = ?, started_at = ?, ended_at = ?
            WHERE id = ?
            """,
            (
                record.status.value,
                dumps(record.context.model_dump()),
                record.signal_enabled,
                record.started_at.isoformat() if record.started_at else None,
                record.ended_at.isoformat() if record.ended_at else None,
                record.id,
            ),
        )


def start_interview(interview_id: str) -> InterviewRecord:
    record = get_interview(interview_id)
    if record.status == InterviewStatus.in_progress:
        return record
    if record.status != InterviewStatus.created:
        raise ValueError(f"cannot start interview from status {record.status.value}")
    record.status = InterviewStatus.in_progress
    record.started_at = datetime.now(UTC)
    record.context.started_at = record.started_at
    save_interview(record)
    return record


def add_utterance(interview_id: str, utterance: Utterance) -> InterviewRecord:
    record = get_interview(interview_id)
    if record.status not in {InterviewStatus.created, InterviewStatus.in_progress}:
        raise ValueError(f"cannot add utterance to interview in status {record.status.value}")
    if any(item.utterance_id == utterance.utterance_id for item in record.context.utterances):
        raise ValueError("interview context utterances must not contain duplicate utterance_id values")
    with connect() as conn:
        existing = conn.execute(
            "SELECT interview_id FROM utterances WHERE id = ?",
            (utterance.utterance_id,),
        ).fetchone()
    if existing is not None:
        raise ValueError("utterance_id already exists")
    if record.status == InterviewStatus.created:
        record.status = InterviewStatus.in_progress
        record.started_at = datetime.now(UTC)
        record.context.started_at = record.started_at
    record.context.utterances.append(utterance)
    save_interview(record)
    with connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO utterances
            (id, interview_id, utterance_index, speaker, text, start_ms, end_ms,
             sentence_count, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                utterance.utterance_id,
                interview_id,
                len(record.context.utterances) - 1,
                utterance.speaker,
                utterance.text,
                utterance.start_ms,
                utterance.end_ms,
                utterance.sentence_count,
                dumps(utterance.model_dump()),
            ),
        )
    event_bus.publish_nowait(
        "utterance.created",
        {
            "interview_id": interview_id,
            "utterance_id": utterance.utterance_id,
            "utterance_index": len(record.context.utterances) - 1,
            "speaker": utterance.speaker,
        },
    )
    return record


def add_turn(interview_id: str, turn: QATurn) -> InterviewRecord:
    record = get_interview(interview_id)
    if record.status not in {InterviewStatus.created, InterviewStatus.in_progress}:
        raise ValueError(f"cannot add turn to interview in status {record.status.value}")
    if any(existing_turn.turn_id == turn.turn_id for existing_turn in record.context.turns):
        raise ValueError("interview context turns must not contain duplicate turn_id values")
    with connect() as conn:
        existing = conn.execute(
            "SELECT interview_id FROM qa_turns WHERE id = ?",
            (turn.turn_id,),
        ).fetchone()
    if existing is not None:
        raise ValueError("turn_id already exists")
    if record.status == InterviewStatus.created:
        record.status = InterviewStatus.in_progress
        record.started_at = datetime.now(UTC)
        record.context.started_at = record.started_at
    record.context.turns.append(turn)
    if len(record.context.fact_claims) != len(record.context.turns) - 1:
        record.context.fact_claims = [
            extract_fact_claim(existing_turn) for existing_turn in record.context.turns[:-1]
        ]
    record.context.fact_claims.append(extract_fact_claim(turn))
    record.context.flags = detect_claim_conflicts(record.context.fact_claims)
    _update_probe_chains_for_turn(record, turn)
    _apply_consistency_conflicts_to_chains(record)
    save_interview(record)
    with connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO qa_turns
            (id, interview_id, turn_index, question, question_source, answer,
             answer_start_ms, answer_end_ms, probe_target, question_utterance_id,
             answer_utterance_id, probe_chain_id, asked_option_id, question_origin, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                turn.turn_id,
                interview_id,
                len(record.context.turns) - 1,
                turn.question,
                turn.question_source,
                turn.answer,
                turn.answer_start_ms,
                turn.answer_end_ms,
                turn.probe_target,
                turn.question_utterance_id,
                turn.answer_utterance_id,
                turn.probe_chain_id,
                turn.asked_option_id,
                turn.question_origin,
                dumps(turn.model_dump()),
            ),
        )
        _persist_probe_chains(conn, interview_id, record.context.probe_chains)
    event_bus.publish_nowait(
        "qa_turn.created",
        {
            "interview_id": interview_id,
            "turn_id": turn.turn_id,
            "turn_index": len(record.context.turns) - 1,
        },
    )
    return record


def list_utterances(interview_id: str) -> list[Utterance]:
    init_db()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, speaker, text, start_ms, end_ms, sentence_count, payload
            FROM utterances
            WHERE interview_id = ?
            ORDER BY utterance_index
            """,
            (interview_id,),
        ).fetchall()
    utterances: list[Utterance] = []
    for row in rows:
        if row["payload"]:
            utterances.append(Utterance.model_validate(loads(row["payload"])))
            continue
        utterances.append(
            Utterance(
                utterance_id=row["id"],
                speaker=row["speaker"],
                text=row["text"],
                start_ms=row["start_ms"],
                end_ms=row["end_ms"],
                sentence_count=row["sentence_count"],
            )
        )
    return utterances


def list_turns(interview_id: str) -> list[QATurn]:
    init_db()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, question, question_source, answer, answer_start_ms, answer_end_ms,
                   probe_target, question_utterance_id, answer_utterance_id, probe_chain_id,
                   asked_option_id, question_origin, payload
            FROM qa_turns
            WHERE interview_id = ?
            ORDER BY turn_index
            """,
            (interview_id,),
        ).fetchall()
    turns: list[QATurn] = []
    for row in rows:
        if row["payload"]:
            turns.append(QATurn.model_validate(loads(row["payload"])))
            continue
        turns.append(
            QATurn(
                turn_id=row["id"],
                question=row["question"],
                question_source=row["question_source"],
                answer=row["answer"],
                answer_start_ms=row["answer_start_ms"],
                answer_end_ms=row["answer_end_ms"],
                probe_target=row["probe_target"],
                question_utterance_id=row["question_utterance_id"],
                answer_utterance_id=row["answer_utterance_id"],
                probe_chain_id=row["probe_chain_id"],
                asked_option_id=row["asked_option_id"],
                question_origin=row["question_origin"],
            )
        )
    return turns


def save_question_bank(bank: QuestionBank) -> QuestionBank:
    init_db()
    get_interview(bank.interview_id)
    with connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO question_banks (interview_id, payload, created_at)
            VALUES (?, ?, ?)
            """,
            (bank.interview_id, dumps(bank.model_dump()), datetime.now(UTC).isoformat()),
        )
    return bank


def get_question_bank(interview_id: str) -> QuestionBank:
    init_db()
    with connect() as conn:
        row = conn.execute(
            "SELECT payload FROM question_banks WHERE interview_id = ?",
            (interview_id,),
        ).fetchone()
    if row is None:
        raise KeyError(f"question bank not found: {interview_id}")
    return QuestionBank.model_validate(loads(row["payload"]))


def should_probe_v2(turn: QATurn, record: InterviewRecord) -> bool:
    settings = get_settings()
    if len(turn.answer.strip()) < settings.probe_min_answer_chars:
        return False
    previous_turns = [item for item in record.context.turns if item.turn_id != turn.turn_id]
    if previous_turns:
        last_turn = previous_turns[-1]
        if turn.answer_start_ms - last_turn.answer_end_ms < settings.probe_min_interval_ms:
            return False
    credibility = assess_credibility(turn.answer)
    if credibility.level in {"suspicious", "vague"}:
        return True
    return _has_competency_coverage_gap(record)


def should_probe_turn(turn: QATurn, record: InterviewRecord) -> bool:
    return should_probe_v2(turn, record)


def should_probe(segment: TranscriptSegment, record: InterviewRecord) -> bool:
    settings = get_settings()
    if not segment.is_final or segment.speaker != "candidate":
        return False
    if len(segment.text.strip()) < settings.probe_min_answer_chars:
        return False
    if not record.context.turns:
        return True
    last_turn = record.context.turns[-1]
    if segment.start_ms - last_turn.answer_end_ms < settings.probe_min_interval_ms:
        return False
    return assess_credibility(segment.text).level in {"suspicious", "vague"} or _has_competency_coverage_gap(record)


def _has_competency_coverage_gap(record: InterviewRecord) -> bool:
    return any(count < 1 for count in _competency_coverage(record).values())


def _competency_coverage(record: InterviewRecord) -> dict[str, int]:
    items = record.context.competency_model.items
    coverage = {item.name: 0 for item in items}
    for turn in record.context.turns:
        haystack = f"{turn.question} {turn.probe_target or ''}".lower()
        matched = [
            item.name
            for item in items
            if item.name.lower() in haystack
            or any(keyword in haystack for keyword in _coverage_keywords(item.name))
        ]
        if not matched and coverage:
            matched = [min(coverage, key=coverage.get)]  # type: ignore[arg-type]
        for name in matched:
            coverage[name] += 1
    return coverage


def _coverage_keywords(dimension: str) -> tuple[str, ...]:
    mapping = {
        "项目真实性": ("项目", "本人负责", "主导", "独立", "上线指标"),
        "注水风险": ("注水", "真实性", "记不清", "团队做", "个人贡献"),
        "沟通与逻辑": ("逻辑", "取舍", "复盘", "为什么", "表达"),
    }
    return mapping.get(dimension, ())


def _open_competency_gap_chain(record: InterviewRecord) -> ProbeChain:
    coverage = _competency_coverage(record)
    missing = next(
        item for item in record.context.competency_model.items if coverage[item.name] < 1
    )
    topic = f"覆盖缺口：{missing.name}"
    return _find_or_create_probe_chain(record, topic, origin="competency_gap")


def _preopen_resume_chains(interview_id: str, resume_text: str) -> list[ProbeChain]:
    chains: list[ProbeChain] = []
    for claim in _high_risk_resume_claims(resume_text):
        chains.append(
            ProbeChain(
                interview_id=interview_id,
                topic=claim,
                origin="resume_claim",
                resume_claim_ref=claim,
            )
        )
        if len(chains) >= 3:
            break
    return chains


def _high_risk_resume_claims(resume_text: str) -> list[str]:
    ownership_markers = ("独立", "主导")
    metric_pattern = re.compile(
        r"(?:\d+(?:\.\d+)?\s*(?:%|％|倍|ms|毫秒|秒|qps|tps|万|亿))|"
        r"(?:提升|降低|减少|增长|优化).{0,12}\d",
        re.IGNORECASE,
    )
    claims: list[str] = []
    for raw in re.split(r"[。\n；;]", resume_text):
        claim = raw.strip()
        if (
            len(claim) >= 8
            and any(marker in claim for marker in ownership_markers)
            and metric_pattern.search(claim)
        ):
            claims.append(claim[:160])
    return claims


def _update_probe_chains_for_turn(record: InterviewRecord, turn: QATurn) -> None:
    credibility = assess_credibility(turn.answer)
    target = _chain_target_for_turn(turn)
    if turn.probe_chain_id:
        chain = _find_probe_chain_by_id(record, turn.probe_chain_id)
        if chain is None:
            chain = ProbeChain(
                chain_id=turn.probe_chain_id,
                interview_id=record.id,
                topic=target,
                origin="answer_claim",
            )
            record.context.probe_chains.append(chain)
        _append_probe_chain_link(chain, turn, target, credibility.level)
        return
    if turn.question_source != "ai_probe" and not turn.probe_target:
        if credibility.level == "suspicious":
            chain = _find_or_create_probe_chain(record, target, origin="answer_claim")
            turn.probe_chain_id = chain.chain_id
            return
        if _has_competency_coverage_gap(record):
            _open_competency_gap_chain(record)
        return
    chain = _find_or_create_probe_chain(record, target, origin="answer_claim")
    if not turn.probe_chain_id:
        turn.probe_chain_id = chain.chain_id
    _append_probe_chain_link(chain, turn, target, credibility.level)


def _append_probe_chain_link(
    chain: ProbeChain,
    turn: QATurn,
    target: str,
    credibility_level: str,
) -> None:
    if any(link.answer_turn_id == turn.turn_id for link in chain.links):
        return
    chain.links.append(
        ChainLink(
            probe_question=turn.question,
            probe_target=target,
            answer_turn_id=turn.turn_id,
            credibility_after=credibility_level,  # type: ignore[arg-type]
        )
    )
    _refresh_probe_chain_verdict(chain)
    if _resume_claim_conflicts_with_answer(chain, turn.answer):
        chain.verdict = "cracked"
        chain.crack_depth = len(chain.links)


def _resume_claim_conflicts_with_answer(chain: ProbeChain, answer: str) -> bool:
    if chain.origin != "resume_claim" or not chain.resume_claim_ref:
        return False
    claim = chain.resume_claim_ref
    if not any(marker in claim for marker in ("独立", "主导")):
        return False
    normalized = re.sub(r"\s+", "", answer.lower())
    conflict_markers = (
        "团队做的",
        "团队负责",
        "主要是团队",
        "我只是参与",
        "我参与了一些",
        "别人负责",
        "同事负责",
        "协助完成",
    )
    return any(marker in normalized for marker in conflict_markers)


def _chain_target_for_turn(turn: QATurn) -> str:
    if turn.probe_target:
        return turn.probe_target
    text = turn.answer.strip() or turn.question.strip()
    return text[:80]


def _find_or_create_probe_chain(
    record: InterviewRecord,
    target: str,
    *,
    origin: str,
) -> ProbeChain:
    normalized_target = target.strip().lower()
    for chain in record.context.probe_chains:
        normalized_topic = chain.topic.strip().lower()
        if normalized_target in normalized_topic or normalized_topic in normalized_target:
            return chain
    chain = ProbeChain(
        interview_id=record.id,
        topic=target,
        origin=origin,  # type: ignore[arg-type]
    )
    record.context.probe_chains.append(chain)
    return chain


def _find_probe_chain_by_id(record: InterviewRecord, chain_id: str) -> ProbeChain | None:
    return next((chain for chain in record.context.probe_chains if chain.chain_id == chain_id), None)


def _refresh_probe_chain_verdict(chain: ProbeChain) -> None:
    chain.verdict = "unresolved"
    chain.crack_depth = None
    if len(chain.links) >= 2 and all(link.credibility_after == "solid" for link in chain.links[-2:]):
        chain.verdict = "held_up"
        return
    for index in range(len(chain.links) - 1):
        current = chain.links[index]
        next_link = chain.links[index + 1]
        if (
            current.credibility_after == "suspicious"
            and next_link.credibility_after in {"suspicious", "vague"}
        ):
            chain.verdict = "cracked"
            chain.crack_depth = index + 2
            return


def _apply_consistency_conflicts_to_chains(record: InterviewRecord) -> None:
    if not record.context.flags:
        return
    conflict_turn_ids = {
        turn_id
        for flag in record.context.flags
        for turn_id in (flag.turn_id_a, flag.turn_id_b)
        if flag.severity == "high"
    }
    if not conflict_turn_ids:
        return
    for chain in record.context.probe_chains:
        if chain.verdict == "cracked":
            continue
        for index, link in enumerate(chain.links, start=1):
            if link.answer_turn_id in conflict_turn_ids:
                chain.verdict = "cracked"
                chain.crack_depth = index
                break


def _persist_probe_chains(conn, interview_id: str, chains: list[ProbeChain]) -> None:
    for index, chain in enumerate(chains):
        conn.execute(
            """
            INSERT OR REPLACE INTO probe_chains
            (id, interview_id, chain_index, topic, origin, verdict, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chain.chain_id,
                interview_id,
                index,
                chain.topic,
                chain.origin,
                chain.verdict,
                dumps(chain.model_dump()),
            ),
        )


def finish_interview(interview_id: str) -> InterviewRecord:
    record = get_interview(interview_id)
    if record.status == InterviewStatus.finished:
        return record
    if record.status != InterviewStatus.in_progress:
        raise ValueError(f"cannot finish interview from status {record.status.value}")
    if not record.context.turns:
        raise ValueError("cannot finish interview without candidate turns")
    record.status = InterviewStatus.finished
    record.ended_at = datetime.now(UTC)
    record.context.ended_at = record.ended_at
    save_interview(record)
    event_bus.publish_nowait(
        "interview.finished",
        {"interview_id": interview_id, "ended_at": record.ended_at.isoformat()},
    )
    return record


def run_offline_scoring_task(interview_id: str):
    record = get_interview(interview_id)
    if record.status not in {InterviewStatus.finished, InterviewStatus.scoring}:
        raise ValueError(
            f"offline scoring requires FINISHED or SCORING status, got {record.status.value}"
        )
    record.status = InterviewStatus.scoring
    save_interview(record)
    event_bus.publish_nowait(
        "interview.scoring_started",
        {"interview_id": interview_id, "turn_count": len(record.context.turns)},
    )
    aigc = detect_interview(record.context.turns, probe_chains=record.context.probe_chains)
    aigc = llm_review_aigc(record.context.turns, aigc)
    score = score_interview(record.context, aigc)
    report, html = build_report(record.context, score, aigc)
    record.status = InterviewStatus.reported
    save_interview(record)
    with connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO scores
            (interview_id, dimensions, total_score, risk_notes, recommendation, payload)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                interview_id,
                dumps([dimension.model_dump() for dimension in score.dimensions]),
                score.total_score,
                dumps(score.risk_notes),
                score.recommendation,
                dumps(score.model_dump()),
            ),
        )
        for item in aigc:
            conn.execute(
                """
                INSERT OR REPLACE INTO aigc_results
                (id, interview_id, turn_id, ai_generated_prob, template_similarity,
                 matched_template, flagged, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.turn_id,
                    interview_id,
                    item.turn_id,
                    item.ai_generated_prob,
                    item.template_similarity,
                    item.matched_template,
                    item.flagged,
                    dumps(item.model_dump()),
                ),
            )
        conn.execute(
            "INSERT OR REPLACE INTO reports (interview_id, payload, html) VALUES (?, ?, ?)",
            (interview_id, dumps(report.model_dump()), html),
        )
    _distill_long_term_memory(record.context, score.recommendation)
    event_bus.publish_nowait(
        "interview.reported",
        {
            "interview_id": interview_id,
            "total_score": report.score.total_score,
            "recommendation": report.score.recommendation,
        },
    )
    return report


def _distill_long_term_memory(context, recommendation: str) -> None:
    """Sediment cross-interview memory. Never fails the scoring pipeline."""
    from services.memory_service.distill import distill_interview_memories

    try:
        distill_interview_memories(context, score_summary=recommendation)
    except Exception:
        return


def enqueue_offline_scoring_task(interview_id: str, *, execute_inline: bool | None = None):
    if execute_inline is None:
        execute_inline = get_settings().offline_task_execution != "async"
    if not execute_inline:
        interview = get_interview(interview_id)
        if interview.status != InterviewStatus.finished:
            raise ValueError(f"cannot queue offline scoring from status {interview.status.value}")
        record = task_queue.enqueue_deferred(
            "interview.offline_scoring",
            {"interview_id": interview_id},
        )
        interview.status = InterviewStatus.scoring
        save_interview(interview)
        return OfflineTaskAccepted(
            interview_id=interview_id,
            task_id=record.task_id,
            task_name=record.name,
            status="queued",
        )
    record = task_queue.enqueue(
        "interview.offline_scoring",
        {"interview_id": interview_id},
        lambda payload: run_offline_scoring_task(str(payload["interview_id"])),
    )
    return record.result


def end_interview(interview_id: str, *, execute_inline: bool | None = None):
    finish_interview(interview_id)
    return enqueue_offline_scoring_task(interview_id, execute_inline=execute_inline)


def get_report(interview_id: str):
    init_db()
    with connect() as conn:
        row = conn.execute("SELECT payload, html FROM reports WHERE interview_id = ?", (interview_id,)).fetchone()
    if row is None:
        raise KeyError(f"report not found: {interview_id}")
    return loads(row["payload"]), row["html"]
