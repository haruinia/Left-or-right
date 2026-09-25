from __future__ import annotations

import json
from typing import Literal

from libs.common.config import get_settings
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import AIGCResult, DimensionScore, EvidenceRef, InterviewContext, InterviewScore, QATurn
from services.probe_service.service import DETAIL_MARKERS, assess_credibility, has_concrete_content

# 一句包含指标/方法的中文技术回答约 40 字即有实质，远低于啰嗦套话。
# 因此实质判定以「可信度信号 + 信息密度」为主，长度只做下限闸门，不线性惩罚简洁。
SUBSTANCE_FULL_ANSWER_CHARS = 45
SUBSTANCE_DETAIL_BONUS_CHARS = 15  # 每个细节标记（指标、因果、故障…）等效增加的「实质字符」credit
SUBSTANCE_AIGC_FLAGGED_FACTOR = 0.2  # 被判定疑似 AI/背稿的回答，内容非本人产出，实质分大幅折损
SUBSTANCE_SCORE_FLOOR = 15.0
SUBSTANCE_RISK_THRESHOLD = 0.35
CREDIBILITY_SUBSTANCE_FACTORS = {"solid": 1.0, "vague": 0.55, "suspicious": 0.25}


def _answer_substance_factor(
    ctx: InterviewContext,
    aigc_results: list[AIGCResult] | None = None,
) -> float:
    """回答实质程度 0..1。

    设计原则：
    - 主信号是可信度等级（solid/vague/suspicious），反映回答里是否有可验证细节；
    - 长度只做「下限闸门」——纯寒暄/一句话趋近 0，但简洁而信息密的专家回答不被长度拖累，
      细节标记（指标、因果、故障、取舍…）按 SUBSTANCE_DETAIL_BONUS_CHARS 折算成等效字符；
    - 被 AIGC 判定疑似 AI 生成/背稿、且通篇无具体内容（无数字/技术名词/细节）的回答，
      内容非本人产出，实质分按 0.2 重度折损，使作弊空话即便又长又顺也拿不到高分；
    - 被标记但仍含具体内容的回答可能是误报（候选人确实讲了细节），不做实质封杀，
      仅由确定性 risk_penalty 温和扣分，避免冤杀真专家。
    """
    if not ctx.turns:
        return 0.0
    flagged_turn_ids = {item.turn_id for item in (aigc_results or []) if item.flagged}
    factors: list[float] = []
    for turn in ctx.turns:
        answer = turn.answer.strip()
        level_factor = CREDIBILITY_SUBSTANCE_FACTORS[assess_credibility(answer).level]
        detail_hits = sum(marker in answer.lower() for marker in DETAIL_MARKERS)
        effective_len = len(answer) + detail_hits * SUBSTANCE_DETAIL_BONUS_CHARS
        length_factor = min(1.0, effective_len / SUBSTANCE_FULL_ANSWER_CHARS)
        turn_factor = level_factor * length_factor
        if turn.turn_id in flagged_turn_ids and not has_concrete_content(answer):
            turn_factor *= SUBSTANCE_AIGC_FLAGGED_FACTOR
        factors.append(turn_factor)
    return round(sum(factors) / len(factors), 4)


def _substance_cap(
    ctx: InterviewContext,
    aigc_results: list[AIGCResult] | None = None,
) -> float:
    """所有正权重维度分数的确定性上限，保证垃圾/作弊回答拿不到高分。"""
    factor = _answer_substance_factor(ctx, aigc_results)
    return round(SUBSTANCE_SCORE_FLOOR + (100.0 - SUBSTANCE_SCORE_FLOOR) * factor, 2)


