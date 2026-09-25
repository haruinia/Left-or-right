from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
from urllib.parse import quote

from jinja2 import Template

from libs.common.config import get_settings
from libs.common.observability import log_event
from libs.common.storage import get_artifact_store
from libs.common.textsim import normalize_text
from libs.schemas import (
    AIGCResult,
    ConsistencyFlag,
    InterviewContext,
    InterviewScore,
    MemoryReviewItem,
    QuestionAdoptionStats,
    Report,
)


TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "report.html.j2"
REPORT_TEMPLATE = Template(TEMPLATE_PATH.read_text(encoding="utf-8"))

RECOMMENDATION_LABELS = {
    "strong_yes": "强烈推荐",
    "yes": "推荐",
    "hold": "待定",
    "no": "不推荐",
}
RECOMMENDATION_TONES = {
    "strong_yes": "green",
    "yes": "green",
    "hold": "amber",
    "no": "red",
}
ANALYSIS_MODE_LABELS = {"llm": "大模型 + 规则校验", "fallback": "确定性规则兜底"}
SPEAKER_LABELS = {"interviewer": "面试官", "candidate": "候选人", "unknown": "未知"}
QUESTION_SOURCE_LABELS = {"interviewer": "面试官提问", "ai_probe": "AI 追问"}
CHAIN_ORIGIN_LABELS = {
    "resume_claim": "简历声明",
    "answer_claim": "回答声明",
    "competency_gap": "覆盖缺口",
}
CHAIN_VERDICT_LABELS = {
    "cracked": "追问露馅",
    "held_up": "经受住追问",
    "unresolved": "未定",
}
CHAIN_VERDICT_TONES = {"cracked": "red", "held_up": "green", "unresolved": "gray"}
CREDIBILITY_LABELS = {"solid": "可信", "vague": "含糊", "suspicious": "可疑"}
AIGC_MODE_LABELS = {"voice": "语音", "text": "文字"}
STEERING_LABELS = {
    "balanced": "均衡",
    "resume_drill": "深挖简历",
    "jd_professional": "JD 专业题",
}


def _candidate_display_name(ctx: InterviewContext) -> str:
    return ctx.candidate_name.strip() or "候选人"


def _pass_verdict(score: InterviewScore) -> str:
    return "合格" if score.recommendation in {"strong_yes", "yes"} else "不合格"


def _safe_filename_text(value: str) -> str:
    return "".join(
        char if char.isalnum() or "一" <= char <= "鿿" or char in ".-" else "-" for char in value
    ).strip("-")


def _pdf_filename(ctx: InterviewContext, score: InterviewScore) -> str:
    """PDF 命名规则：合格/不合格 + 姓名 + 分数。"""
    name = _safe_filename_text(_candidate_display_name(ctx)) or "候选人"
    return f"{_pass_verdict(score)}-{name}-{score.total_score}.pdf"


def _report_number(ctx: InterviewContext) -> str:
    return f"{ctx.interview_seq:03d}" if ctx.interview_seq > 0 else ctx.session_id[:8]


def _report_basename(ctx: InterviewContext) -> str:
    """报告产物命名原则：面试序号 + 面试者姓名（旧数据无序号/姓名时退回 session_id）。"""
    name = ctx.candidate_name.strip()
    if ctx.interview_seq > 0 and name:
        safe_name = "".join(
            char if char.isalnum() or "一" <= char <= "鿿" else "-" for char in name
        ).strip("-")
        if safe_name:
            return f"{ctx.interview_seq:03d}-{safe_name}"
    return ctx.session_id


def _strengths(score: InterviewScore) -> list[str]:
    strengths: list[str] = []
    for dimension in score.dimensions:
        if dimension.score < 75 or not dimension.evidence:
            continue
        excerpt = dimension.evidence[0].excerpt
        strengths.append(f"{dimension.dimension} 得分 {dimension.score}：{excerpt}")
    return strengths[:3]


