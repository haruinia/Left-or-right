"""评分系统校准回归：锁定关键判据，防止重构后再次回归。

核心保证（确定性路径，不依赖真实 LLM）：
1. 简洁但具体的真专家回答必须合格（≥60），不被长度误杀。
2. 垃圾灌水必须低分（<35）。
3. gankintview 式 AI 套话——无论照抄模板还是改写逃逸——必须被 AIGC 标记并低分（<40）。
4. 简历注水经追问露馅必须低分（<45）+ cracked 风险提示。
5. 优秀多轮深答必须高分（≥70）。
6. AIGC 误报保护：被标记但含具体内容的回答不被实质封杀。
"""
from __future__ import annotations

from libs.schemas import (
    ChainLink,
    CompetencyItem,
    CompetencyModel,
    InterviewContext,
    ProbeChain,
    QATurn,
)
from services.aigc_detect_service.service import detect_interview
from services.scoring_service.service import (
    _answer_substance_factor,
    fallback_score_interview,
)


def _competencies() -> CompetencyModel:
    return CompetencyModel(
        job_id="job-cal",
        job_title="后端工程师",
        items=[
            CompetencyItem(name="项目真实性", description="本人贡献真实性", weight=0.4),
            CompetencyItem(name="沟通与逻辑", description="表达推理", weight=0.3),
            CompetencyItem(name="技术深度", description="技术理解", weight=0.3),
            CompetencyItem(name="注水风险", description="夸大风险", weight=-0.2),
        ],
    )


def _turn(question: str, answer: str, start: int) -> QATurn:
    return QATurn(
        question=question,
        answer=answer,
        answer_start_ms=start,
        answer_end_ms=start + max(1000, len(answer) * 200),
    )


def _ctx(turns: list[QATurn], *, chains=None) -> InterviewContext:
    return InterviewContext(
        session_id="sess-cal",
        job_id="job-cal",
        candidate_id="cand-cal",
        competency_model=_competencies(),
        candidate_name="校准候选人",
        turns=turns,
        probe_chains=chains or [],
    )


def _score(ctx: InterviewContext):
    aigc = detect_interview(ctx.turns, probe_chains=ctx.probe_chains)
    return fallback_score_interview(ctx, aigc), aigc


def test_concise_expert_is_not_falsely_penalized() -> None:
    """简洁但含真实指标/技术名词的专家回答必须合格，不被长度因子误杀。"""
    ctx = _ctx(
        [
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
    )
    score, aigc = _score(ctx)
    assert not any(item.flagged for item in aigc), "真专家回答不应被 AIGC 误报"
    assert score.total_score >= 60.0, f"简洁专家被误杀：{score.total_score}"
    assert score.recommendation in {"yes", "strong_yes", "hold"}


def test_garbage_answers_score_low() -> None:
    ctx = _ctx(
        [
            _turn("请做个自我介绍", "你好你好，嗯，就这样。", 0),
            _turn("讲讲你的项目经历", "好的我知道了，这个我也不太清楚。", 5000),
            _turn("你最擅长什么技术？", "都还行吧，差不多。", 10000),
        ]
    )
    score, _ = _score(ctx)
    assert score.total_score < 35.0, f"垃圾回答分数过高：{score.total_score}"
    assert score.recommendation == "no"


def test_gankintview_template_copy_is_flagged_and_low() -> None:
    """照抄常见套话模板的 AI 回答：必须被标记且低分。"""
    ctx = _ctx(
        [
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
        ]
    )
    score, aigc = _score(ctx)
    assert any(item.flagged for item in aigc), "AI 套话未被 AIGC 标记"
    assert score.total_score < 40.0, f"AI 套话分数过高：{score.total_score}"


def test_gankintview_evasive_paraphrase_is_flagged_and_low() -> None:
    """结构化但改写措辞、绕开模板库的 AI 空话：靠元空话检测必须仍被标记并低分。"""
    ctx = _ctx(
        [
            _turn(
                "你在订单系统里做过哪些性能优化？",
                "这个问题可以从三个层面来看。第一层面是接口侧的精简与合并，第二层面是存储侧的读写分离，"
                "第三层面是链路侧的异步解耦。三者协同最终让整体表现得到了质的飞跃和明显改善。",
                0,
            ),
            _turn(
                "为什么不用分布式事务？",
                "技术选型从来都是权衡的艺术。一方面要兼顾性能与成本，另一方面要平衡复杂度与可维护性，"
                "在充分评估投入产出比之后，选择更轻量的方案往往是更为明智且符合工程实践的决策。",
                5000,
            ),
        ]
    )
    score, aigc = _score(ctx)
    assert all(item.flagged for item in aigc), "改写逃逸的 AI 空话未被全部标记"
    assert score.total_score < 40.0, f"改写逃逸的 AI 空话分数过高：{score.total_score}"


def test_resume_drilling_cracked_scores_low_with_risk_note() -> None:
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
        chain_id="chain-cal",
        interview_id="sess-cal",
        topic="QPS从1000提升到5万",
        origin="resume_claim",
        resume_claim_ref="独立把系统QPS从1000提升到5万",
        links=[
            ChainLink(
                probe_question=t2.question,
                probe_target="验证项目真实性",
                answer_turn_id=t2.turn_id,
                credibility_after="vague",
            ),
            ChainLink(
                probe_question=t3.question,
                probe_target="验证项目真实性",
                answer_turn_id=t3.turn_id,
                credibility_after="suspicious",
            ),
        ],
        verdict="cracked",
        crack_depth=2,
    )
    score, _ = _score(_ctx([t1, t2, t3], chains=[chain]))
    assert score.total_score < 45.0, f"注水露馅分数过高：{score.total_score}"
    assert any("露馅" in note for note in score.risk_notes)


