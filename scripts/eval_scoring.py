"""评分系统实证评估：用多种候选人画像跑确定性评分路径与本地 AIGC 检测，输出真实分数。

运行：python -m scripts.eval_scoring
"""
from __future__ import annotations

import argparse
import os


def _build_arg_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="eval_scoring",
        description="评分系统实证评估：跑多种候选人画像，输出确定性评分与本地 AIGC 检测结果。",
    )


# --help 必须在不触发真实运行（含环境/导入副作用）的前提下打印 usage。
if __name__ == "__main__":
    _build_arg_parser().parse_args()

os.environ.setdefault("LLM_PROVIDER", "mock")
os.environ.setdefault("ASR_PROVIDER", "stub")

from libs.schemas import (
    AIGCResult,
    ChainLink,
    CompetencyItem,
    CompetencyModel,
    ConsistencyFlag,
    InterviewContext,
    ProbeChain,
    QATurn,
)
from services.aigc_detect_service.service import detect_interview
from services.probe_service.service import assess_credibility
from services.scoring_service.service import (
    _answer_substance_factor,
    _substance_cap,
    fallback_score_interview,
)


COMPETENCY = CompetencyModel(
    job_id="job-eval",
    job_title="后端工程师",
    items=[
        CompetencyItem(name="项目真实性", description="本人贡献是否真实可验证", weight=0.4),
        CompetencyItem(name="沟通与逻辑", description="表达与推理是否清晰", weight=0.3),
        CompetencyItem(name="技术深度", description="技术理解与取舍", weight=0.3),
        CompetencyItem(name="注水风险", description="夸大或代写风险（负权重）", weight=-0.2),
    ],
)


def _turn(question: str, answer: str, start: int) -> QATurn:
    return QATurn(
        question=question,
        answer=answer,
        answer_start_ms=start,
        answer_end_ms=start + max(1000, len(answer) * 200),
    )


def _ctx(turns: list[QATurn], *, chains=None, flags=None) -> InterviewContext:
    return InterviewContext(
        session_id="sess-eval",
        job_id="job-eval",
        candidate_id="cand-eval",
        competency_model=COMPETENCY,
        candidate_name="测试候选人",
        turns=turns,
        probe_chains=chains or [],
        flags=flags or [],
    )


# ---- 画像 A：资深专家，回答简洁精确（每条 60~90 字，技术准确，应高分）----
EXPERT_CONCISE = [
    _turn(
        "你在订单系统里做过哪些性能优化？",
        "把下单接口的同步写库改成本地缓存+异步落库，P99从800ms压到120ms，靠Redis预扣库存挡住超卖。",
        0,
    ),
    _turn(
        "异步落库丢消息怎么办？",
        "本地消息表+定时补偿，落库和发MQ在同一事务，消费端幂等去重，对账任务每5分钟扫一次差异。",
        5000,
    ),
    _turn(
        "为什么不用分布式事务？",
        "TCC对下单链路侵入太大、性能折损明显，最终一致够用，所以选本地消息表换吞吐。",
        10000,
    ),
]


# ---- 画像 B：垃圾灌水（应 0~20）----
GARBAGE = [
    _turn("请做个自我介绍", "你好你好，嗯，就这样。", 0),
    _turn("讲讲你的项目经历", "好的我知道了，这个我也不太清楚。", 5000),
    _turn("你最擅长什么技术？", "都还行吧，差不多。", 10000),
]


# ---- 画像 C：gankintview 风格 AI 生成（结构化套话，应被 AIGC 标记 + 低分）----
GANKINTVIEW = [
    _turn(
        "你在订单系统里做过哪些性能优化？",
        "首先我会深入分析业务痛点，其次制定清晰的技术方案，最后推动落地并持续优化，"
        "通过模块化设计降低系统耦合，最终取得显著提升，帮助团队达成业务目标。",
        0,
    ),
    _turn(
        "异步落库丢消息怎么办？",
        "针对这个问题，我认为首先要明确根本原因，其次需要综合考虑性能成本和稳定性，"
        "最后通过持续迭代和数据驱动实现体验和效率的双重提升，保证系统稳定运行。",
        5000,
    ),
    _turn(
        "为什么不用分布式事务？",
        "在技术选型上我会综合考虑性能、成本、稳定性和团队熟悉度，通过合理的架构设计，"
        "让业务逻辑和基础能力解耦，从而提升后续维护效率并降低整体风险。",
        10000,
    ),
]


# ---- 画像 D：简历注水，追问露馅（cracked chain，应低分 + 风险）----
def _drilling_ctx() -> InterviewContext:
    t1 = _turn(
        "简历写你独立把系统QPS从1000提升到5万，怎么做的？",
        "对，这个是我独立负责的，做了很多优化，性能提升非常明显，整体效果很好。",
        0,
    )
    t2 = _turn(
        "具体说说5万QPS下数据库连接池怎么配的？",
        "这个具体数字记不太清了，主要是团队一起弄的，我参与了一部分。",
        5000,
    )
    t3 = _turn(
        "那缓存命中率和热点key怎么处理的？",
        "嗯……这块当时是别人负责的，我不太清楚细节。",
        10000,
    )
    chain = ProbeChain(
        chain_id="chain-drill",
        interview_id="sess-eval",
        topic="QPS从1000提升到5万",
        origin="resume_claim",
        resume_claim_ref="独立把系统QPS从1000提升到5万",
        links=[
            ChainLink(
                probe_question="具体说说5万QPS下数据库连接池怎么配的？",
                probe_target="验证项目真实性",
                answer_turn_id=t2.turn_id,
                credibility_after="vague",
            ),
            ChainLink(
                probe_question="那缓存命中率和热点key怎么处理的？",
                probe_target="验证项目真实性",
                answer_turn_id=t3.turn_id,
                credibility_after="suspicious",
            ),
        ],
        verdict="cracked",
        crack_depth=2,
    )
    return _ctx([t1, t2, t3], chains=[chain])