def _radar_chart_uri(score: InterviewScore) -> str:
    if not score.dimensions:
        return ""

    with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np

        labels = [f"D{index}" for index, _ in enumerate(score.dimensions, start=1)]
        values = [dimension.score for dimension in score.dimensions]
        angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False).tolist()
        values += values[:1]
        angles += angles[:1]

        fig = plt.figure(figsize=(4.8, 4.2), dpi=150)
        ax = fig.add_subplot(111, polar=True)
        ax.plot(angles, values, color="#2563eb", linewidth=2)
        ax.fill(angles, values, color="#60a5fa", alpha=0.25)
        ax.set_ylim(0, 100)
        ax.set_xticks(angles[:-1])
        ax.set_xticklabels(labels)
        ax.set_yticks([20, 40, 60, 80, 100])
        ax.grid(color="#cbd5e1", linewidth=0.8)
        fig.tight_layout()

        image = BytesIO()
        fig.savefig(image, format="png", bbox_inches="tight", transparent=False)
        plt.close(fig)

    encoded = base64.b64encode(image.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _risk_highlights(score: InterviewScore, flags: list[ConsistencyFlag]) -> list[str]:
    highlights: list[str] = []
    for note in [*score.risk_notes, *(flag.description for flag in flags)]:
        clean = note.strip()
        if clean and clean not in highlights:
            highlights.append(clean)
    return highlights


def _ordered_utterances(ctx: InterviewContext):
    return sorted(
        ctx.utterances,
        key=lambda item: (item.start_ms, item.end_ms, item.utterance_id),
    )


def _probe_chain_rows(ctx: InterviewContext) -> list[dict]:
    turns_by_id = {turn.turn_id: turn for turn in ctx.turns}
    rows: list[dict] = []
    for chain in ctx.probe_chains:
        payload = chain.model_dump()
        payload["origin_label"] = CHAIN_ORIGIN_LABELS.get(chain.origin, chain.origin)
        payload["verdict_label"] = CHAIN_VERDICT_LABELS.get(chain.verdict, chain.verdict)
        payload["verdict_tone"] = CHAIN_VERDICT_TONES.get(chain.verdict, "gray")
        payload["links"] = [
            {
                **link.model_dump(),
                "credibility_label": CREDIBILITY_LABELS.get(
                    link.credibility_after, link.credibility_after
                ),
                "answer_excerpt": turns_by_id.get(link.answer_turn_id).answer[:160]
                if link.answer_turn_id in turns_by_id
                else "（未找到关联回答）",
            }
            for link in chain.links
        ]
        rows.append(payload)
    return rows


def _memory_review(ctx: InterviewContext) -> list[MemoryReviewItem]:
    """Line each answer up against recalled memory, one row per turn that hit something.

    The verdict comes from the probe chain that covers the turn: a cracked chain means
    the claim did not survive drilling, a held-up chain means it did. Anything else is
    left as `unverified` — a memory hit alone is a lead, not a conclusion.
    """
    from services.memory_service.service import recall_memories

    verdict_by_turn = _chain_verdict_by_turn(ctx)
    items: list[MemoryReviewItem] = []
    for turn in ctx.turns:
        query = f"{turn.question} {turn.answer}".strip()
        try:
            hits = recall_memories(query, limit=1, exclude_interview_id=ctx.session_id)
        except Exception:
            return items
        if not hits:
            continue
        hit = hits[0]
        verdict = verdict_by_turn.get(turn.turn_id, "unverified")
        items.append(
            MemoryReviewItem(
                turn_id=turn.turn_id,
                memory_subject=hit.subject,
                verdict=verdict,
                note=f"命中记忆（相似度 {hit.score:.2f}，来源 {hit.origin or '未知'}）：{hit.summary}",
            )
        )
    return items


def _chain_verdict_by_turn(ctx: InterviewContext) -> dict[str, str]:
    verdicts: dict[str, str] = {}
    for chain in ctx.probe_chains:
        if chain.verdict == "cracked":
            verdict = "conflicted"
        elif chain.verdict == "held_up":
            verdict = "supported"
        else:
            verdict = "unverified"
        for link in chain.links:
            verdicts[link.answer_turn_id] = verdict
    return verdicts


def _aigc_rows(aigc: list[AIGCResult]) -> list[dict]:
    return [
        {
            **item.model_dump(),
            "mode_label": AIGC_MODE_LABELS.get(item.mode, item.mode),
        }
        for item in aigc
    ]


def _question_adoption_stats(ctx: InterviewContext) -> QuestionAdoptionStats:
    suggested_keys = list(dict.fromkeys(ctx.suggested_question_keys))
    for turn in ctx.turns:
        if turn.question_origin != "system_suggested":
            continue
        key = turn.asked_option_id or normalize_text(turn.question)
        if key and key not in suggested_keys:
            suggested_keys.append(key)
    adopted_count = sum(1 for turn in ctx.turns if turn.question_origin == "system_suggested")
    custom_count = sum(1 for turn in ctx.turns if turn.question_origin == "interviewer_custom")
    asked_count = adopted_count + custom_count
    adoption_rate = adopted_count / asked_count if asked_count else 0.0
    return QuestionAdoptionStats(
        suggested_unique_count=len(suggested_keys),
        adopted_suggested_count=adopted_count,
        custom_question_count=custom_count,
        adoption_rate=round(adoption_rate, 4),
        steering_focus=ctx.question_steering,
        steering_history=ctx.steering_history,
    )


# 中文字体文件候选（按优先级）。WeasyPrint 对 macOS 的 PingFang（可变字体）子集化会损坏字形，
# 故显式绑定到「能被正确子集化」的字体文件，绕过 fontconfig 对 CJK 的默认 fallback。
_CJK_FONT_CANDIDATES = (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",                # macOS 首选
    "/System/Library/Fonts/STHeiti Medium.ttc",                  # macOS 兜底
    "/System/Library/Fonts/Supplemental/Songti.ttc",             # macOS 兜底
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",    # Debian/Ubuntu fonts-noto-cjk
    "/usr/share/fonts/opentype/noto/NotoSansCJK-VF.otf.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",         # 其他发行版
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
)


def _resolve_cjk_font_uri() -> str:
    """探测本机可用的中文字体文件，返回 file:// URI 供模板 @font-face 直接绑定。

    找不到时返回空串：模板会退回 fontconfig 默认匹配（Linux 容器装了 Noto 即可正常，
    macOS 则可能回退到子集化有缺陷的 PingFang，但至少英文与版式正常）。
    """
    env_override = os.environ.get("REPORT_CJK_FONT_PATH", "").strip()
    candidates = (env_override, *_CJK_FONT_CANDIDATES) if env_override else _CJK_FONT_CANDIDATES
    for path in candidates:
        if path and Path(path).is_file():
            return "file://" + quote(path)
    return ""


# 浏览器引擎候选路径：优先用 Chrome/Chromium 无头模式渲染 PDF，效果与网页所见完全一致。
_CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
)


