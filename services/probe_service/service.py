from __future__ import annotations

import json
import re

from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import (
    CompetencyModel,
    CredibilitySignal,
    ProbeChain,
    ProbeRequest,
    ProbeResponse,
    ProbeSuggestion,
    QuestionBank,
    QuestionBankItem,
)
from services.jd_kb_service.service import retrieve_job_probe_patterns, retrieve_probe_patterns


VAGUE_MARKERS = ["负责", "参与", "优化", "提升", "很多", "比较", "主要", "一些"]
DETAIL_MARKERS = ["因为", "具体", "我写", "指标", "%", "ms", "qps", "故障", "排查", "取舍"]


def has_concrete_content(answer: str) -> bool:
    """回答是否含可验证的具体内容：阿拉伯数字、英文技术词，或细节标记（指标/因果/故障…）。

    用于区分「简洁但信息密的真专家回答」与「又长又顺的抽象空话」：前者必有数字或技术名词，
    后者通篇都是描述做事姿态的套话。被 AIGC 标记但仍含具体内容的回答可能是误报，应温和处理；
    通篇无具体内容又被标记的，才是高置信度的作弊空谈。
    """
    if any(ch.isdigit() for ch in answer):
        return True
    if re.search(r"[A-Za-z]{2,}", answer):
        return True
    lowered = answer.lower()
    return any(marker in lowered for marker in DETAIL_MARKERS)


def assess_credibility(answer: str) -> CredibilitySignal:
    vague = sum(marker in answer for marker in VAGUE_MARKERS)
    detail = sum(marker in answer.lower() for marker in DETAIL_MARKERS)
    if len(answer.strip()) < 30 or vague >= 3 and detail <= 1:
        return CredibilitySignal(
            level="suspicious",
            reason="回答偏概括，缺少可验证的个人贡献、数据或异常处理细节。",
            drill_down_hint="要求候选人说明自己写了哪部分、关键决策依据和一次真实故障。",
        )
    if vague >= 2 and detail <= 2:
        return CredibilitySignal(
            level="vague",
            reason="回答有一定信息，但关键实现和结果证据仍不充分。",
            drill_down_hint="沿项目细节、指标口径和技术取舍继续下钻。",
        )
    return CredibilitySignal(
        level="solid",
        reason="回答包含较多细节或可验证线索。",
        drill_down_hint="追问边界条件、失败案例和复盘，验证稳定性。",
    )


def fallback_probe(request: ProbeRequest) -> ProbeResponse:
    credibility = assess_credibility(request.latest_answer)
    suggestions: list[ProbeSuggestion] = []
    query = f"{request.latest_answer} {credibility.drill_down_hint}"
    pattern_hits = retrieve_job_probe_patterns(request.job_id, query, limit=3)
    if not pattern_hits:
        pattern_hits = retrieve_probe_patterns(request.competency_model, query, limit=3)
    for index, item in enumerate(request.competency_model.items[:3], start=1):
        hit = next((candidate for candidate in pattern_hits if candidate.competency == item.name), None)
        chain = _chain_for_suggestion(request.probe_chains, index=index, competency=item.name)
        question = (
            hit.pattern
            if hit is not None
            else (
                f"围绕「{item.name}」，请候选人讲一个最近项目中的具体细节："
                "他本人负责哪一段、为什么这样设计、遇到过什么异常以及最后指标如何变化？"
            )
        )
        suggestions.append(
            ProbeSuggestion(
                question=question,
                target="验证项目真实性" if item.name == "项目真实性" else "测试能力深度",
                competency=item.name,
                priority=index,
                chain_id=chain.chain_id if chain is not None else None,
                chain_label=_chain_label(chain) if chain is not None else None,
            )
        )
    return ProbeResponse(suggestions=suggestions, credibility=credibility)