def test_excellent_multi_turn_scores_high() -> None:
    ctx = _ctx(
        [
            _turn(
                "讲一个你主导的有挑战的项目",
                "我主导重构了支付对账系统。原来每天凌晨跑全量对账要4小时，经常拖到上班还没跑完。"
                "我改成增量对账+分片并行，把对账窗口从4小时压缩到18分钟，差错自动挂账人工复核。",
                0,
            ),
            _turn(
                "增量对账怎么保证不漏单？",
                "用账务流水的版本号水位线，每次只拉水位线之后的增量，水位线落库和处理在同一事务里。"
                "我额外加了一个T+1的全量兜底校验，发现增量和全量差异就告警。上线半年差异率0。",
                8000,
            ),
            _turn(
                "上线后出过什么问题？",
                "出过一次。分片并行时有个分片线程OOM，因为单个商户当天流水2000万条全load进内存。"
                "我改成流式游标分批拉取，单批1万条，内存从8G降到500M。复盘后加了单分片数据量预检告警。",
                16000,
            ),
        ]
    )
    score, aigc = _score(ctx)
    assert not any(item.flagged for item in aigc)
    assert score.total_score >= 70.0, f"优秀回答分数过低：{score.total_score}"
    assert score.recommendation in {"yes", "strong_yes"}


def test_aigc_false_positive_does_not_annihilate_concrete_answer() -> None:
    """误报保护：被标记但含具体内容（数字/技术名词）的回答，实质分不被重度折损。"""
    concrete = _turn(
        "讲项目",
        "我负责 FastAPI 接口优化，延迟降低 30%。具体做法是把序列化改成 orjson 并加连接池预热，"
        "因为压测发现冷启动是主要瓶颈，我写了基准脚本对比指标口径，排查过一次连接泄漏故障，"
        "复盘后把泄漏检测指标加进了告警面板。",
        0,
    )
    ctx = _ctx([concrete])
    aigc = detect_interview(ctx.turns)
    # 人为强制标记该轮，模拟检测误报
    flagged = [item.model_copy(update={"flagged": True}) for item in aigc]
    factor_flagged = _answer_substance_factor(ctx, flagged)
    factor_clean = _answer_substance_factor(ctx, aigc)
    # 含具体内容 → 即便被标记，实质因子不被 0.2 折损，应与未标记时一致
    assert factor_flagged == factor_clean
    assert factor_flagged > 0.8