def _find_chrome_binary() -> str | None:
    override = os.environ.get("CHROME_BIN", "").strip()
    if override and Path(override).exists():
        return override
    for path in _CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _render_pdf_with_chrome(html_path: Path, pdf_path: Path) -> bool:
    """用 Chrome/Chromium 无头模式把 HTML 原样渲染成 PDF（与浏览器所见一致，最美观）。

    成功返回 True；找不到浏览器或渲染失败返回 False，由调用方回退到 WeasyPrint。
    用独立临时 profile 避免与用户正在运行的 Chrome 冲突。
    """
    chrome = _find_chrome_binary()
    if chrome is None:
        return False
    try:
        with tempfile.TemporaryDirectory(prefix="chrome_pdf_") as workdir:
            # Chrome 的 --print-to-pdf 写含中文（如「水货杀手」）的目标路径会失败，
            # 故先渲染到纯 ASCII 的临时目录，再用 Python 移动到目标路径。
            # 不用 check=True：headless Chrome 即便渲染成功也常因 GPU/沙箱警告返回非 0 退出码，
            # 以「是否产出有效 PDF 文件」判定成功。
            tmp_pdf = Path(workdir) / "report.pdf"
            subprocess.run(
                [
                    chrome,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-sandbox",
                    f"--user-data-dir={workdir}/profile",
                    "--no-pdf-header-footer",
                    f"--print-to-pdf={tmp_pdf}",
                    html_path.resolve().as_uri(),
                ],
                timeout=60,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if tmp_pdf.exists() and tmp_pdf.stat().st_size > 1024:
                shutil.move(str(tmp_pdf), str(pdf_path))
                return True
    except (subprocess.SubprocessError, OSError):
        return False
    return False


def _ensure_weasyprint_lib_path() -> None:
    """macOS 下让 WeasyPrint 找到 Homebrew 安装的 Pango/GObject/Cairo 等原生库。

    Homebrew 把库装在 /opt/homebrew/lib（Apple Silicon）或 /usr/local/lib（Intel），
    但 Python 的 dlopen 默认不搜索这些目录。在 import weasyprint 触发 dlopen 之前，
    把存在的目录补进 DYLD_FALLBACK_LIBRARY_PATH，使本地开发也能渲染完整版式 PDF。
    """
    if sys.platform != "darwin":
        return
    existing = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "")
    parts = [segment for segment in existing.split(":") if segment]
    changed = False
    for candidate in ("/opt/homebrew/lib", "/usr/local/lib"):
        if os.path.isdir(candidate) and candidate not in parts:
            parts.append(candidate)
            changed = True
    if changed:
        os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = ":".join(parts)