async def generate_probe(request: ProbeRequest) -> ProbeResponse:
    fallback = fallback_probe(request)
    messages = [
        LLMMessage(role="system", content=load_prompt("probe_system.md")),
        LLMMessage(role="user", content=request.model_dump_json()),
    ]
    draft = await get_llm_client().complete_json(messages, ProbeResponse, fallback)
    return _normalize_probe_response(draft, fallback)


async def generate_question_bank(
    interview_id: str,
    jd_text: str,
    resume_text: str,
    competency_model: CompetencyModel,
) -> QuestionBank:
    fallback = fallback_question_bank(interview_id, jd_text, resume_text, competency_model)
    messages = [
        LLMMessage(role="system", content=load_prompt("question_bank.md")),
        LLMMessage(
            role="user",
            content=json.dumps(
                {
                    "interview_id": interview_id,
                    "jd_text": jd_text,
                    "resume_text": resume_text,
                    "competency_model": competency_model.model_dump(),
                    "high_risk_resume_claims": _high_risk_resume_claims(resume_text),
                },
                ensure_ascii=False,
            ),
        ),
    ]
    draft = await get_llm_client().complete_json(messages, QuestionBank, fallback)
    if draft.interview_id != interview_id:
        return fallback
    return draft


def fallback_question_bank(
    interview_id: str,
    jd_text: str,
    resume_text: str,
    competency_model: CompetencyModel,
) -> QuestionBank:
    competencies = [item.name for item in competency_model.items]
    if not competencies:
        competencies = ["项目真实性"]
    items: list[QuestionBankItem] = []
    jd_excerpt = _excerpt(jd_text, fallback="岗位职责")
    resume_excerpt = _excerpt(resume_text, fallback="候选人简历")
    for claim in _high_risk_resume_claims(resume_text):
        items.append(
            _bank_item(
                category="project",
                question=(
                    f"你简历写到「{claim}」，请说明你本人亲自负责哪一段、"
                    "关键决策依据是什么，最终指标如何验证？"
                ),
                basis="resume",
                basis_excerpt=claim,
                competency=_competency_for(competencies, "项目真实性"),
            )
        )
    seed_specs = [
        (
            "technical",
            "结合 JD 里的技术要求，请讲一次你亲手设计或排查的核心技术问题，说明方案取舍和结果指标。",
            "jd",
            jd_excerpt,
            "项目真实性",
        ),
        (
            "technical",
            "如果这个岗位需要你接手现有后端系统，你会先看哪些接口、日志和监控来判断风险？",
            "jd",
            jd_excerpt,
            "沟通与逻辑",
        ),
        (
            "project",
            "请选一个简历中最核心的项目，讲清楚你本人写的模块、上线前验证和线上问题处理。",
            "resume",
            resume_excerpt,
            "项目真实性",
        ),
        (
            "project",
            "你简历里的项目如果去掉团队贡献，只看你个人产出，最能验证能力的是哪一个交付物？",
            "resume",
            resume_excerpt,
            "注水风险",
        ),
        (
            "experience",
            "请按时间线讲一次从需求不清到上线落地的经历，你在哪些节点做了关键判断？",
            "resume",
            resume_excerpt,
            "沟通与逻辑",
        ),
        (
            "experience",
            "过去一次项目推进受阻时，你具体做了什么让团队重新对齐并继续交付？",
            "resume",
            resume_excerpt,
            "沟通与逻辑",
        ),
        (
            "job_match",
            "对照 JD 的核心职责，你认为自己最匹配的一项是什么？请用一个真实项目细节证明。",
            "jd_resume",
            jd_excerpt,
            "项目真实性",
        ),
        (
            "job_match",
            "这个岗位如果要求快速补齐业务知识，你会如何拆解前三周的学习和交付计划？",
            "jd",
            jd_excerpt,
            "沟通与逻辑",
        ),
        (
            "behavior",
            "讲一次你主动暴露风险或承认方案错误的经历，当时你如何处理后续影响？",
            "resume",
            resume_excerpt,
            "注水风险",
        ),
        (
            "behavior",
            "当产品、研发和测试对优先级判断不一致时，你如何推动决策并保证结果可验证？",
            "jd_resume",
            jd_excerpt,
            "沟通与逻辑",
        ),
    ]
    for category, question, basis, basis_excerpt, competency_hint in seed_specs:
        if len(items) >= 18:
            break
        items.append(
            _bank_item(
                category=category,
                question=question,
                basis=basis,
                basis_excerpt=basis_excerpt,
                competency=_competency_for(competencies, competency_hint),
            )
        )
    return QuestionBank(interview_id=interview_id, items=_dedupe_bank_items(items)[:20])