def _evidence_for_dimension(ctx: InterviewContext, dimension: str) -> list[EvidenceRef]:
    keywords = _dimension_keywords(dimension)
    chain_turn_ids = {
        link.answer_turn_id
        for chain in ctx.probe_chains
        for link in chain.links
        if any(keyword in chain.topic for keyword in keywords)
    }
    matched = [
        turn
        for turn in ctx.turns
        if turn.turn_id in chain_turn_ids
        or any(keyword in f"{turn.question} {turn.answer}" for keyword in keywords)
    ]
    auto_selected = False
    if not matched and ctx.turns:
        matched = sorted(ctx.turns, key=lambda item: len(item.answer), reverse=True)[:1]
        auto_selected = True
    refs: list[EvidenceRef] = []
    for turn in matched[:3]:
        excerpt = turn.answer[:120]
        if auto_selected:
            excerpt = f"[自动选取]{excerpt}"
        refs.append(
            EvidenceRef(
                turn_id=turn.turn_id,
                quote_start_ms=turn.answer_start_ms,
                quote_end_ms=turn.answer_end_ms,
                excerpt=excerpt,
            )
        )
    return refs


def _dimension_keywords(dimension: str) -> list[str]:
    mapping = {
        "项目真实性": ["项目", "负责", "主导", "独立", "上线", "指标", "真实性"],
        "注水风险": ["记不清", "团队", "别人", "主要", "差不多", "风险"],
        "沟通与逻辑": ["因为", "所以", "取舍", "复盘", "逻辑"],
    }
    return [dimension, *mapping.get(dimension, [])]


def fallback_score_interview(
    ctx: InterviewContext,
    aigc_results: list[AIGCResult],
) -> InterviewScore:
    _ensure_scoreable_context(ctx)
    _ensure_aigc_coverage(ctx, aigc_results)
    risk_penalty = 0.0
    risk_notes: list[str] = []
    if ctx.flags:
        risk_penalty += 12.0
        risk_notes.extend(flag.description for flag in ctx.flags)
    flagged_aigc = [item for item in aigc_results if item.flagged]
    if flagged_aigc:
        risk_penalty += min(18.0, 6.0 * len(flagged_aigc))
        if all(item.mode == "voice" for item in flagged_aigc):
            risk_notes.append("部分回答疑似背稿或模板化，需要人工复核。")
        else:
            risk_notes.append("部分文字回答疑似模板化或 AI 生成，需要人工复核。")
    settings = get_settings()
    cracked_chains = [chain for chain in ctx.probe_chains if chain.verdict == "cracked"]
    held_up_chains = [chain for chain in ctx.probe_chains if chain.verdict == "held_up"]
    chain_penalty = min(24.0, settings.chain_crack_penalty * len(cracked_chains))
    if cracked_chains:
        for chain in cracked_chains:
            depth = chain.crack_depth or len(chain.links)
            risk_notes.append(f"声明「{chain.topic}」在第 {depth} 层追问露馅。")
    held_up_bonus = min(9.0, settings.chain_held_up_bonus * len(held_up_chains))
    substance_factor = _answer_substance_factor(ctx, aigc_results)
    substance_cap = _substance_cap(ctx, aigc_results)
    if substance_factor < SUBSTANCE_RISK_THRESHOLD:
        risk_notes.append("回答缺乏实质内容（过短或空泛），分数已按内容质量封顶，建议人工复核。")

    dimensions: list[DimensionScore] = []
    for item in ctx.competency_model.items:
        base = 78.0
        if item.name == "项目真实性":
            base -= risk_penalty * 0.7
            base -= chain_penalty
            base += held_up_bonus
        elif item.name == "注水风险":
            base = max(0.0, 100.0 - (risk_penalty + chain_penalty) * 3)
        elif item.name == "沟通与逻辑":
            avg_len = sum(len(turn.answer) for turn in ctx.turns) / max(1, len(ctx.turns))
            base += 5.0 if avg_len > 80 else -8.0
        if item.weight > 0:
            base = min(base, substance_cap)
        dimensions.append(
            DimensionScore(
                dimension=item.name,
                score=round(max(0.0, min(100.0, base)), 2),
                weight=item.weight,
                evidence=_evidence_for_dimension(ctx, item.name),
            )
        )

    total = _compute_total_score(dimensions)
    return InterviewScore(
        session_id=ctx.session_id,
        dimensions=dimensions,
        total_score=total,
        risk_notes=risk_notes,
        recommendation=_recommendation(total),
        analysis_mode="fallback",
    )