def _write_pdf(
    html: str, pdf_path: Path, fallback_lines: list[str], base_url: str, html_path: Path
) -> None:
    # 可选浏览器引擎渲染（与网页所见完全一致，最美观）：设 REPORT_PDF_ENGINE=chrome 启用。
    # 默认关闭——macOS 上 headless Chrome 经 Python 子进程调用会 hang（无 GUI session 时
    # 等待 mach port 不退出），仅在确认可用的环境（如装了 Chrome 的 Linux 容器）显式开启。
    if os.environ.get("REPORT_PDF_ENGINE", "").strip() == "chrome" and _render_pdf_with_chrome(
        html_path, pdf_path
    ):
        return
    # 次选 WeasyPrint：用内存 html + 显式 base_url（正确编码含中文路径），才能 fetch @font-face
    # 的 file:// 中文字体；否则会回退到系统默认 CJK 字体（macOS 的 PingFang 子集化会损坏字形）。
    _ensure_weasyprint_lib_path()
    try:
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            from weasyprint import HTML

            HTML(string=html, base_url=base_url).write_pdf(pdf_path)
        return
    except Exception as exc:
        # 最终兜底：缺浏览器又缺 WeasyPrint 原生栈时，输出可审计的文本 PDF，并记录可见告警。
        log_event(
            "report.pdf.rich_render_unavailable",
            error=f"{type(exc).__name__}: {exc}"[:200],
            hint="安装 Chrome/Chromium，或 macOS 执行 `brew install pango gdk-pixbuf libffi`",
        )
        _write_text_fallback_pdf(fallback_lines, pdf_path)


def _write_text_fallback_pdf(lines: list[str], pdf_path: Path) -> None:
    wrapped_lines: list[str] = []
    for line in lines:
        wrapped_lines.extend(_wrap_pdf_text(line, width=92))
    wrapped_lines = wrapped_lines[:42]
    commands = ["BT", "/F1 10 Tf", "72 740 Td", "14 TL"]
    for index, line in enumerate(wrapped_lines):
        if index:
            commands.append("T*")
        commands.append(f"{_pdf_font_for_line(line)} 10 Tf")
        commands.append(f"{_pdf_text_operand(line)} Tj")
    commands.append("ET")
    stream = "\n".join(commands)
    stream_bytes = stream.encode("latin-1")
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        (
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >> endobj"
        ),
        "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
        f"5 0 obj << /Length {len(stream_bytes)} >> stream\n{stream}\nendstream endobj",
        (
            "6 0 obj << /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
            "/Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >> endobj"
        ),
        (
            "7 0 obj << /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> "
            "/FontDescriptor 8 0 R >> endobj"
        ),
        (
            "8 0 obj << /Type /FontDescriptor /FontName /STSong-Light /Flags 4 "
            "/FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 "
            "/CapHeight 880 /StemV 80 >> endobj"
        ),
    ]
    content = "%PDF-1.4\n"
    offsets = [0]
    for obj in objects:
        offsets.append(len(content.encode("latin-1")))
        content += obj + "\n"
    xref_pos = len(content.encode("latin-1"))
    content += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for offset in offsets[1:]:
        content += f"{offset:010d} 00000 n \n"
    content += (
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    )
    pdf_path.write_bytes(content.encode("latin-1"))


def _pdf_font_for_line(value: str) -> str:
    return "/F2" if any(ord(char) > 126 for char in value) else "/F1"


def _pdf_text_operand(value: str) -> str:
    if any(ord(char) > 126 for char in value):
        return f"<{value.encode('utf-16-be').hex().upper()}>"
    return f"({_pdf_escape(value)})"


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _wrap_pdf_text(value: str, *, width: int) -> list[str]:
    if len(value) <= width:
        return [value]
    lines: list[str] = []
    remaining = value
    while len(remaining) > width:
        split_at = remaining.rfind(" ", 0, width)
        if split_at <= 0:
            split_at = width
        lines.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip()
    if remaining:
        lines.append(remaining)
    return lines