# ---- 画像 E：优秀多轮，具体数据+故障处理+复盘（应 80~100）----
EXCELLENT = [
    _turn(
        "讲一个你主导的有挑战的项目",
        "我主导重构了支付对账系统。原来每天凌晨跑全量对账要4小时，经常拖到上班还没跑完。"
        "我改成增量对账+分片并行，把对账窗口从4小时压缩到18分钟，差错自动挂账人工复核。",
        0,
    ),
    _turn(
        "增量对账怎么保证不漏单？",
        "用账务流水的版本号水位线，每次只拉水位线之后的增量，水位线落库和处理在同一事务里。"
        "为了防止漏，我额外加了一个T+1的全量兜底校验，发现增量和全量差异就告警。上线半年差异率0。",
        8000,
    ),
    _turn(
        "上线后出过什么问题？",
        "出过一次。分片并行时有个分片线程OOM，因为单个商户当天流水2000万条全load进内存。"
        "我改成流式游标分批拉取，单批1万条，内存从8G降到500M。复盘后我们加了单分片数据量的预检告警。",
        16000,
    ),
    _turn(
        "如果让你重做会怎么改进？",
        "会把对账规则做成可配置的DSL，现在规则硬编码在代码里，每加一种支付方式都要改代码发版。"
        "另外会引入流批一体，把T+1兜底也做成准实时，进一步降低差异发现延迟。",
        24000,
    ),
]


# ---- 画像 F：gankintview 进阶逃逸——结构化套话但措辞独特，不照抄模板库 ----
# 用来检验本地规则检测器的「逃逸缺口」：若本地漏判，只能靠 LLM 审查层兜底。
GANKINTVIEW_EVASIVE = [
    _turn(
        "你在订单系统里做过哪些性能优化？",
        "这个问题可以从三个层面来看。第一层面是接口侧的精简与合并，第二层面是存储侧的读写分离，"
        "第三层面是链路侧的异步解耦。三者协同最终让整体表现得到了质的飞跃和明显改善。",
        0,
    ),
    _turn(
        "异步落库丢消息怎么办？",
        "关于消息可靠性，核心思路无非是确认、重试、补偿三步走。先保证投递确认，再设计幂等重试，"
        "最终辅以对账补偿机制，三管齐下便可在绝大多数场景下确保数据的最终一致与完整。",
        5000,
    ),
    _turn(
        "为什么不用分布式事务？",
        "技术选型从来都是权衡的艺术。一方面要兼顾性能与成本，另一方面要平衡复杂度与可维护性，"
        "在充分评估投入产出比之后，选择更轻量的方案往往是更为明智且符合工程实践的决策。",
        10000,
    ),
]


def _run(name: str, ctx: InterviewContext) -> None:
    aigc = detect_interview(ctx.turns, probe_chains=ctx.probe_chains)
    score = fallback_score_interview(ctx, aigc)
    factor = _answer_substance_factor(ctx, aigc)
    cap = _substance_cap(ctx, aigc)
    print(f"\n{'='*70}\n【{name}】")
    print(f"  实质因子 substance_factor = {factor:.3f}   正权重上限 cap = {cap:.1f}")
    print(f"  总分 = {score.total_score:.1f}   推荐 = {score.recommendation}")
    creds = [assess_credibility(t.answer).level for t in ctx.turns]
    print(f"  逐轮可信度 = {creds}")
    print(f"  逐轮字数 = {[len(t.answer) for t in ctx.turns]}")
    for d in score.dimensions:
        print(f"    {d.dimension:8s} 权重{d.weight:+.1f}  分数 {d.score:.1f}")
    print("  AIGC 检测:")
    for a in aigc:
        flag = "🚩FLAGGED" if a.flagged else "  ok"
        print(
            f"    {flag}  prob={a.ai_generated_prob:.2f} "
            f"tmpl_sim={a.template_similarity:.2f} rehearsal={a.rehearsal_score:.2f}"
        )
    if score.risk_notes:
        print("  风险提示:")
        for note in score.risk_notes:
            print(f"    - {note}")


def main() -> None:
    print("评分系统实证评估（确定性路径：fallback 评分 + 本地 AIGC）")
    print("目标判据：")
    print("  A 资深专家简洁  → 期望 70+，实际看是否被长度/关键词误杀")
    print("  B 垃圾灌水      → 期望 <20")
    print("  C gankintview   → 期望 AIGC 全部 FLAGGED + 低分")
    print("  D 简历注水露馅  → 期望 <40 + cracked 风险")
    print("  E 优秀多轮      → 期望 80+")
    _run("A 资深专家·简洁精确", _ctx(EXPERT_CONCISE))
    _run("B 垃圾灌水", _ctx(GARBAGE))
    _run("C gankintview·AI生成套话", _ctx(GANKINTVIEW))
    _run("D 简历注水·追问露馅", _drilling_ctx())
    _run("E 优秀多轮·数据+故障+复盘", _ctx(EXCELLENT))
    _run("F gankintview进阶·结构化但不照抄模板", _ctx(GANKINTVIEW_EVASIVE))


if __name__ == "__main__":
    main()