def score_interview(ctx: InterviewContext, aigc_results: list[AIGCResult]) -> InterviewScore:
    _ensure_scoreable_context(ctx)
    _ensure_aigc_coverage(ctx, aigc_results)
    fallback = fallback_score_interview(ctx, aigc_results)
    messages = [
        LLMMessage(role="system", content=load_prompt("scoring_system.md")),
        LLMMessage(
            role="user",
            content=_scoring_payload(ctx, aigc_results),
        ),
    ]
    client = get_llm_client()
    if hasattr(client, "complete_json_sync_with_meta"):
        draft, used_fallback = client.complete_json_sync_with_meta(messages, InterviewScore, fallback)
    else:
        draft = client.complete_json_sync(messages, InterviewScore, fallback)
        used_fallback = draft == fallback
    return _normalize_score(ctx, draft, fallback, aigc_results, used_fallback=used_fallback)


def _scoring_payload(ctx: InterviewContext, aigc_results: list[AIGCResult]) -> str:
    payload = {
        "session_id": ctx.session_id,
        "job_id": ctx.job_id,
        "candidate_id": ctx.candidate_id,
        "candidate_resume_text": ctx.candidate_resume_text,
        "competency_model": ctx.competency_model.model_dump(),
        "turns": [turn.model_dump() for turn in ctx.turns],
        "probe_chains": [chain.model_dump() for chain in ctx.probe_chains],
        "consistency_flags": [flag.model_dump() for flag in ctx.flags],
        "aigc_results": [item.model_dump() for item in aigc_results],
        "instructions": (
            "Return JSON matching InterviewScore. Provide one DimensionScore per competency "
            "dimension with evidence referencing existing turn_id values. Python will recompute "
            "total_score from dimension scores and weights."
        ),
    }
    return json.dumps(payload, ensure_ascii=False, default=str)


def _ensure_scoreable_context(ctx: InterviewContext) -> None:
    if not ctx.turns:
        raise ValueError("cannot score interview without candidate turns")


def _ensure_aigc_coverage(ctx: InterviewContext, aigc_results: list[AIGCResult]) -> None:
    turn_ids = [turn.turn_id for turn in ctx.turns]
    expected = set(turn_ids)
    result_ids = [item.turn_id for item in aigc_results]
    duplicates = {turn_id for turn_id in result_ids if result_ids.count(turn_id) > 1}
    if duplicates:
        raise ValueError("AIGC results must not contain duplicate turn_id values")
    unknown = set(result_ids) - expected
    if unknown:
        raise ValueError(f"AIGC result references unknown turn_id: {sorted(unknown)[0]}")
    missing = expected - set(result_ids)
    if missing:
        raise ValueError("AIGC results must cover every transcript turn")


def _normalize_score(
    ctx: InterviewContext,
    draft: InterviewScore,
    fallback: InterviewScore,
    aigc_results: list[AIGCResult] | None = None,
    *,
    used_fallback: bool = False,
) -> InterviewScore:
    turns_by_id = {turn.turn_id: turn for turn in ctx.turns}
    fallback_by_dimension = {dimension.dimension: dimension for dimension in fallback.dimensions}
    deterministic_risk_present = bool(fallback.risk_notes)
    has_cracked_chain = any(chain.verdict == "cracked" for chain in ctx.probe_chains)
    has_held_up_chain = any(chain.verdict == "held_up" for chain in ctx.probe_chains)
    substance_cap = _substance_cap(ctx, aigc_results)
    normalized_dimensions: list[DimensionScore] = []
    for item in ctx.competency_model.items:
        draft_dimension = next(
            (dimension for dimension in draft.dimensions if dimension.dimension == item.name),
            None,
        )
        if draft_dimension is None:
            normalized_dimensions.append(fallback_by_dimension[item.name])
            continue
        evidence = _normalize_evidence_refs(draft_dimension.evidence, turns_by_id)
        if not evidence:
            evidence = fallback_by_dimension[item.name].evidence
        fallback_dimension = fallback_by_dimension[item.name]
        score = _normalize_dimension_score(
            item.name,
            draft_dimension,
            fallback_dimension,
            deterministic_risk_present=deterministic_risk_present,
            has_cracked_chain=has_cracked_chain,
            has_held_up_chain=has_held_up_chain,
        )
        if item.weight > 0:
            score = min(score, substance_cap)
        normalized_dimensions.append(
            DimensionScore(
                dimension=item.name,
                score=score,
                weight=item.weight,
                evidence=evidence,
            )
        )

    total = _compute_total_score(normalized_dimensions)
    return InterviewScore(
        session_id=ctx.session_id,
        dimensions=normalized_dimensions,
        total_score=total,
        risk_notes=_merge_risk_notes(fallback.risk_notes, draft.risk_notes),
        recommendation=_recommendation(total),
        analysis_mode="fallback" if used_fallback else "llm",
    )