def _write_report_json(report: Report, json_path: Path) -> None:
    json_path.write_text(
        json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_report(ctx: InterviewContext, score: InterviewScore, aigc: list[AIGCResult]) -> tuple[Report, str]:
    _validate_report_inputs(ctx, score, aigc)
    ordered_utterances = _ordered_utterances(ctx)
    question_adoption = _question_adoption_stats(ctx)
    memory_review = _memory_review(ctx)
    recommendation_label = RECOMMENDATION_LABELS.get(score.recommendation, score.recommendation)
    candidate_name = _candidate_display_name(ctx)
    summary = (
        f"候选人{candidate_name}在本场面试中获得 {score.total_score} 分，"
        f"系统建议为「{recommendation_label}」。"
        "报告中的每项评分均绑定原始回答证据，注水风险需由面试官结合上下文复核。"
    )
    aigc_flagged_count = sum(1 for item in aigc if item.flagged)
    aigc_llm_reviewed = any(item.llm_reason for item in aigc)
    html = REPORT_TEMPLATE.render(
        interview_id=ctx.session_id,
        candidate_name=candidate_name,
        pass_verdict=_pass_verdict(score),
        aigc_flagged_count=aigc_flagged_count,
        aigc_total=len(aigc),
        aigc_llm_reviewed=aigc_llm_reviewed,
        report_number=_report_number(ctx),
        job_title=ctx.competency_model.job_title,
        interview_date=(ctx.ended_at or ctx.started_at).strftime("%Y-%m-%d"),
        score=score,
        analysis_mode=score.analysis_mode,
        analysis_mode_label=ANALYSIS_MODE_LABELS.get(score.analysis_mode, score.analysis_mode),
        recommendation_label=recommendation_label,
        recommendation_tone=RECOMMENDATION_TONES.get(score.recommendation, "gray"),
        summary=summary,
        strengths=_strengths(score),
        aigc_rows=_aigc_rows(aigc),
        risk_highlights=_risk_highlights(score, ctx.flags),
        probe_chains=_probe_chain_rows(ctx),
        transcript=ctx.turns,
        utterances=ordered_utterances,
        candidate_resume_text=ctx.candidate_resume_text,
        question_adoption=question_adoption,
        memory_review=memory_review,
        steering_label=STEERING_LABELS.get(
            question_adoption.steering_focus, question_adoption.steering_focus
        ),
        speaker_labels=SPEAKER_LABELS,
        question_source_labels=QUESTION_SOURCE_LABELS,
        radar_chart_uri=_radar_chart_uri(score),
        cjk_font_uri=_resolve_cjk_font_uri(),
    )
    settings = get_settings()
    settings.report_dir.mkdir(parents=True, exist_ok=True)
    basename = _report_basename(ctx)
    pdf_filename = _pdf_filename(ctx, score)
    json_path = Path(settings.report_dir / f"{basename}.report.json")
    html_path = Path(settings.report_dir / f"{basename}.html")
    pdf_path = Path(settings.report_dir / pdf_filename)
    transcript_path = Path(settings.report_dir / f"{basename}.transcript.json")
    html_path.write_text(html, encoding="utf-8")
    transcript_path.write_text(
        json.dumps(
            {
                "qa_turns": [turn.model_dump() for turn in ctx.turns],
                "full_transcript": [utterance.model_dump() for utterance in ordered_utterances],
                "probe_chains": [chain.model_dump() for chain in ctx.probe_chains],
                "question_adoption": question_adoption.model_dump(),
                "memory_review": [item.model_dump() for item in memory_review],
                "analysis_mode": score.analysis_mode,
            },
            ensure_ascii=False,
            default=str,
            indent=2,
        ),
        encoding="utf-8",
    )
    _write_pdf(
        html,
        pdf_path,
        _fallback_pdf_lines(ctx, score, aigc, summary),
        base_url=html_path.parent.resolve().as_uri() + "/",
        html_path=html_path,
    )
    artifact_store = get_artifact_store()
    html_artifact = artifact_store.put_file(
        f"reports/{basename}.html",
        html_path,
        "text/html; charset=utf-8",
    )
    pdf_artifact = artifact_store.put_file(
        f"reports/{pdf_filename}",
        pdf_path,
        "application/pdf",
    )
    transcript_artifact = artifact_store.put_file(
        f"reports/{basename}.transcript.json",
        transcript_path,
        "application/json; charset=utf-8",
    )
    json_artifact_name = f"reports/{basename}.report.json"
    report = Report(
        interview_id=ctx.session_id,
        score=score,
        analysis_mode=score.analysis_mode,
        aigc_results=aigc,
        consistency_flags=ctx.flags,
        transcript=ctx.turns,
        utterances=ordered_utterances,
        probe_chains=ctx.probe_chains,
        candidate_resume_text=ctx.candidate_resume_text,
        question_adoption=question_adoption,
        memory_review=memory_review,
        summary=summary,
        json_path=str(json_path),
        html_path=str(html_path),
        pdf_path=str(pdf_path),
        transcript_path=str(transcript_path),
        artifact_uris={
            "html": html_artifact.uri,
            "pdf": pdf_artifact.uri,
            "transcript": transcript_artifact.uri,
            "json": artifact_store.artifact_uri(json_artifact_name, json_path),
        },
    )
    _write_report_json(report, json_path)
    artifact_store.put_file(
        json_artifact_name,
        json_path,
        "application/json; charset=utf-8",
    )
    return report, html


def _fallback_pdf_lines(
    ctx: InterviewContext,
    score: InterviewScore,
    aigc: list[AIGCResult],
    summary: str,
) -> list[str]:
    lines = [
        "水货杀手 · 面试评估报告",
        f"候选人：{_candidate_display_name(ctx)}（面试序号 {_report_number(ctx)}）",
        f"应聘岗位：{ctx.competency_model.job_title}",
        f"综合得分：{score.total_score}（满分 100）",
        f"录用建议：{RECOMMENDATION_LABELS.get(score.recommendation, score.recommendation)}",
        f"分析方式：{ANALYSIS_MODE_LABELS.get(score.analysis_mode, score.analysis_mode)}",
    ]
    question_adoption = _question_adoption_stats(ctx)
    lines.append(
        "问题采纳统计："
        f"系统建议 {question_adoption.suggested_unique_count} 题，"
        f"采纳 {question_adoption.adopted_suggested_count} 题，"
        f"自定义 {question_adoption.custom_question_count} 题，"
        f"采纳率 {question_adoption.adoption_rate:.1%}"
    )
    if score.analysis_mode == "fallback":
        lines.append(
            "本报告由确定性规则生成（未启用大模型分析），分数仅供链路验证，不可用于招聘决策。"
        )
    lines.extend([f"总评：{summary}", "维度得分："])
    for dimension in score.dimensions:
        evidence = dimension.evidence[0].excerpt if dimension.evidence else ""
        lines.append(
            f"- {dimension.dimension}：{dimension.score} 分（权重 {dimension.weight}），"
            f"证据：「{evidence}」"
        )
    lines.append("风险点：")
    risk_highlights = _risk_highlights(score, ctx.flags)
    if risk_highlights:
        lines.extend(f"- {note}" for note in risk_highlights)
    else:
        lines.append("- 未发现高置信风险点")
    lines.append("背稿与模板化检测：")
    for index, result in enumerate(aigc, start=1):
        lines.append(
            f"- 第 {index} 轮（{AIGC_MODE_LABELS.get(result.mode, result.mode)}）："
            f"背稿分 {result.rehearsal_score}，模板相似度 {result.template_similarity}，"
            f"{'疑似注水/模板化' if result.flagged else '未命中'}"
        )
    lines.append("追问链：")
    if ctx.probe_chains:
        for chain in ctx.probe_chains:
            verdict = CHAIN_VERDICT_LABELS.get(chain.verdict, chain.verdict)
            crack = f"，第 {chain.crack_depth} 层露馅" if chain.crack_depth else ""
            lines.append(f"- {chain.topic}：{verdict}，共 {len(chain.links)} 层{crack}")
    else:
        lines.append("- 暂无追问链")
    lines.append("完整转写：")
    for index, utterance in enumerate(_ordered_utterances(ctx), start=1):
        speaker = SPEAKER_LABELS.get(utterance.speaker, utterance.speaker)
        lines.append(f"- {index}. [{speaker}] {utterance.text}")
    lines.append("问答轮次：")
    for index, turn in enumerate(ctx.turns, start=1):
        source = QUESTION_SOURCE_LABELS.get(turn.question_source, turn.question_source)
        lines.append(f"- 第 {index} 轮（{source}）问：{turn.question} 答：{turn.answer}")
    return lines


def _validate_report_inputs(
    ctx: InterviewContext,
    score: InterviewScore,
    aigc: list[AIGCResult],
) -> None:
    if score.session_id != ctx.session_id:
        raise ValueError("score session_id must match interview context session_id")
    expected_dimension_names = [item.name for item in ctx.competency_model.items]
    actual_dimension_names = [dimension.dimension for dimension in score.dimensions]
    if actual_dimension_names != expected_dimension_names:
        raise ValueError("score dimensions must match competency model items")
    for dimension, item in zip(score.dimensions, ctx.competency_model.items, strict=True):
        if abs(dimension.weight - item.weight) > 1e-9:
            raise ValueError(f"score dimension weight must match competency model: {dimension.dimension}")
    expected_total = _compute_total_score(score)
    if abs(score.total_score - expected_total) > 0.01:
        raise ValueError("score total_score must match dimension scores and weights")
    expected_recommendation = _recommendation(expected_total)
    if score.recommendation != expected_recommendation:
        raise ValueError("score recommendation must match total_score")
    turns_by_id = {turn.turn_id: turn for turn in ctx.turns}
    if not turns_by_id:
        raise ValueError("report requires at least one transcript turn")
    for flag in ctx.flags:
        if flag.turn_id_a not in turns_by_id:
            raise ValueError(f"consistency flag references unknown turn_id: {flag.turn_id_a}")
        if flag.turn_id_b not in turns_by_id:
            raise ValueError(f"consistency flag references unknown turn_id: {flag.turn_id_b}")
    for dimension in score.dimensions:
        evidence_refs: set[tuple[str, int, int, str]] = set()
        for evidence in dimension.evidence:
            turn = turns_by_id.get(evidence.turn_id)
            if turn is None:
                raise ValueError(f"score evidence references unknown turn_id: {evidence.turn_id}")
            evidence_ref = (
                evidence.turn_id,
                evidence.quote_start_ms,
                evidence.quote_end_ms,
                evidence.excerpt,
            )
            if evidence_ref in evidence_refs:
                raise ValueError(
                    f"score evidence contains duplicate reference: {dimension.dimension}"
                )
            evidence_refs.add(evidence_ref)
            if (
                evidence.quote_start_ms < turn.answer_start_ms
                or evidence.quote_end_ms > turn.answer_end_ms
            ):
                raise ValueError(
                    f"score evidence timestamp is outside turn range: {evidence.turn_id}"
                )
            comparable_excerpt = evidence.excerpt.removeprefix("[自动选取]")
            if comparable_excerpt not in turn.answer:
                raise ValueError(f"score evidence excerpt is not in turn answer: {evidence.turn_id}")
    aigc_turn_ids = [result.turn_id for result in aigc]
    duplicate_aigc_turn_ids = {
        turn_id for turn_id in aigc_turn_ids if aigc_turn_ids.count(turn_id) > 1
    }
    if duplicate_aigc_turn_ids:
        raise ValueError("AIGC results must not contain duplicate turn_id values")
    unknown_aigc_turn_ids = set(aigc_turn_ids) - set(turns_by_id)
    if unknown_aigc_turn_ids:
        raise ValueError(f"AIGC result references unknown turn_id: {sorted(unknown_aigc_turn_ids)[0]}")
    missing_aigc_turn_ids = set(turns_by_id) - set(aigc_turn_ids)
    if missing_aigc_turn_ids:
        raise ValueError("AIGC results must cover every transcript turn")
    settings = get_settings()
    for result in aigc:
        if not result.flagged and (
            result.ai_generated_prob >= settings.aigc_ai_prob_threshold
            or result.template_similarity >= settings.aigc_template_similarity_threshold
        ):
            raise ValueError("AIGC result flagged must be true when thresholds are exceeded")


def _compute_total_score(score: InterviewScore) -> float:
    positive = [dimension for dimension in score.dimensions if dimension.weight > 0]
    weight_sum = sum(dimension.weight for dimension in positive) or 1.0
    total = sum(dimension.score * dimension.weight for dimension in positive) / weight_sum
    for dimension in score.dimensions:
        if dimension.weight < 0:
            total -= (100.0 - dimension.score) * abs(dimension.weight)
    return round(max(0.0, min(100.0, total)), 2)


def _recommendation(total_score: float) -> str:
    if total_score >= 88:
        return "strong_yes"
    if total_score >= 75:
        return "yes"
    if total_score >= 60:
        return "hold"
    return "no"
