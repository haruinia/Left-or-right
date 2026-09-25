from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from libs.common.prompts import load_prompt
from libs.common.textsim import normalize_text
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import (
    MemoryHit,
    NextOption,
    NextOptions,
    QATurn,
    QuestionBank,
    QuestionBankItem,
)
from services.jd_kb_service.service import get_job
from services.probe_service.service import assess_credibility

SteeringFocus = Literal["balanced", "resume_drill", "jd_professional"]


@dataclass
class QuestionFlowState:
    bank: QuestionBank
    current_question: NextOption | None = None
    last_options: NextOptions | None = None
    steering: SteeringFocus = "balanced"


def initial_question(bank: QuestionBank) -> NextOption | None:
    item = _preferred_bank_item(bank.items)
    if item is None:
        return None
    return _bank_option(item, reason="优先验证简历与岗位要求中最关键的信息。")


def fallback_next_options(
    record,
    bank: QuestionBank,
    after_turn: QATurn,
    *,
    steering: SteeringFocus = "balanced",
) -> NextOptions:
    follow_up = [_follow_up_option(record, after_turn)]
    resume_drill = _resume_claim_follow_up(record)
    if resume_drill is not None:
        follow_up.append(resume_drill)
    alternatives = _alternative_options(record, bank, steering=steering)
    return NextOptions(
        interview_id=bank.interview_id,
        after_turn_id=after_turn.turn_id,
        follow_up=follow_up[:2],
        alternatives=alternatives,
    )


def _resume_claim_follow_up(record) -> NextOption | None:
    chain = next(
        (
            chain
            for chain in record.context.probe_chains
            if chain.origin == "resume_claim" and chain.verdict == "unresolved"
        ),
        None,
    )
    if chain is None:
        return None
    return NextOption(
        kind="follow_up",
        question=(
            f"简历里写到「{chain.topic[:60]}」，请具体说明：这件事里你本人负责哪一段，"
            "数据口径是什么，出过什么问题，怎么验证结果？"
        ),
        reason="简历高风险声明尚未验证，建议对质核实。",
        chain_id=chain.chain_id,
    )


def rebuild_next_options_for_steering(
    record,
    bank: QuestionBank,
    previous: NextOptions,
    steering: SteeringFocus,
) -> NextOptions:
    return NextOptions(
        interview_id=bank.interview_id,
        after_turn_id=previous.after_turn_id,
        follow_up=previous.follow_up,
        alternatives=_alternative_options(record, bank, steering=steering),
    )


async def generate_next_options(
    record,
    bank: QuestionBank,
    after_turn: QATurn,
    fallback: NextOptions,
    memory_hits: list[MemoryHit] | None = None,
) -> NextOptions:
    messages = [
        LLMMessage(role="system", content=load_prompt("next_options.md")),
        LLMMessage(
            role="user",
            content=json.dumps(
                {
                    "interview_id": bank.interview_id,
                    "job_id": record.job_id,
                    "candidate_id": record.candidate_id,
                    "jd_text": _job_jd_text(record.job_id),
                    "resume_text": record.context.candidate_resume_text,
                    "latest_turn": after_turn.model_dump(),
                    "recent_turns": [turn.model_dump() for turn in record.context.turns[-5:]],
                    "probe_chains": [chain.model_dump() for chain in record.context.probe_chains],
                    "steering_focus": record.context.question_steering,
                    "steering_instruction": steering_instruction(record.context.question_steering),
                    "question_bank_unasked": [
                        item.model_dump() for item in bank.items if not item.asked
                    ],
                    "memory_hits": [hit.model_dump() for hit in (memory_hits or [])],
                    "fallback_options": fallback.model_dump(),
                },
                ensure_ascii=False,
            ),
        ),
    ]
    draft = await get_llm_client().complete_json(messages, NextOptions, fallback)
    if draft.interview_id != bank.interview_id or draft.after_turn_id != after_turn.turn_id:
        return fallback
    return draft


def _job_jd_text(job_id: str) -> str:
    try:
        return get_job(job_id).jd_text
    except KeyError:
        return ""


def steering_instruction(focus: SteeringFocus) -> str:
    if focus == "resume_drill":
        return "优先验证简历声明的真实性，逐条下钻。"
    if focus == "jd_professional":
        return "优先考察岗位所需的专业能力与匹配度。"
    return "均衡覆盖各维度。"


def suggested_question_key(option: NextOption) -> str:
    return option.bank_question_id or normalize_text(option.question)