def _merge_risk_notes(fallback_notes: list[str], draft_notes: list[str]) -> list[str]:
    merged: list[str] = []
    for note in [*fallback_notes, *draft_notes]:
        clean = note.strip()
        if clean and clean not in merged:
            merged.append(clean)
    return merged


def _normalize_dimension_score(
    dimension_name: str,
    draft_dimension: DimensionScore,
    fallback_dimension: DimensionScore,
    *,
    deterministic_risk_present: bool,
    has_cracked_chain: bool,
    has_held_up_chain: bool,
) -> float:
    score = round(max(0.0, min(100.0, draft_dimension.score)), 2)
    if deterministic_risk_present and dimension_name in {"项目真实性", "注水风险"}:
        score = min(score, fallback_dimension.score)
    elif dimension_name == "项目真实性" and has_cracked_chain:
        score = min(score, fallback_dimension.score)
    elif dimension_name == "项目真实性" and has_held_up_chain:
        score = max(score, fallback_dimension.score)
    return score


def _normalize_evidence_refs(
    refs: list[EvidenceRef],
    turns_by_id: dict[str, QATurn],
) -> list[EvidenceRef]:
    normalized: list[EvidenceRef] = []
    seen: set[tuple[str, int, int, str]] = set()
    for ref in refs:
        turn = turns_by_id.get(ref.turn_id)
        if turn is None or not ref.excerpt.strip():
            continue
        answer = turn.answer
        excerpt = ref.excerpt.strip()
        comparable_excerpt = excerpt.removeprefix("[自动选取]")
        if comparable_excerpt not in answer:
            excerpt = answer[:120]
        answer_start_ms = turn.answer_start_ms
        answer_end_ms = turn.answer_end_ms
        quote_start_ms = max(answer_start_ms, min(ref.quote_start_ms, answer_end_ms))
        quote_end_ms = max(quote_start_ms, min(ref.quote_end_ms, answer_end_ms))
        key = (ref.turn_id, quote_start_ms, quote_end_ms, excerpt)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            EvidenceRef(
                turn_id=ref.turn_id,
                quote_start_ms=quote_start_ms,
                quote_end_ms=quote_end_ms,
                excerpt=excerpt,
            )
        )
    return normalized


def _compute_total_score(dimensions: list[DimensionScore]) -> float:
    positive = [dimension for dimension in dimensions if dimension.weight > 0]
    weight_sum = sum(dimension.weight for dimension in positive) or 1.0
    total = sum(dimension.score * dimension.weight for dimension in positive) / weight_sum
    for dimension in dimensions:
        if dimension.weight < 0:
            total -= (100.0 - dimension.score) * abs(dimension.weight)
    return round(max(0.0, min(100.0, total)), 2)


def _recommendation(total_score: float) -> Literal["strong_yes", "yes", "hold", "no"]:
    if total_score >= 88:
        return "strong_yes"
    if total_score >= 75:
        return "yes"
    if total_score >= 60:
        return "hold"
    return "no"