def _bank_item(
    *,
    category: str,
    question: str,
    basis: str,
    basis_excerpt: str,
    competency: str,
) -> QuestionBankItem:
    return QuestionBankItem(
        category=category,  # type: ignore[arg-type]
        question=question,
        basis=basis,  # type: ignore[arg-type]
        basis_excerpt=basis_excerpt[:40] or "依据片段",
        competency=competency,
    )


def _dedupe_bank_items(items: list[QuestionBankItem]) -> list[QuestionBankItem]:
    seen: set[str] = set()
    deduped: list[QuestionBankItem] = []
    for item in items:
        normalized = re.sub(r"\s+", "", item.question.lower())
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(item)
    return deduped


def _excerpt(text: str, *, fallback: str) -> str:
    for raw in re.split(r"[。\n；;]", text):
        clean = raw.strip()
        if clean:
            return clean[:40]
    return fallback


def _competency_for(competencies: list[str], preferred: str) -> str:
    return preferred if preferred in competencies else competencies[0]


def _high_risk_resume_claims(resume_text: str) -> list[str]:
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
            and any(marker in claim for marker in ("独立", "主导"))
            and metric_pattern.search(claim)
        ):
            claims.append(claim[:120])
    return claims[:8]


def _normalize_probe_response(response: ProbeResponse, fallback: ProbeResponse | None = None) -> ProbeResponse:
    suggestions = [
        _merge_fallback_chain_fields(suggestion, fallback, index).model_copy(update={"priority": index})
        for index, suggestion in enumerate(
            sorted(response.suggestions, key=lambda item: item.priority),
            start=1,
        )
    ]
    return ProbeResponse(suggestions=suggestions, credibility=response.credibility)


def _chain_for_suggestion(
    chains: list[ProbeChain],
    *,
    index: int,
    competency: str,
) -> ProbeChain | None:
    if not chains:
        return None
    unresolved = [chain for chain in chains if chain.verdict == "unresolved"]
    candidates = unresolved or chains
    direct_match = next(
        (chain for chain in candidates if competency.lower() in chain.topic.lower()),
        None,
    )
    if direct_match is not None:
        return direct_match
    if competency == "项目真实性":
        resume_chain = next((chain for chain in candidates if chain.origin == "resume_claim"), None)
        if resume_chain is not None:
            return resume_chain
    if index - 1 < len(candidates):
        return candidates[index - 1]
    return candidates[0]


def _chain_label(chain: ProbeChain) -> str:
    origin_label = {
        "resume_claim": "简历核验链",
        "answer_claim": "回答声明链",
        "competency_gap": "能力缺口链",
    }[chain.origin]
    return f"{origin_label} · 第 {len(chain.links) + 1} 层"


def _merge_fallback_chain_fields(
    suggestion: ProbeSuggestion,
    fallback: ProbeResponse | None,
    priority: int,
) -> ProbeSuggestion:
    if suggestion.chain_id and suggestion.chain_label:
        return suggestion
    if fallback is None:
        return suggestion
    fallback_suggestion = next(
        (item for item in fallback.suggestions if item.priority == priority),
        None,
    )
    if fallback_suggestion is None:
        return suggestion
    return suggestion.model_copy(
        update={
            "chain_id": suggestion.chain_id or fallback_suggestion.chain_id,
            "chain_label": suggestion.chain_label or fallback_suggestion.chain_label,
        }
    )
