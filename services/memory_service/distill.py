from __future__ import annotations

import json

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import DistilledMemory, DistilledMemoryItem, InterviewContext
from services.interview_orchestrator.service import has_active_consent
from services.memory_service.service import save_interview_memory


def distill_interview_memories(
    context: InterviewContext,
    *,
    score_summary: str = "",
) -> list[DistilledMemoryItem]:
    """Persist cross-interview memory for a finished interview.

    Returns the items written. Requires MEMORY_ENABLED and an active
    `long_term_memory` consent for the candidate, because these rows outlive
    the interview and describe a real person.
    """
    settings = get_settings()
    if not settings.memory_enabled:
        return []
    if not has_active_consent(context.candidate_id, "long_term_memory"):
        return []
    distilled = _distill(context, score_summary)
    written: list[DistilledMemoryItem] = []
    for item in _limit_items(distilled.items):
        save_interview_memory(
            kind=item.kind,
            subject_key=item.subject_key,
            summary=item.summary,
            detail=item.detail,
            source_interview_id=context.session_id,
            candidate_id=context.candidate_id if item.kind == "candidate_profile" else None,
            job_id=context.job_id if item.kind == "job_insight" else None,
        )
        written.append(item)
    return written


def _distill(context: InterviewContext, score_summary: str) -> DistilledMemory:
    fallback = _fallback(context, score_summary)
    payload = {
        "interview_id": context.session_id,
        "job_id": context.job_id,
        "candidate_id": context.candidate_id,
        "score_summary": score_summary,
        "turns": [
            {"turn_id": turn.turn_id, "question": turn.question, "answer": turn.answer}
            for turn in context.turns
        ],
        "probe_chains": [chain.model_dump(mode="json") for chain in context.probe_chains],
        "competencies": [item.name for item in context.competency_model.items],
    }
    try:
        return get_llm_client().complete_json_sync(
            [
                LLMMessage(role="system", content=load_prompt("memory_distill.md")),
                LLMMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
            ],
            DistilledMemory,
            fallback,
        )
    except Exception:
        return fallback


def _fallback(context: InterviewContext, score_summary: str) -> DistilledMemory:
    """Deterministic distillation used when the LLM is unavailable."""
    cracked = [chain for chain in context.probe_chains if chain.verdict == "cracked"]
    held_up = [chain for chain in context.probe_chains if chain.verdict == "held_up"]
    profile = (
        f"共 {len(context.turns)} 轮问答，追问链 {len(context.probe_chains)} 条，"
        f"其中击穿 {len(cracked)} 条、验证成立 {len(held_up)} 条。"
    )
    if score_summary.strip():
        profile = f"{profile}评分结论：{score_summary.strip()}"
    items = [
        DistilledMemoryItem(
            kind="candidate_profile",
            subject_key=context.candidate_id,
            summary=profile,
            detail="由确定性回退生成，未经模型提炼。",
        )
    ]
    for chain in cracked[:3]:
        items.append(
            DistilledMemoryItem(
                kind="probe_playbook",
                subject_key=chain.topic,
                summary=f"围绕「{chain.topic}」下钻可以击穿笼统回答。",
                detail=f"本场在第 {chain.crack_depth or 1} 层追问时击穿。",
            )
        )
    return DistilledMemory(items=items)


def _limit_items(items: list[DistilledMemoryItem]) -> list[DistilledMemoryItem]:
    """Keep at most one candidate_profile, 4 playbooks and 2 job insights."""
    caps = {"candidate_profile": 1, "probe_playbook": 4, "job_insight": 2}
    seen: dict[str, int] = {}
    kept: list[DistilledMemoryItem] = []
    for item in items:
        used = seen.get(item.kind, 0)
        if used >= caps[item.kind]:
            continue
        seen[item.kind] = used + 1
        kept.append(item)
    return kept
