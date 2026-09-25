"""端到端真实场景模拟：模拟一场线上会议面试，走完整 ASR→对话装配→评分→报告链路。

模拟内容：面试官提问（speaker=interviewer，对应麦克风）+ 候选人多轮回答
（speaker=candidate，对应扬声器），其中混入一条 gankintview 式作弊回答。
用 audio_chunk 承载 base64 文本（stub ASR 会解码回文本），完整复现真实链路。

验证点：① 转写 speaker 归属正确；② 问答 turn 正确配对；③ 作弊轮被 AIGC 标记；
④ 评分合理；⑤ 报告 PDF 中文字体正确嵌入。

运行：python -m scripts.simulate_interview
"""
from __future__ import annotations

import argparse
import base64
import os
import tempfile


def _build_arg_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="simulate_interview",
        description="端到端模拟一场线上会议面试，验证 ASR 归属、turn 配对、作弊检测、评分与报告。",
    )


if __name__ == "__main__":
    _build_arg_parser().parse_args()

_TMP = tempfile.mkdtemp(prefix="sim_interview_")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TMP}/sim.db")
os.environ.setdefault("REPORT_DIR", f"{_TMP}/reports")
os.environ.setdefault("LLM_PROVIDER", "mock")
os.environ.setdefault("ASR_PROVIDER", "stub")
os.environ.setdefault("OFFLINE_TASK_BACKEND", "local")
os.environ.setdefault("GATEWAY_API_KEY", "")

from fastapi.testclient import TestClient

from libs.common.config import get_settings
from libs.common.events import event_bus
from libs.common.tasks import task_queue
from services.asr_service.service import asr_session_manager
from services.gateway.app import app


# 一场真实面试的双声道对话：(speaker, 文本)。interviewer=麦克风，candidate=扬声器。
SCRIPT: list[tuple[str, str]] = [
    ("interviewer", "请讲一个你最近主导的、有技术挑战的项目。"),
    (
        "candidate",
        "我主导重构了支付对账系统。原来每天凌晨跑全量对账要4小时，经常拖到上班还没跑完。"
        "我改成增量对账加分片并行，把对账窗口从4小时压缩到18分钟，差错自动挂账、人工复核。",
    ),
    ("interviewer", "增量对账怎么保证不漏单？"),
    (
        "candidate",
        "用账务流水的版本号做水位线，每次只拉水位线之后的增量，水位线落库和处理在同一个事务里。"
        "我还额外加了一个T+1的全量兜底校验，发现增量和全量有差异就告警，上线半年差异率是0。",
    ),
    ("interviewer", "说说你对微服务治理的理解。"),
    (
        "candidate",
        "这个问题可以从三个层面来看。首先是服务拆分的合理性，其次是治理体系的完整性，"
        "最后是持续优化的机制。三者协同才能实现质的飞跃和明显改善，最终达成业务目标。",
    ),
]
CHEAT_TURN_INDEX = 2  # 第3轮候选人回答是 gankintview 式套话（0-based 计数候选人回答）


def _audio_event(seq: int, speaker: str, text: str) -> dict:
    return {
        "type": "audio_chunk",
        "seq": seq,
        "audio": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        "speaker": speaker,
        "format": "pcm16",
        "sample_rate_hz": 16000,
        "channels": 1,
        "start_ms": seq * 4000,
        "end_ms": seq * 4000 + 3500,
        "is_final": True,
        "confidence": 0.95,
    }


def _drain_until(ws, expected: str, *, limit: int = 20) -> dict | None:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("type") == expected:
            return msg
    return None


def _reset_runtime() -> None:
    get_settings.cache_clear()
    event_bus.reset()
    asr_session_manager.reset()
    task_queue.reset()


def main() -> None:
    _reset_runtime()
    client = TestClient(app)

    setup = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "负责支付核心后端：对账、清结算、高并发与稳定性治理。",
            "resume_text": "姓名：王工\n独立主导支付对账系统重构，对账耗时下降 90%。",
        },
    ).json()
    interview_id = setup["interview_id"]
    print(f"{'='*72}\n【模拟一场线上会议面试】interview={interview_id}")
    print(f"候选人={setup['candidate_name']}  岗位={setup['job_title']}\n{'-'*72}")

    transcripts: list[dict] = []
    with client.websocket_connect(f"/ws/interview/{interview_id}") as ws:
        _drain_until(ws, "current_question")
        for seq, (speaker, text) in enumerate(SCRIPT, start=1):
            ws.send_json(_audio_event(seq, speaker, text))
            msg = _drain_until(ws, "transcript")
            if msg is not None:
                transcripts.append(msg["payload"])

    report = client.post(f"/api/interviews/{interview_id}/end").json()

    # ---- 验证 ① 转写 speaker 归属 ----
    print("① 转写 speaker 归属（麦克风=面试官 / 扬声器=候选人）：")
    ok_speaker = True
    for (exp_speaker, text), seg in zip(SCRIPT, transcripts):
        got = seg.get("speaker")
        flag = "✓" if got == exp_speaker else "✗"
        if got != exp_speaker:
            ok_speaker = False
        label = {"interviewer": "面试官", "candidate": "候选人"}.get(got, got)
        print(f"   {flag} [{label}] {text[:28]}…")

    # ---- 验证 ② 问答 turn 配对 ----
    turns = report.get("transcript", [])
    print(f"\n② 问答 turn 配对（共 {len(turns)} 轮）：")
    for turn in turns:
        print(f"   Q: {turn['question'][:30]}…")
        print(f"   A: {turn['answer'][:40]}…")

    # ---- 验证 ③ AIGC 作弊检测 ----
    aigc = report.get("aigc_results", [])
    flagged = [item for item in aigc if item.get("flagged")]
    print(f"\n③ AIGC 作弊检测：{len(aigc)} 轮中 {len(flagged)} 轮被标记")
    for item in aigc:
        mark = "🚩" if item.get("flagged") else "  "
        reason = item.get("llm_reason") or ""
        print(f"   {mark} prob={item.get('ai_generated_prob'):.2f} {reason[:40]}")

    # ---- 验证 ④ 评分 ----
    score = report.get("score", {})
    print(f"\n④ 评分：总分 {score.get('total_score')}  推荐 {score.get('recommendation')}  "
          f"模式 {score.get('analysis_mode')}")
    for note in score.get("risk_notes", [])[:4]:
        print(f"   - {note}")

    # ---- 验证 ⑤ 报告 PDF 中文字体 ----
    pdf_path = report.get("pdf_path")
    print(f"\n⑤ 报告产物：{pdf_path}")
    try:
        from pypdf import PdfReader

        fonts = [
            str(v.get_object().get("/BaseFont"))
            for v in PdfReader(pdf_path).pages[0].get("/Resources", {}).get("/Font", {}).values()
        ]
        cjk_ok = any("ReportCJK" in f for f in fonts)
        print(f"   嵌入字体={fonts} {'✓ 中文字体正确' if cjk_ok else '✗ 中文字体异常'}")
    except Exception as exc:  # noqa: BLE001
        print(f"   PDF 字体检查失败：{exc}")

    print(f"\n{'='*72}\n小结：speaker 归属 {'✓' if ok_speaker else '✗'} · "
          f"turn {len(turns)} 轮 · AIGC 标记 {len(flagged)} 轮 · "
          f"总分 {score.get('total_score')}/{score.get('recommendation')}")


if __name__ == "__main__":
    main()