def find_option(flow: QuestionFlowState, option_id: str) -> NextOption | None:
    if flow.current_question is not None and flow.current_question.option_id == option_id:
        return flow.current_question
    if flow.last_options is None:
        return None
    for option in [*flow.last_options.follow_up, *flow.last_options.alternatives]:
        if option.option_id == option_id:
            return option
    return None


def _preferred_bank_item(items: list[QuestionBankItem]) -> QuestionBankItem | None:
    unasked = [item for item in items if not item.asked]
    for item in unasked:
        if item.basis in {"resume", "jd_resume"} and item.category == "project":
            return item
    return unasked[0] if unasked else None


def _unasked_items(bank: QuestionBank) -> list[QuestionBankItem]:
    return [item for item in bank.items if not item.asked]


def _alternative_options(
    record,
    bank: QuestionBank,
    *,
    steering: SteeringFocus,
) -> list[NextOption]:
    items = _filtered_unasked_items(bank, steering)
    if steering == "balanced":
        items = _sort_by_category_gap(record, items)
    alternatives = [_bank_option(item, reason=_alternative_reason(steering)) for item in items[:3]]
    while len(alternatives) < 2:
        alternatives.append(_generated_alternative(record, len(alternatives) + 1, steering))
    return alternatives[:3]


def _filtered_unasked_items(
    bank: QuestionBank,
    steering: SteeringFocus,
) -> list[QuestionBankItem]:
    items = _unasked_items(bank)
    if steering == "resume_drill":
        return [item for item in items if item.basis in {"resume", "jd_resume"}]
    if steering == "jd_professional":
        return [
            item
            for item in items
            if item.basis in {"jd", "jd_resume"} and item.category in {"technical", "job_match"}
        ]
    return items


def _sort_by_category_gap(record, items: list[QuestionBankItem]) -> list[QuestionBankItem]:
    asked_text = " ".join(turn.question for turn in record.context.turns)

    def score(item: QuestionBankItem) -> tuple[int, int]:
        category_seen = item.category in asked_text
        basis_seen = item.basis in asked_text
        return (1 if category_seen else 0, 1 if basis_seen else 0)

    return sorted(items, key=score)


def _alternative_reason(steering: SteeringFocus) -> str:
    if steering == "resume_drill":
        return "当前偏好为深挖简历，优先选择简历依据题。"
    if steering == "jd_professional":
        return "当前偏好为 JD 专业题，优先选择技术与岗位匹配题。"
    return "题库中尚未提问，适合均衡切换话题。"


def _bank_option(item: QuestionBankItem, *, reason: str) -> NextOption:
    return NextOption(
        kind="bank",
        question=item.question,
        reason=reason,
        category=item.category,
        bank_question_id=item.question_id,
    )


def _follow_up_option(record, after_turn: QATurn) -> NextOption:
    credibility = assess_credibility(after_turn.answer)
    chain = record.context.probe_chains[-1] if record.context.probe_chains else None
    if credibility.level in {"suspicious", "vague"}:
        question = (
            "刚才这段回答还比较概括，请讲一个具体例子：你本人负责哪一段，"
            "关键指标是什么，遇到异常时怎么处理？"
        )
    else:
        question = (
            "沿着刚才的回答，请补充一个边界场景：你如何验证方案有效，"
            "失败或效果不达标时怎么复盘？"
        )
    return NextOption(
        kind="follow_up",
        question=question,
        reason=credibility.reason,
        chain_id=chain.chain_id if chain is not None else after_turn.probe_chain_id,
    )


def _generated_alternative(record, index: int, steering: SteeringFocus) -> NextOption:
    competencies = record.context.competency_model.items
    competency = competencies[(index - 1) % len(competencies)].name if competencies else "项目真实性"
    if steering == "resume_drill":
        question = f"围绕简历声明和「{competency}」，请讲一个能证明你个人贡献的具体经历。"
        reason = "当前偏好为深挖简历，题库不足时自动补齐简历核验题。"
    elif steering == "jd_professional":
        question = f"结合这个岗位的「{competency}」要求，请讲一个你能直接胜任的专业案例。"
        reason = "当前偏好为 JD 专业题，题库不足时自动补齐岗位能力题。"
    else:
        question = f"围绕「{competency}」，请讲一个可以验证你个人贡献的具体案例。"
        reason = "题库可用问题不足，自动补齐备选。"
    return NextOption(
        kind="generated",
        question=question,
        reason=reason,
    )
