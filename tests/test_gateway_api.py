from __future__ import annotations

import base64
import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from libs.common.config import get_settings
from libs.common.database import connect, dumps
from libs.common.events import event_bus
from libs.common.observability import metrics_registry, reset_rate_limiters
from libs.common.storage import ArtifactContent
from libs.common.tasks import task_queue
from libs.schemas import ExamSolution, SetupExtraction, TranscriptSegment
from services.asr_service.service import asr_session_manager
from services.gateway.app import app


def _client(
    tmp_path: Path,
    monkeypatch,
    *,
    rate_limit_enabled: bool = False,
    rate_limit_requests_per_minute: int = 120,
    gateway_api_key: str = "",
    signal_enabled: bool = False,
) -> TestClient:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'api.db'}")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("SIGNAL_ENABLED", str(signal_enabled).lower())
    monkeypatch.setenv("RATE_LIMIT_ENABLED", str(rate_limit_enabled).lower())
    monkeypatch.setenv("RATE_LIMIT_REQUESTS_PER_MINUTE", str(rate_limit_requests_per_minute))
    monkeypatch.setenv("GATEWAY_API_KEY", gateway_api_key)
    asr_provider = os.environ.get("ASR_PROVIDER", "stub")
    monkeypatch.setenv("ASR_PROVIDER", asr_provider)
    if asr_provider != "aliyun_nls_ws":
        monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "")
        monkeypatch.setenv("ALIYUN_NLS_TOKEN", "")
        monkeypatch.setenv("ALIYUN_AK_ID", "")
        monkeypatch.setenv("ALIYUN_AK_SECRET", "")
    monkeypatch.setenv("OFFLINE_TASK_BACKEND", "local")
    get_settings.cache_clear()
    event_bus.reset()
    metrics_registry.reset()
    reset_rate_limiters()
    asr_session_manager.reset()
    task_queue.reset()
    return TestClient(app)


def _receive_until(websocket, expected_type: str, *, limit: int = 8) -> tuple[dict, list[dict]]:
    messages: list[dict] = []
    for _ in range(limit):
        message = websocket.receive_json()
        messages.append(message)
        if message.get("type") == expected_type:
            return message, messages
    seen = [message.get("type") for message in messages]
    raise AssertionError(f"expected {expected_type!r} message, saw {seen!r}")


def test_gateway_offline_report_flow(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    job = client.post(
        "/api/jobs",
        json={"title": "AI 后端工程师", "jd_text": "Python FastAPI LLM 可靠性"},
    ).json()
    candidate = client.post(
        "/api/candidates",
        json={"name": "Candidate", "resume_text": "AI backend"},
    ).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    assert interview["context"]["candidate_resume_text"] == "AI backend"
    detail = client.get(f"/api/interviews/{interview['id']}")
    assert detail.status_code == 200
    assert detail.json()["id"] == interview["id"]
    assert detail.json()["context"]["candidate_resume_text"] == "AI backend"
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={
            "question": "讲一个项目",
            "answer": "我主要负责整体架构设计并推动项目落地最终取得显著提升",
            "answer_start_ms": 0,
            "answer_end_ms": 1000,
        },
    )

    report = client.post(f"/api/interviews/{interview['id']}/end").json()
    assert report["score"]["total_score"] > 0
    assert report["candidate_resume_text"] == "AI backend"
    assert client.get(f"/api/interviews/{interview['id']}/report").status_code == 200
    assert client.get(f"/api/interviews/{interview['id']}/report.html").status_code == 200
    report_json = client.get(f"/api/interviews/{interview['id']}/report.json")
    assert report_json.status_code == 200
    assert report_json.headers["content-type"].startswith("application/json")
    assert report_json.json()["interview_id"] == interview["id"]
    assert report_json.json()["artifact_uris"]["json"].startswith("file://")
    transcript = client.get(f"/api/interviews/{interview['id']}/report.transcript.json")
    assert transcript.status_code == 200
    assert transcript.headers["content-type"].startswith("application/json")
    assert transcript.json()["qa_turns"][0]["answer"] == "我主要负责整体架构设计并推动项目落地最终取得显著提升"
    pdf = client.get(f"/api/interviews/{interview['id']}/report.pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")


def test_gateway_document_parse_uploads_resume_text(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/documents/parse?kind=resume&filename=resume.md",
        content="候选人负责 FastAPI 网关和报告生成".encode("utf-8"),
        headers={"content-type": "text/markdown"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["kind"] == "resume"
    assert payload["source"] == "text"
    assert payload["llm_attempted"] is False
    assert "FastAPI" in payload["text"]


def test_gateway_document_parse_returns_clear_pdf_errors(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/documents/parse?kind=resume&filename=resume.pdf",
        content=b"not-a-pdf",
        headers={"content-type": "application/pdf"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "pdf document is invalid or unreadable"}


def test_gateway_document_parse_returns_clear_kind_error(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/documents/parse?kind=other&filename=resume.md",
        content=b"resume",
        headers={"content-type": "text/markdown"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "kind must be jd or resume"}


def test_gateway_quick_setup_extracts_fields_and_creates_interview(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)

    class FakeClient:
        def complete_json_sync_with_meta(self, messages, schema, fallback):
            assert schema is SetupExtraction
            assert "job_title" in messages[0].content
            return SetupExtraction(job_title="高级 AI 后端", candidate_name="张三"), False

    monkeypatch.setattr("services.gateway.app.get_llm_client", lambda: FakeClient())

    response = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "岗位名称：高级 AI 后端。职责：FastAPI 和 LLM 编排。",
            "resume_text": "姓名：张三\n独立主导网关优化，响应时间提升 50%。",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["job_title"] == "高级 AI 后端"
    assert payload["candidate_name"] == "张三"
    assert payload["extraction_confident"] is True
    assert payload["question_bank"]["interview_id"] == payload["interview_id"]
    assert 8 <= len(payload["question_bank"]["items"]) <= 20
    categories = {item["category"] for item in payload["question_bank"]["items"]}
    assert {"technical", "project", "experience", "job_match", "behavior"} <= categories
    assert any(
        item["basis"] == "resume" and "响应时间提升 50%" in item["basis_excerpt"]
        for item in payload["question_bank"]["items"]
    )
    interview = client.get(f"/api/interviews/{payload['interview_id']}").json()
    assert interview["job_id"] == payload["job_id"]
    assert interview["candidate_id"] == payload["candidate_id"]
    assert interview["context"]["candidate_resume_text"].startswith("姓名：张三")
    persisted_bank = client.get(f"/api/interviews/{payload['interview_id']}/question-bank")
    assert persisted_bank.status_code == 200
    assert persisted_bank.json() == payload["question_bank"]


def test_gateway_quick_setup_falls_back_when_extraction_is_unavailable(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "负责后端服务、模型接入和报告链路。",
            "resume_text": "做过 Python 和 FastAPI 项目。",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["job_title"] == "未命名岗位"
    assert payload["candidate_name"] == "候选人"
    assert payload["extraction_confident"] is False
    assert len(payload["question_bank"]["items"]) >= 8


def test_gateway_report_json_falls_back_to_persisted_payload_when_artifact_missing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    report = client.post(f"/api/interviews/{interview['id']}/end").json()
    Path(report["json_path"]).unlink()

    response = client.get(f"/api/interviews/{interview['id']}/report.json")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["content-disposition"] == (
        f'attachment; filename="{interview["id"]}.report.json"'
    )
    assert response.json()["interview_id"] == interview["id"]
    assert response.json()["summary"] == report["summary"]
    assert response.json()["artifact_uris"]["json"] == report["artifact_uris"]["json"]


def test_gateway_report_pdf_returns_404_when_artifact_missing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    report = client.post(f"/api/interviews/{interview['id']}/end").json()
    Path(report["pdf_path"]).unlink()

    missing = client.get(f"/api/interviews/{interview['id']}/report.pdf")

    assert missing.status_code == 404
    assert "report pdf not found" in missing.text


def test_gateway_report_pdf_falls_back_to_artifact_store_when_local_file_missing(
    tmp_path: Path, monkeypatch
) -> None:
    class FakeArtifactStore:
        def get_file(self, uri: str) -> ArtifactContent:
            return ArtifactContent(uri=uri, content=b"%PDF remote", content_type="application/pdf")

    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    report = client.post(f"/api/interviews/{interview['id']}/end").json()
    Path(report["pdf_path"]).unlink()
    report["artifact_uris"]["pdf"] = "s3://reports/reports/demo.pdf"
    with connect() as conn:
        conn.execute(
            "UPDATE reports SET payload = ? WHERE interview_id = ?",
            (dumps(report), interview["id"]),
        )
    monkeypatch.setattr("services.gateway.app.get_artifact_store", lambda: FakeArtifactStore())

    response = client.get(f"/api/interviews/{interview['id']}/report.pdf")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''demo.pdf"
    assert response.content == b"%PDF remote"


def test_gateway_report_transcript_falls_back_to_persisted_payload_when_artifact_missing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    report = client.post(f"/api/interviews/{interview['id']}/end").json()
    Path(report["transcript_path"]).unlink()

    response = client.get(f"/api/interviews/{interview['id']}/report.transcript.json")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["content-disposition"] == (
        f'attachment; filename="{interview["id"]}.transcript.json"'
    )
    payload = response.json()
    assert payload["qa_turns"] == report["transcript"]
    assert payload["full_transcript"] == report["utterances"]


# Every module index.html loads, in graph order. Listed explicitly so a module that
# stops being served fails this test instead of silently dropping its assertions.
_COCKPIT_MODULES = (
    "state",
    "dom",
    "ui",
    "gateway",
    "runtime",
    "documents",
    "panels",
    "session",
    "live",
    "report",
    "mic",
    "app",
)


def _served_cockpit_bundle(client: TestClient, index_html: str) -> str:
    """Concatenate index.html with every asset it references, as a browser would."""
    parts = [index_html]
    for asset in ("/styles.css", *(f"/modules/{name}.js" for name in _COCKPIT_MODULES)):
        served = client.get(asset)
        assert served.status_code == 200, asset
        parts.append(served.text)
    return "\n".join(parts)

def test_gateway_serves_demo_ui(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.get("/cockpit")
    assert response.status_code == 200
    # The cockpit is served as index.html + styles.css + ES modules, so the
    # behavioural assertions below run against everything the page pulls in.
    bundle = _served_cockpit_bundle(client, response.text)
    assert "左右" in bundle
    assert "/api/jobs" in bundle
    assert "创建实时面试" in bundle
    assert "专业追问" in bundle
    assert "/api/interviews/quick-setup" in bundle
    assert "/ws/interview/" in bundle
    assert 'id="currentQuestionText"' in bundle
    assert 'id="nextOptionList"' in bundle
    assert 'id="debugTextPanel"' in bundle
    assert 'data-steering-focus="resume_drill"' in bundle
    assert "current_question" in bundle
    assert "next_options_update" in bundle
    assert "set_steering" in bundle
    assert "debug_text_input_enabled" in bundle
    assert "问题采纳统计" in bundle
    assert 'id="roleLinks"' in bundle
    assert "joinExistingInterviewFromUrl" in bundle
    assert "joinInterviewIdFromUrl" in bundle
    assert "roleFromUrl" in bundle
    assert 'url.searchParams.set("join", state.interview.id)' in bundle
    assert 'url.searchParams.set("role", role)' in bundle
    assert 'fetchGatewayJson(`/api/interviews/${encodeURIComponent(interviewId)}`' in bundle
    assert "selectedProbeChainId" in bundle
    assert "chain_id: state.selectedProbeChainId" in bundle
    assert "asr_warning" in bundle
    assert "开始采集" in bundle
    assert "停止采集" in bundle
    assert "重连通道" in bundle
    assert "刷新状态" in bundle
    assert 'id="runtimeStatus" role="status" aria-live="polite"' in bundle
    assert 'id="modelStatus" role="status" aria-live="polite"' in bundle
    assert 'id="asrStatus" role="status" aria-live="polite"' in bundle
    assert 'aria-label="Gateway Key"' in bundle
    assert 'autocapitalize="off"' in bundle
    assert 'title="刷新本地服务、模型和 ASR 配置状态"' in bundle
    assert 'title="调用真实模型检查连接"' in bundle
    assert 'title="检查 ASR 配置、依赖和 Token"' in bundle
    assert 'title="保存当前浏览器会话使用的 Gateway Key"' in bundle
    assert 'title="填入一组可直接试用的 JD、简历和回答"' in bundle
    assert 'title="打开本地 API 文档"' in bundle
    assert 'title="创建实时面试通道"' in bundle
    assert 'title="清空当前面试状态并重新开始"' in bundle
    assert "maxLiveFeedEvents = 120" in bundle
    assert "trimLiveFeedEvents" in bundle
    assert "setStatusTitleFromMessage" in bundle
    assert "result.message" in bundle
    assert "配置状态读取失败" in bundle
    assert "modelStatusFromConfig" in bundle
    assert "模型模拟模式" in bundle
    assert "模型未配置完整" in bundle
    assert "模型 ${modelName} 已配置" in bundle
    assert "已配置，未测试" in bundle
    assert "本地服务已连接；模型配置已填写但尚未调用真实模型测试" in bundle
    assert "点击“检查模型”后才会确认模型连接" in bundle
    assert "audio_chunk" in bundle
    assert "pcm16" in bundle
    assert "micChunkSamples = Math.floor(micSampleRate / 4)" in bundle
    assert "audioContextConstructor" in bundle
    assert "window.webkitAudioContext" in bundle
    assert "当前浏览器不支持 Web Audio" in bundle
    assert "micStarting" in bundle
    assert "麦克风启动中" in bundle
    assert "正在请求麦克风权限并初始化音频采集" in bundle
    assert "micStartToken" in bundle
    assert "micStartStillCurrent" in bundle
    assert "if (!micStartStillCurrent(micStartToken)) return" in bundle
    assert "麦克风启动已取消" in bundle
    assert "micError" in bundle
    assert "修复后再次点击开始麦克风" in bundle
    assert "discoverGateway" in bundle
    assert "fallbackGatewayOrigins" in bundle
    assert "fetchGatewayJson" in bundle
    assert "wsUrl(`/ws/interview/${interviewId}`)" in bundle
    assert "python scripts/run_gateway.py" in bundle
    assert "http://127.0.0.1:8001" in bundle
    assert "无法连接到本地 gateway" in bundle
    assert "页面正在尝试连接" in bundle
    assert "失败详情" in bundle
    assert "gatewayFailureTitle" in bundle
    assert "setRuntimeStatusFromGateway(status)" in bundle
    assert "function setRuntimeStatusFromGateway(status)" in bundle
    assert "setRuntimeStatusGatewayUnavailable(error)" in bundle
    assert "function setRuntimeStatusGatewayUnavailable(error)" in bundle
    assert bundle.count("state.lastRuntimeCheckAt = Date.now()") == 2
    assert "runtimeStatus.title = gatewayFailureTitle(error)" in bundle
    assert "服务不可达：${errorText(error)}。${gatewayHelpText()}" in bundle
    assert "setDependentStatusWaitingForGateway(error)" in bundle
    assert "function setDependentStatusWaitingForGateway(error)" in bundle
    assert "applyModelStatusFromConfig(config)" in bundle
    assert "applyAsrStatusFromConfig(config)" in bundle
    assert "function dependencyStatusAlreadyVerified(peer)" in bundle
    assert "if (dependencyStatusAlreadyVerified(peer)) return" in bundle
    assert "function refreshPeerDependencyStatusFromConfig(peer)" in bundle
    assert 'await refreshPeerDependencyStatusFromConfig("asr")' in bundle
    assert 'await refreshPeerDependencyStatusFromConfig("model")' in bundle
    assert 'showGatewayKeyRequired("配置刷新", { [peer]: true })' in bundle
    assert "setModelStatusWaitingForGateway(error)" in bundle
    assert "setAsrStatusWaitingForGateway(error)" in bundle
    assert "function gatewayUnavailableEventBody(error)" in bundle
    assert "if (gatewayError) return" in bundle
    assert "模型等待本地服务" in bundle
    assert "ASR 等待本地服务" in bundle
    assert "当前 gateway" in bundle
    assert "runtimeCheckToken" in bundle
    assert "runtimeCheckStillCurrent" in bundle
    assert "modelCheckToken" in bundle
    assert "modelCheckStillCurrent" in bundle
    assert "asrCheckToken" in bundle
    assert "asrCheckStillCurrent" in bundle
    assert "refreshRuntimeIfVisible" in bundle
    assert "window.addEventListener(\"online\", refreshRuntimeIfVisible)" in bundle
    assert "gatewayOriginFromResponse" in bundle
    assert "new URL(response.url).origin" in bundle
    assert "resolvedOrigin" in bundle
    assert "ASR 检查中" in bundle
    assert "ASR 阿里云 NLS 已配置，未测试" in bundle
    assert "ASR 阿里云 NLS 已配置（自动 Token），未测试" in bundle
    assert "ASR 配置已填写但尚未验证依赖、Token 和音频链路" in bundle
    assert "点击“检查 ASR”后才会确认" in bundle
    assert "asrCheckStatusText" in bundle
    assert "ASR 固定 Token 已配置，自动刷新可用" in bundle
    assert "ASR Token 可生成，未跑音频" in bundle
    assert "ASR 固定 Token 已配置" in bundle
    assert "ASR 配置存在，未跑音频" in bundle
    assert "ASR 长时间没有收到有效语音" in bundle
    assert "ASR Token 已失效或被拒绝" in bundle
    assert "ALIYUN_NLS_TOKEN 或阿里云 AccessKey 权限" in bundle
    assert "ALIYUN_ASR_API_KEY 是否是百炼/DashScope API Key" in bundle
    assert "NLS Token 创建失败" in bundle
    assert "ASR WebSocket 依赖缺失" in bundle
    assert "ASR 没有返回识别文本" in bundle
    assert "发送低音量保活" in bundle
    assert "findLoopbackDevice" in bundle
    assert "micDualCapture" in bundle
    assert "blackhole" in bundle
    assert "双声道" in bundle
    assert "原始原因" in bundle
    assert "先创建实时面试" in bundle
    assert "实时通道连接中" in bundle
    assert "通道未连接" in bundle
    assert "等待重连通道" in bundle
    assert "liveChannelUnavailableReason" in bundle
    assert "实时通道未连接，请点击重连通道" in bundle
    assert "WebSocket 已关闭。可点击重连通道继续当前面试。" in bundle
    assert "恢复后点击重连通道继续当前面试" in bundle
    assert "openSocketWithLatestGateway" in bundle
    assert "socketToken" in bundle
    assert "socketStillCurrent" in bundle
    assert "if (!socketStillCurrent(socketToken)) return" in bundle
    assert "连接前无法确认本地 gateway" in bundle
    assert "WebSocket 初始化失败" in bundle
    assert "handleSocketMessage" in bundle
    assert "parseLiveSocketMessage" in bundle
    assert "实时消息不是有效 JSON" in bundle
    assert "validateLiveMessage" in bundle
    assert "实时消息格式异常" in bundle
    assert "实时消息结构异常" in bundle
    assert "未知实时消息类型" in bundle
    assert "formatLiveError" in bundle
    assert "还没有候选人回答，不能生成评分报告" in bundle
    assert "候选人回答不能为空" in bundle
    assert "实时消息序号无效，请重连通道后重试" in bundle
    assert "原始错误" in bundle
    assert 'id="liveStatus" role="status" aria-live="polite"' in bundle
    assert 'id="micStatus" role="status" aria-live="polite"' in bundle
    assert 'class="control-hint" id="controlHint" role="status" aria-live="polite"' in (
        bundle
    )
    assert 'id="liveFeed" role="log" aria-live="polite" aria-relevant="additions text"' in (
        bundle
    )
    assert 'id="sendAnswer" aria-describedby="controlHint"' in bundle
    assert 'id="startMic" aria-describedby="controlHint"' in bundle
    assert 'id="reconnectSocket" aria-describedby="controlHint"' in bundle
    assert 'id="endInterview" aria-describedby="controlHint"' in bundle
    assert "controlHintText" in bundle
    assert "controlHintTone" in bundle
    assert "controlHint.className" in bundle
    assert 'id="questionCharCount" role="status" aria-live="polite"' in bundle
    assert 'id="answerCharCount" role="status" aria-live="polite"' in bundle
    assert "answerMinChars = 20" in bundle
    assert "updateTextCounters" in bundle
    assert "textTurnReady" in bundle
    assert "sendAnswer.disabled = !textReady" in bundle
    assert "manualProbe.disabled = !textReady" in bundle
    assert "当前问题和候选人回答都需要填写" in bundle
    assert "请填写当前问题和候选人回答后发送文字回答" in bundle
    assert "建议至少 ${answerMinChars} 字" in bundle
    assert 'answerText.addEventListener("input", updateTextCounters)' in bundle
    assert ".control-hint.warn" in bundle
    assert "建议用 BlackHole/Loopback 分开你和会议声" in bundle
    assert "实时通道未连接。请点击重连通道" in bundle
    assert "liveChannelReadyForInput" in bundle
    assert "实时通道未连接，请点击重连通道。" in bundle
    assert "sendLiveSocketPayload" in bundle
    assert "发送失败" in bundle
    assert "请点击重连通道后重试" in bundle
    assert "(question ? answerText : currentQuestion).focus();" in bundle
    assert 'answerText.value = ""' in bundle
    assert "answerText.focus();" in bundle
    assert "if (!manual) {" in bundle
    assert "endingInterview" in bundle
    assert "正在结束面试并生成评分报告，请等待结果" in bundle
    assert "requestEndInterview" in bundle
    assert "setPill(liveStatus, \"评分中\", \"live\");" in bundle
    assert "setControls();" in bundle
    assert 'sendLiveSocketPayload({ type: "end" }, "结束面试失败")' in bundle
    assert "state.seq += 1" in bundle
    assert "stopMicCapture({ flush: false })" in bundle
    assert "readErrorMessage" in bundle
    assert "readJsonResponse" in bundle
    assert "接口响应不是有效 JSON" in bundle
    assert "服务健康检查响应不是有效 JSON" in bundle
    assert "资料解析响应不是有效 JSON" in bundle
    assert "formatApiDetailItem" in bundle
    assert "item.loc" in bundle
    assert "payload.detail" in bundle
    assert 'part !== "body" && part !== "query"' in bundle
    assert 'error.name === "AbortError"' in bundle
    assert "请求超时，请确认本地服务仍在运行" in bundle
    assert "signal is aborted|aborted without reason" in bundle
    assert "请求被浏览器中止，通常是前端超时或重复触发检查导致" in bundle
    assert "failed to fetch|networkerror|load failed" in bundle
    assert "无法连接到本地服务，请确认 gateway 正在运行后重试" in bundle
    assert "cursor: not-allowed" in bundle
    assert 'button[data-busy="true"]' in bundle
    assert "setButtonBusy" in bundle
    assert 'button.setAttribute("aria-busy", "true")' in bundle
    assert "const { timeoutMs, ...fetchOptions } = options" in bundle
    assert "timeoutMs: documentParseTimeoutMs" in bundle
    assert "documentParseTimeoutMs = 45_000" in bundle
    assert "prepareSessionTimeoutMs = 90_000" in bundle
    assert "externalCheckTimeoutMs = 65_000" in bundle
    assert 'else if (connected) {\n    setPill(micStatus, "麦克风未开启", "");' in bundle
    assert "input.disabled = true" in bundle
    assert "input.value = \"\"" in bundle
    assert ".log,.pdf" in bundle
    assert "supportedDocumentSuffixes" in bundle
    assert "supportedDocumentMimeTypes" in bundle
    assert "supportedDocumentFile(file)" in bundle
    assert "normalizedContentType(file.type)" in bundle
    assert 'type.startsWith("text/")' in bundle
    assert 'type.startsWith("image/")' in bundle
    assert "文件格式暂不支持" in bundle
    assert "txt、md、json、csv、log、pdf、docx、doc 或图片" in bundle
    assert "setUploadInputStatus" in bundle
    assert 'input[type="file"]:disabled' in bundle
    assert 'aria-describedby="jdFileStatus"' in bundle
    assert 'class="small upload-status" id="jdFileStatus" role="status" aria-live="polite"' in (
        bundle
    )
    assert 'aria-describedby="resumeFileStatus"' in bundle
    assert 'class="small upload-status" id="resumeFileStatus" role="status" aria-live="polite"' in (
        bundle
    )
    assert ".upload-status.live" in bundle
    assert ".upload-status.ready" in bundle
    assert ".upload-status.warn" in bundle
    assert 'status.className = `small upload-status ${tone}`.trim()' in bundle
    assert "支持 PDF、Word、图片和文本文件" in bundle
    assert 'document.querySelector(`#${input.id}Status`)' in bundle
    assert "正在解析" in bundle
    assert "解析失败" in bundle
    assert "documentParsingCount" in bundle
    assert "documentParseToken" in bundle
    assert "documentParseEpoch" in bundle
    assert "documentParseStillCurrent" in bundle
    assert "const parseStillCurrent = documentParseStillCurrent(input, documentParseToken)" in bundle
    assert "if (!documentParseStillCurrent(input, documentParseToken)) return" in bundle
    assert "cancelDocumentParses" in bundle
    assert "resetDocumentUploadInputs" in bundle
    assert "解析已取消" in bundle
    assert "资料正在解析，完成后再创建实时面试" in bundle
    assert "maxDocumentUploadBytes = 25 * 1024 * 1024" in bundle
    assert "文件超过 25MB" in bundle
    assert "请压缩、拆分或直接粘贴关键内容" in bundle
    assert "资料上传提示" in bundle
    assert "result.warning" in bundle
    assert "未提取到可用文本" in bundle
    assert "文字版 PDF、DOCX" in bundle
    assert "DeepSeek 清洗未完成" in bundle
    assert "resetQuestionMetaForManualEdit" in bundle
    assert "hadProbeMeta" in bundle
    assert "已改为手动编辑问题，将按面试官自定义问题记录" in bundle
    assert 'title="把该能力维度生成当前面试问题"' in bundle
    assert 'aria-label="生成${escapeHtml(item.name)}维度的面试问题"' in bundle
    assert 'title="将此追问填入当前面试问题"' in bundle
    assert 'aria-label="将此追问设为下一问"' in bundle
    assert "function selectQuestion(question, meta = {})" in bundle
    assert 'answerText.value = "";\n  updateTextCounters();\n  state.selectedQuestionSource' in (
        bundle
    )
    assert 'currentQuestion.addEventListener("input", () =>' in bundle
    assert "resetQuestionMetaForManualEdit();" in bundle
    assert 'parseDocumentFile(event.target.files[0], event.target, resumeText, "简历", "resume")' in bundle
    assert "reconnectLiveChannel" in bundle
    assert "reconnectInterviewId" in bundle
    assert "reconnectStillCurrent" in bundle
    assert "重新连接当前面试实时通道" in bundle
    assert "当前已有面试，请重置后再创建新的面试" in bundle
    assert "资料正在解析，完成后再创建实时面试。" in bundle
    assert "loadSampleButton" in bundle
    assert "当前已有面试，请重置后再加载样例资料" in bundle
    assert "当前已有面试或资料正在处理，请重置后再加载样例资料" in bundle
    assert "prepareSessionToken" in bundle
    assert "prepareSessionStillCurrent" in bundle
    assert "async function postJson(url, payload, options = {})" in bundle
    assert "timeoutMs: prepareSessionTimeoutMs" in bundle
    assert "if (!prepareSessionStillCurrent(prepareToken)) return" in bundle
    assert "openSocketWithLatestGateway(interview.id, () =>" in bundle
    assert "validateSetupForm" in bundle
    assert "面试创建失败" in bundle
    assert "不能为空" in bundle
    assert "重新检查服务、模型和 ASR 状态" in bundle
    assert 'refreshStatus.addEventListener("click", checkRuntime)' in bundle
    assert 'id="checkModel"' in bundle
    assert "checkLlmConnection" in bundle
    assert "/api/config/llm/check" in bundle
    assert "timeoutMs: externalCheckTimeoutMs" in bundle
    assert 'appendEvent("模型检查", gatewayUnavailableEventBody(error), "red")' in bundle
    assert "if (!modelCheckStillCurrent(checkToken)) return" in bundle
    assert "if (modelCheckStillCurrent(checkToken))" in bundle
    assert "手动调用真实模型检查连接" in bundle
    assert 'id="checkAsr"' in bundle
    assert "checkAsrReadiness" in bundle
    assert "/api/config/asr/check" in bundle
    assert 'appendEvent("ASR 检查", gatewayUnavailableEventBody(error), "red")' in bundle
    assert "if (!asrCheckStillCurrent(checkToken)) return" in bundle
    assert "if (asrCheckStillCurrent(checkToken))" in bundle
    assert "手动检查 ASR 配置、依赖和 Token" in bundle
    assert 'id="gatewayKey"' in bundle
    assert 'id="saveGatewayKey"' in bundle
    assert "sessionStorage.getItem(\"gatewayApiKey\")" in bundle
    assert '"X-API-Key": state.gatewayApiKey' in bundle
    assert "fetchWithTimeout(" in bundle
    assert "apiUrl(path)" in bundle
    assert "url.searchParams.set(key, value)" in bundle
    assert "websocketProtocols" in bundle
    assert "base64UrlEncode" in bundle
    assert 'gateway-key.${base64UrlEncode(state.gatewayApiKey)}' in bundle
    assert "const socketUrl = wsUrl(`/ws/interview/${interviewId}`)" in bundle
    assert "new WebSocket(socketUrl, websocketProtocols())" in bundle
    assert 'data-report-format="html"' in bundle
    assert 'data-report-format="transcript.json"' in bundle
    assert 'title="下载 HTML 报告"' in bundle
    assert 'aria-label="下载 HTML 报告"' in bundle
    assert 'title="下载 PDF 报告"' in bundle
    assert 'aria-label="下载 PDF 报告"' in bundle
    assert 'title="下载 JSON 报告"' in bundle
    assert 'aria-label="下载 JSON 报告"' in bundle
    assert 'title="下载转写记录"' in bundle
    assert 'aria-label="下载转写记录"' in bundle
    assert ">转写</button>" in bundle
    assert "downloadReportArtifact" in bundle
    assert "reportDownloadStillCurrent" in bundle
    assert 'id="credibilityBox" role="status" aria-live="polite"' in bundle
    assert 'id="reportPanel" role="status" aria-live="polite"' in bundle
    assert "if (!reportDownloadStillCurrent(interviewId)) return" in bundle
    assert "reportDownloadInFlight" in bundle
    assert "state.reportDownloadInFlight.has(downloadKey)" in bundle
    assert "state.reportDownloadInFlight.delete(downloadKey)" in bundle
    assert "正在下载中，请稍候" in bundle
    assert "`/api/interviews/${interviewId}/report.${format}`" in bundle
    assert "timeoutMs: reportDownloadTimeoutMs" in bundle
    assert "reportDownloadTimeoutMs = 30_000" in bundle
    assert 'button.textContent = "下载中"' in bundle
    assert "正在下载 ${reportFormatLabel(format)} 报告" in bundle
    assert "button.textContent = originalLabel || reportFormatLabel(format)" in bundle
    assert "reportFormatLabel(format)" in bundle
    assert '"transcript.json": "转写"' in bundle
    assert "reportFilename" in bundle
    assert "reportEvidenceRows" in bundle
    assert "reportTotalScoreText" in bundle
    assert "待确认" in bundle
    assert "reportRecommendationText" in bundle
    assert "建议待确认" in bundle
    assert "reportSummaryText" in bundle
    assert "暂无总评" in bundle
    assert "reportInterviewId" in bundle
    assert "报告 ID 或格式缺失" in bundle
    assert "暂无维度评分" in bundle
    assert "暂无转写记录" in bundle
    assert "暂无证据" in bundle
    assert 'format === "transcript.json"' in bundle
    assert '.transcript.json`' in bundle
    assert "gatewayAuthError" in bundle
    assert "showGatewayKeyRequired" in bundle
    assert 'showGatewayKeyRequired("模型检查", { model: true })' in bundle
    assert 'showGatewayKeyRequired("ASR 检查", { asr: true })' in bundle
    assert "需要 Gateway Key" in bundle
    assert "Gateway 已启用鉴权" in bundle
    assert "interviewEnded" in bundle
    assert "reportReady" in bundle
    assert "面试已结束，请重置后创建新的面试" in bundle
    assert "正在结束面试并生成评分报告" in bundle
    assert "请等待后台评分完成" in bundle
    assert "后台评分任务已排队，系统会自动刷新报告" in bundle
    assert 'id="refreshReport"' in bundle
    assert "refreshQueuedReport" in bundle
    assert "scheduleQueuedReportPolling" in bundle
    assert "clearQueuedReportPolling" in bundle
    assert "queuedReportMaxPollAttempts = 30" in bundle
    assert "queuedReportPollIntervalMs = 3000" in bundle
    assert "reportRefreshEpoch" in bundle
    assert "reportRefreshStillCurrent" in bundle
    assert "reportRefreshInFlight" in bundle
    assert "reportRefreshStillCurrent(refreshEpoch, interviewId) &&" in bundle
    assert 'button.textContent = "刷新中"' in bundle
    assert 'button.textContent = originalLabel || "刷新报告"' in bundle
    assert 'title="手动刷新评分报告"' in bundle
    assert 'aria-label="手动刷新评分报告"' in bundle
    assert "报告刷新正在进行中，请稍候" in bundle
    assert "fetchGatewayJson(`/api/interviews/${interviewId}/report`)" in bundle
    assert "reportPendingError" in bundle
    assert "报告仍在生成中，请稍后再刷新" in bundle
    assert "markReportReady" in bundle
    assert "报告已生成" in bundle
    assert "可以下载 HTML、PDF、JSON 或转写" in bundle
    assert "resetSessionState" in bundle
    assert 'currentQuestion.value = ""' in bundle
    assert 'answerText.value = ""' in bundle
    assert 'document.querySelector("#resetSession").addEventListener("click", resetSessionState)' in bundle
    assert "今天，推进这一场面试" in bundle
    assert "emptyFeedMarkup" in bundle
    assert "preparingInterview" in bundle
    assert "正在创建实时面试，请稍候" in bundle
    assert "当前已有面试，请重置后再创建新的面试" in bundle

def test_gateway_health_identifies_service(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "shuihuo-killer-gateway",
        "version": "0.1.0",
    }


def test_gateway_allows_local_dev_cors_origins(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.get("/health", headers={"Origin": "http://127.0.0.1:8000"})
    preflight = client.options(
        "/api/jobs",
        headers={
            "Origin": "http://127.0.0.1:8000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:8000"
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://127.0.0.1:8000"


def test_gateway_preflight_with_auth_allows_browser_but_protects_assets(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, gateway_api_key="local-test-key")
    for origin in ("null", "http://127.0.0.1:9958"):
        response = client.options(
            "/api/learning-assets/sessions/upsert",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-api-key",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
    assert client.get("/api/learning-assets/sessions").status_code == 401
    authenticated = client.get(
        "/api/learning-assets/sessions", headers={"X-API-Key": "local-test-key"}
    )
    assert authenticated.status_code == 200
    assert authenticated.json() == {"items": []}


def test_gateway_config_status_hides_secrets(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("LLM_API_KEY", "super-secret")
    # 模型就绪状态取决于本地是否已下载模型；把模型目录指到不存在的路径，保证
    # ready=False 在任何机器上都成立（默认目录在本机可能已下载）。
    monkeypatch.setenv(
        "SHERPA_ASR_MODEL_DIR",
        str(tmp_path / "sherpa-onnx-streaming-paraformer-bilingual-zh-en"),
    )
    client = _client(tmp_path, monkeypatch)
    response = client.get("/api/config/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["database_url"].startswith("sqlite:///")
    assert payload["otel_exporter_otlp_configured"] is False
    assert payload["otel_service_name"] == "shuihuo-killer-gateway"
    assert payload["llm_api_key_configured"] is True
    assert payload["llm_max_retries"] == 1
    assert payload["llm_rate_limit_enabled"] is False
    assert payload["llm_rate_limit_requests_per_minute"] == 60
    assert payload["gateway_auth_enabled"] is False
    assert payload["asr_provider"] == "stub"
    assert payload["asr_base_url_configured"] is False
    assert payload["asr_api_path"] == "/transcribe"
    assert payload["asr_api_key_configured"] is False
    assert payload["asr_text_path"] == "text"
    assert payload["asr_speaker_path"] == "speaker"
    assert payload["asr_is_final_path"] == "is_final"
    assert payload["asr_confidence_path"] == "confidence"
    assert payload["asr_timeout_seconds"] == 30
    assert payload["asr_channel_diarization_configured"] is True
    assert payload["aliyun_asr_api_key_configured"] is False
    assert payload["aliyun_asr_model"] == "paraformer-realtime-v2"
    assert payload["aliyun_asr_endpoint_configured"] is True
    assert payload["aliyun_asr_sample_rate"] == 16000
    assert payload["aliyun_asr_format"] == "pcm"
    assert payload["aliyun_asr_language_hints_configured"] is True
    assert payload["aliyun_nls_app_key_configured"] is False
    assert payload["aliyun_nls_token_configured"] is False
    assert payload["aliyun_nls_token_auto_configured"] is False
    assert payload["aliyun_nls_endpoint_configured"] is True
    assert payload["aliyun_nls_sample_rate"] == 16000
    assert payload["aliyun_nls_format"] == "pcm"
    assert payload["sherpa_asr_model_dir"].endswith("sherpa-onnx-streaming-paraformer-bilingual-zh-en")
    assert payload["sherpa_asr_model_ready"] is False
    assert payload["sherpa_asr_sample_rate"] == 16000
    assert payload["sherpa_asr_provider"] == "cpu"
    assert payload["probe_min_answer_chars"] == 20
    assert payload["probe_min_interval_ms"] == 1000
    assert payload["probe_require_topic_match"] is True
    assert payload["probe_topic_keywords_configured"] is True
    assert payload["speaker_diarization_provider"] == "local"
    assert payload["speaker_diarization_base_url_configured"] is False
    assert payload["speaker_diarization_api_key_configured"] is False
    assert payload["speaker_diarization_speaker_path"] == "speaker"
    assert payload["speaker_diarization_timeout_seconds"] == 10
    assert payload["aigc_detector_provider"] == "local"
    assert payload["aigc_detector_base_url_configured"] is False
    assert payload["aigc_detector_api_path"] == "/detect"
    assert payload["aigc_detector_api_key_configured"] is False
    assert payload["aigc_detector_probability_path"] == "ai_generated_prob"
    assert payload["aigc_detector_flagged_path"] == "flagged"
    assert payload["aigc_detector_timeout_seconds"] == 10
    assert payload["aigc_ai_prob_threshold"] == 0.65
    assert payload["aigc_template_similarity_threshold"] == 0.45
    assert payload["rate_limit_enabled"] is False
    assert payload["rate_limit_backend"] == "local"
    assert payload["rate_limit_requests_per_minute"] == 120
    assert payload["redis_rate_limit_prefix"] == "shuihuo:rate_limit"
    assert payload["offline_task_backend"] == "local"
    assert payload["offline_task_execution"] == "sync"
    assert payload["celery_broker_configured"] is True
    assert payload["celery_result_backend_configured"] is True
    assert payload["celery_task_queue"] == "shuihuo-offline"
    assert payload["redis_url_configured"] is True
    assert payload["redis_stream_prefix"] == "shuihuo"
    assert payload["jd_vector_backend"] == "local"
    assert payload["object_storage_endpoint_configured"] is False
    assert payload["object_storage_bucket"] == "shuihuo-killer"
    assert "super-secret" not in response.text


def test_gateway_update_llm_config_persists_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/config/llm",
        json={
            "llm_model": "my-model",
            "llm_base_url": "https://api.example.com/v1/",
            "llm_api_key": "sk-live-1234",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["llm_provider"] == "openai_compatible"
    assert payload["llm_model"] == "my-model"
    assert payload["llm_base_url"] == "https://api.example.com/v1"
    assert payload["llm_api_key_configured"] is True
    assert payload["llm_base_url_configured"] is True

    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "LLM_PROVIDER=openai_compatible" in env_text
    assert "LLM_MODEL=my-model" in env_text
    assert "LLM_BASE_URL=https://api.example.com/v1" in env_text
    assert "LLM_API_KEY=sk-live-1234" in env_text

    keep_response = client.post(
        "/api/config/llm",
        json={"llm_model": "other-model", "llm_base_url": "https://api.example.com/v1"},
    )
    assert keep_response.status_code == 200
    assert keep_response.json()["llm_api_key_configured"] is True
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "LLM_MODEL=other-model" in env_text
    assert "LLM_API_KEY=sk-live-1234" in env_text

    status = client.get("/api/config/status")
    assert status.json()["llm_model"] == "other-model"


def test_gateway_update_llm_config_rejects_invalid_input(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path, monkeypatch)

    missing_model = client.post(
        "/api/config/llm", json={"llm_model": " ", "llm_base_url": "https://api.example.com"}
    )
    assert missing_model.status_code == 422

    bad_url = client.post(
        "/api/config/llm", json={"llm_model": "m", "llm_base_url": "api.example.com"}
    )
    assert bad_url.status_code == 422
    assert not (tmp_path / ".env").exists()


def test_gateway_llm_check_reports_mock_mode(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/config/llm/check")

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "mode": "mock",
        "message": "当前是模型模拟模式，没有调用真实模型。",
    }


def test_gateway_llm_check_calls_configured_model(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret-key")
    get_settings.cache_clear()

    class FakeClient:
        async def complete_json(self, messages, schema, fallback, raise_on_error=False):
            assert raise_on_error is True
            assert messages
            return schema.model_validate(
                {
                    "suggestions": [
                        {
                            "question": "讲一个真实排障案例？",
                            "target": "验证模型连通",
                            "competency": "LLM",
                            "priority": 1,
                        }
                    ],
                    "credibility": {
                        "level": "solid",
                        "reason": "ok",
                        "drill_down_hint": "ok",
                    },
                }
            )

    monkeypatch.setattr("services.gateway.app.get_llm_client", lambda: FakeClient())

    response = client.post("/api/config/llm/check")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "mode": "live",
        "message": "真实模型连接正常：openai_compatible / test-model",
    }


def test_gateway_llm_check_sanitizes_upstream_error(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test")
    monkeypatch.setenv("LLM_API_KEY", "secret-key")
    get_settings.cache_clear()

    class FakeClient:
        async def complete_json(self, messages, schema, fallback, raise_on_error=False):
            raise RuntimeError("HTTP 401: {'error':'bad secret-key'}")

    monkeypatch.setattr("services.gateway.app.get_llm_client", lambda: FakeClient())

    response = client.post("/api/config/llm/check")

    assert response.status_code == 200
    assert response.json() == {"ok": False, "mode": "error", "message": "HTTP 401"}


def test_gateway_asr_check_reports_sherpa_missing_model(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "sherpa_onnx")
    monkeypatch.setenv("SHERPA_ASR_MODEL_DIR", str(tmp_path / "missing-model"))
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/config/asr/check")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["mode"] in {"incomplete", "missing_dependency"}
    assert "sherpa" in payload["message"].lower() or "本地" in payload["message"]


def test_gateway_asr_check_reports_stub_mode(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/config/asr/check")

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "mode": "stub",
        "message": "当前是 ASR 模拟模式，没有调用真实语音识别。",
    }


def test_gateway_asr_check_validates_nls_auto_token(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_nls_ws")
    monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "app-key")
    monkeypatch.setenv("ALIYUN_NLS_TOKEN", "")
    monkeypatch.setenv("ALIYUN_AK_ID", "ak-id")
    monkeypatch.setenv("ALIYUN_AK_SECRET", "ak-secret")
    get_settings.cache_clear()

    class FakeTokenProvider:
        def __init__(self, **kwargs):
            assert kwargs["access_key_id"] == "ak-id"

        def get_token(self):
            return "generated-token"

    monkeypatch.setattr("services.gateway.app.AliyunNLSTokenProvider", FakeTokenProvider)

    response = client.post("/api/config/asr/check")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "mode": "token_ready",
        "message": "阿里云 NLS ASR 就绪：WebSocket 依赖存在，自动 Token 可生成。",
    }


def test_gateway_asr_check_validates_auto_token_when_fixed_nls_token_exists(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_nls_ws")
    monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "app-key")
    monkeypatch.setenv("ALIYUN_NLS_TOKEN", "fixed-token")
    monkeypatch.setenv("ALIYUN_AK_ID", "ak-id")
    monkeypatch.setenv("ALIYUN_AK_SECRET", "ak-secret")
    get_settings.cache_clear()

    class FakeTokenProvider:
        calls = 0

        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def get_token(self) -> str:
            FakeTokenProvider.calls += 1
            return "created-token"

    monkeypatch.setattr("services.gateway.app.AliyunNLSTokenProvider", FakeTokenProvider)

    response = client.post("/api/config/asr/check")

    assert response.status_code == 200
    assert FakeTokenProvider.calls == 1
    assert response.json() == {
        "ok": True,
        "mode": "fixed_token_auto_ready",
        "message": "阿里云 NLS ASR 就绪：固定 Token 已配置，AK 自动 Token 可生成；固定 Token 被拒绝时会自动刷新重试。",
    }


def test_gateway_asr_check_sanitizes_nls_token_error(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_nls_ws")
    monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "app-key")
    monkeypatch.setenv("ALIYUN_NLS_TOKEN", "")
    monkeypatch.setenv("ALIYUN_AK_ID", "ak-id")
    monkeypatch.setenv("ALIYUN_AK_SECRET", "ak-secret")
    get_settings.cache_clear()

    class FakeTokenProvider:
        def __init__(self, **kwargs):
            pass

        def get_token(self):
            raise RuntimeError("CreateToken failed for ak-secret")

    monkeypatch.setattr("services.gateway.app.AliyunNLSTokenProvider", FakeTokenProvider)

    response = client.post("/api/config/asr/check")

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["mode"] == "token_error"
    assert "ak-secret" not in response.text
    assert "***" in response.text


def test_gateway_config_status_redacts_database_password(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:db-secret@localhost:5432/app")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    get_settings.cache_clear()
    response = TestClient(app).get("/api/config/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["database_url"] == "postgresql://user:***@localhost:5432/app"
    assert "db-secret" not in response.text


def test_gateway_api_key_auth_can_be_enabled(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, gateway_api_key="gateway-secret")

    assert client.get("/health").status_code == 200
    unauthorized = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"})
    assert unauthorized.status_code == 401
    assert unauthorized.headers["x-request-id"]

    created = client.post(
        "/api/jobs",
        headers={"x-api-key": "gateway-secret"},
        json={"title": "Backend", "jd_text": "Python"},
    )
    assert created.status_code == 200
    status = client.get(
        "/api/config/status",
        headers={"authorization": "Bearer gateway-secret"},
    )
    assert status.status_code == 200
    payload = status.json()
    assert payload["gateway_auth_enabled"] is True
    assert "gateway-secret" not in status.text


def test_gateway_websocket_requires_api_key_when_enabled(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, gateway_api_key="gateway-secret")
    headers = {"x-api-key": "gateway-secret"}
    job = client.post(
        "/api/jobs",
        headers=headers,
        json={"title": "Backend", "jd_text": "Python"},
    ).json()
    candidate = client.post(
        "/api/candidates",
        headers=headers,
        json={"name": "Candidate"},
    ).json()
    interview = client.post(
        "/api/interviews",
        headers=headers,
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    try:
        with client.websocket_connect(f"/ws/interview/{interview['id']}"):
            raise AssertionError("expected websocket auth failure")
    except WebSocketDisconnect as exc:
        assert exc.code == 1008

    with client.websocket_connect(
        f"/ws/interview/{interview['id']}",
        headers=headers,
    ) as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我在 FastAPI 项目里负责接口编排、异常重试和 JSON 校验。",
            }
        )
        assert websocket.receive_json()["type"] == "transcript"
        probe, probe_messages = _receive_until(websocket, "probe")
        assert any(message["type"] == "probe_chains" for message in probe_messages)
        assert probe["payload"]["suggestions"]
        credibility, _ = _receive_until(websocket, "credibility")
        assert credibility["payload"]["level"] == probe["payload"]["credibility"]["level"]
        websocket.send_json({"type": "end"})
        report, _ = _receive_until(websocket, "report")
        assert report["type"] == "report"


def test_gateway_websocket_accepts_api_key_subprotocol(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, gateway_api_key="gateway-secret")
    headers = {"x-api-key": "gateway-secret"}
    job = client.post(
        "/api/jobs",
        headers=headers,
        json={"title": "Backend", "jd_text": "Python"},
    ).json()
    candidate = client.post(
        "/api/candidates",
        headers=headers,
        json={"name": "Candidate"},
    ).json()
    interview = client.post(
        "/api/interviews",
        headers=headers,
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(
        f"/ws/interview/{interview['id']}",
        headers={"sec-websocket-protocol": "gateway-key.Z2F0ZXdheS1zZWNyZXQ"},
    ) as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责可靠性治理并把错误分流、重试和报告生成串起来，线上超时率明显下降。",
            }
        )
        assert websocket.receive_json()["type"] == "transcript"


def test_gateway_job_probe_pattern_search(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post(
        "/api/jobs",
        json={"title": "LLM Backend", "jd_text": "Python FastAPI LLM 可靠性"},
    ).json()

    response = client.get(
        f"/api/jobs/{job['id']}/probe-patterns",
        params={"q": "LLM 调用失败降级 FastAPI 异常处理", "limit": 3},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload
    assert payload[0]["job_id"] == job["id"]
    assert any("LLM" in item["pattern"] or "FastAPI" in item["pattern"] for item in payload)


def test_gateway_probe_returns_404_for_unknown_job_id(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post(
        "/api/jobs",
        json={"title": "LLM Backend", "jd_text": "Python FastAPI LLM 可靠性"},
    ).json()

    response = client.post(
        "/api/probe",
        json={
            "job_id": "missing-job",
            "competency_model": job["competency_model"],
            "recent_turns": [],
            "latest_answer": "我主要负责 FastAPI 编排、重试和 JSON 校验。",
        },
    )

    assert response.status_code == 404
    assert "job not found" in response.text


def test_gateway_exposes_internal_aigc_scoring_and_report_contracts(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post(
        "/api/jobs",
        json={"title": "Backend", "jd_text": "Python FastAPI LLM 可靠性"},
    ).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    interview = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={
            "question": "讲项目",
            "answer": "我主要负责整体架构设计并推动项目落地最终取得显著提升",
            "answer_start_ms": 0,
            "answer_end_ms": 1000,
        },
    ).json()

    turns = interview["context"]["turns"]
    aigc = client.post("/api/aigc/detect", json={"turns": turns})
    assert aigc.status_code == 200
    aigc_results = aigc.json()
    assert aigc_results[0]["turn_id"] == turns[0]["turn_id"]
    assert aigc_results[0]["flagged"] is True

    score = client.post(
        "/api/scoring/score",
        json={"context": interview["context"], "aigc_results": aigc_results},
    )
    assert score.status_code == 200
    payload = score.json()
    assert payload["session_id"] == interview["id"]
    assert payload["dimensions"]
    assert payload["total_score"] > 0
    assert payload["risk_notes"]

    report = client.post(
        "/api/report/build",
        json={"context": interview["context"], "score": payload, "aigc_results": aigc_results},
    )
    assert report.status_code == 200
    report_payload = report.json()
    assert report_payload["interview_id"] == interview["id"]
    assert report_payload["score"]["total_score"] == payload["total_score"]
    assert report_payload["aigc_results"][0]["turn_id"] == turns[0]["turn_id"]
    assert report_payload["artifact_uris"]["json"].startswith("file://")
    assert report_payload["artifact_uris"]["html"].startswith("file://")
    assert report_payload["artifact_uris"]["pdf"].startswith("file://")
    assert Path(report_payload["json_path"]).read_text(encoding="utf-8")
    assert Path(report_payload["pdf_path"]).read_bytes().startswith(b"%PDF")


def test_gateway_aigc_detect_rejects_empty_turns(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/aigc/detect", json={"turns": []})

    assert response.status_code == 422
    assert "turns" in response.text


def test_gateway_aigc_detect_rejects_duplicate_turn_ids(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    interview = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    ).json()
    turn = interview["context"]["turns"][0]

    response = client.post("/api/aigc/detect", json={"turns": [turn, turn]})

    assert response.status_code == 422
    assert "AIGC detection turns must not contain duplicate turn_id values" in response.text


def test_gateway_scoring_rejects_empty_aigc_results(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    interview = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    ).json()

    response = client.post(
        "/api/scoring/score",
        json={"context": interview["context"], "aigc_results": []},
    )

    assert response.status_code == 422
    assert "aigc_results" in response.text


def test_gateway_report_build_rejects_mismatched_inputs(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post(
        "/api/jobs",
        json={"title": "Backend", "jd_text": "Python FastAPI LLM 可靠性"},
    ).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    interview = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={
            "question": "讲项目",
            "answer": "我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
            "answer_start_ms": 0,
            "answer_end_ms": 1000,
        },
    ).json()
    turns = interview["context"]["turns"]
    aigc_results = client.post("/api/aigc/detect", json={"turns": turns}).json()
    score = client.post(
        "/api/scoring/score",
        json={"context": interview["context"], "aigc_results": aigc_results},
    ).json()

    mismatched_score = {**score, "session_id": "other-session"}
    rejected_score = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_score,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_score.status_code == 409
    assert "score session_id" in rejected_score.text

    mismatched_dimension = json.loads(json.dumps(score))
    mismatched_dimension["dimensions"][0]["dimension"] = "不存在的维度"
    rejected_dimension = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_dimension,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_dimension.status_code == 409
    assert "score dimensions must match competency model items" in rejected_dimension.text

    mismatched_weight = json.loads(json.dumps(score))
    mismatched_weight["dimensions"][0]["weight"] = 99
    rejected_weight = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_weight,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_weight.status_code == 409
    assert "score dimension weight must match competency model" in rejected_weight.text

    mismatched_total = {**score, "total_score": 1}
    rejected_total = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_total,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_total.status_code == 409
    assert "score total_score must match dimension scores and weights" in rejected_total.text

    flipped_recommendation = "no" if score["recommendation"] != "no" else "strong_yes"
    mismatched_recommendation = {**score, "recommendation": flipped_recommendation}
    rejected_recommendation = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_recommendation,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_recommendation.status_code == 409
    assert "score recommendation must match total_score" in rejected_recommendation.text

    mismatched_evidence = json.loads(json.dumps(score))
    mismatched_evidence["dimensions"][0]["evidence"][0]["turn_id"] = "missing-turn"
    rejected_evidence = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": mismatched_evidence,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_evidence.status_code == 409
    assert "score evidence references unknown turn_id" in rejected_evidence.text

    out_of_range_evidence = json.loads(json.dumps(score))
    out_of_range_evidence["dimensions"][0]["evidence"][0]["quote_end_ms"] = 999999
    rejected_evidence_range = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": out_of_range_evidence,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_evidence_range.status_code == 409
    assert "score evidence timestamp is outside turn range" in rejected_evidence_range.text

    wrong_excerpt_evidence = json.loads(json.dumps(score))
    wrong_excerpt_evidence["dimensions"][0]["evidence"][0]["excerpt"] = "不存在于回答里的片段"
    rejected_evidence_excerpt = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": wrong_excerpt_evidence,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_evidence_excerpt.status_code == 409
    assert "score evidence excerpt is not in turn answer" in rejected_evidence_excerpt.text

    duplicate_evidence = json.loads(json.dumps(score))
    duplicate_evidence["dimensions"][0]["evidence"].append(
        duplicate_evidence["dimensions"][0]["evidence"][0]
    )
    rejected_duplicate_evidence = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": duplicate_evidence,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_duplicate_evidence.status_code == 409
    assert "score evidence contains duplicate reference" in rejected_duplicate_evidence.text

    mismatched_flag_context = json.loads(json.dumps(interview["context"]))
    mismatched_flag_context["flags"] = [
        {
            "turn_id_a": "missing-turn",
            "turn_id_b": turns[0]["turn_id"],
            "description": "无法追溯的一致性标记",
            "severity": "high",
        }
    ]
    rejected_flag = client.post(
        "/api/report/build",
        json={
            "context": mismatched_flag_context,
            "score": score,
            "aigc_results": aigc_results,
        },
    )
    assert rejected_flag.status_code == 422
    assert "consistency flag references unknown turn_id" in rejected_flag.text

    missing_aigc = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": score,
            "aigc_results": [],
        },
    )
    assert missing_aigc.status_code == 422
    assert "aigc_results" in missing_aigc.text

    duplicate_aigc = [aigc_results[0], aigc_results[0]]
    rejected_duplicate_aigc = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": score,
            "aigc_results": duplicate_aigc,
        },
    )
    assert rejected_duplicate_aigc.status_code == 422
    assert "AIGC results must not contain duplicate turn_id values" in rejected_duplicate_aigc.text

    threshold_bypass_aigc = [
        {
            **aigc_results[0],
            "ai_generated_prob": 0.99,
            "template_similarity": 0.0,
            "flagged": False,
        }
    ]
    rejected_threshold_bypass = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": score,
            "aigc_results": threshold_bypass_aigc,
        },
    )
    assert rejected_threshold_bypass.status_code == 409
    assert "AIGC result flagged must be true when thresholds are exceeded" in (
        rejected_threshold_bypass.text
    )

    mismatched_aigc = [{**aigc_results[0], "turn_id": "missing-turn"}]
    rejected_aigc = client.post(
        "/api/report/build",
        json={
            "context": interview["context"],
            "score": score,
            "aigc_results": mismatched_aigc,
        },
    )
    assert rejected_aigc.status_code == 422
    assert "AIGC result references unknown turn_id" in rejected_aigc.text


def test_gateway_end_interview_can_return_queued_task(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OFFLINE_TASK_EXECUTION", "async")
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )

    response = client.post(f"/api/interviews/{interview['id']}/end")

    assert response.status_code == 200
    payload = response.json()
    assert payload["interview_id"] == interview["id"]
    assert payload["status"] == "queued"
    assert payload["task_name"] == "interview.offline_scoring"
    assert client.get(f"/api/interviews/{interview['id']}/report").status_code == 404


def test_gateway_rejects_turns_after_report(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    assert client.post(f"/api/interviews/{interview['id']}/end").status_code == 200

    rejected = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "补充", "answer": "继续补充"},
    )

    assert rejected.status_code == 409
    assert "cannot add turn" in rejected.text


def test_gateway_rejects_duplicate_turn_ids(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    first = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={
            "turn_id": "turn-duplicate",
            "question": "讲项目",
            "answer": "我写了 FastAPI 编排。",
        },
    )

    rejected = client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={
            "turn_id": "turn-duplicate",
            "question": "补充",
            "answer": "我又写了一段不同回答。",
        },
    )

    assert first.status_code == 200
    assert rejected.status_code == 409
    assert "duplicate turn_id" in rejected.text
    assert first.json()["context"]["turns"][0]["answer"] == "我写了 FastAPI 编排。"

    other_interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    rejected_cross_interview = client.post(
        f"/api/interviews/{other_interview['id']}/turns",
        json={
            "turn_id": "turn-duplicate",
            "question": "另一个面试",
            "answer": "复用同一个 turn id。",
        },
    )

    assert rejected_cross_interview.status_code == 409
    assert "turn_id already exists" in rejected_cross_interview.text


def test_gateway_websocket_reports_state_errors(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    assert client.post(f"/api/interviews/{interview['id']}/end").status_code == 200

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        error = websocket.receive_json()

    assert error["type"] == "error"
    assert "cannot start interview from status REPORTED" in error["detail"]


def test_gateway_metrics_records_requests(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    traceparent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
    health = client.get(
        "/health",
        headers={"x-request-id": "trace-123", "traceparent": traceparent},
    )
    assert health.status_code == 200
    assert health.headers["x-request-id"] == "trace-123"
    assert health.headers["traceparent"].startswith("00-1234567890abcdef1234567890abcdef-")
    assert health.headers["traceparent"] != traceparent

    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert 'shuihuo_http_requests_total{method="GET",path="/health",status="200"} 1' in (
        response.text
    )


def test_gateway_metrics_include_offline_task_events(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    client.post(
        f"/api/interviews/{interview['id']}/turns",
        json={"question": "讲项目", "answer": "我写了 FastAPI 编排。"},
    )
    assert client.post(f"/api/interviews/{interview['id']}/end").status_code == 200

    metrics = client.get("/metrics").text

    assert 'shuihuo_events_total{topic="task.enqueued"} 1' in metrics
    assert 'shuihuo_events_total{topic="task.completed"} 1' in metrics
    assert 'shuihuo_events_total{topic="interview.finished"} 1' in metrics
    assert 'shuihuo_events_total{topic="interview.reported"} 1' in metrics


def test_gateway_writes_structured_request_log(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    client = _client(tmp_path, monkeypatch)
    caplog.set_level(logging.INFO, logger="shuihuo")

    response = client.get("/health", headers={"x-request-id": "trace-log"})

    assert response.status_code == 200
    payloads = [json.loads(record.message) for record in caplog.records if record.name == "shuihuo"]
    request_log = next(item for item in payloads if item["event"] == "http.request")
    assert request_log["request_id"] == "trace-log"
    assert len(request_log["trace_id"]) == 32
    assert len(request_log["span_id"]) == 16
    assert request_log["method"] == "GET"
    assert request_log["path"] == "/health"
    assert request_log["status_code"] == 200
    assert request_log["duration_seconds"] >= 0


def test_gateway_rate_limit_can_be_enabled(tmp_path: Path, monkeypatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        rate_limit_enabled=True,
        rate_limit_requests_per_minute=2,
    )

    assert client.get("/health").status_code == 200
    assert client.get("/health").status_code == 200
    limited = client.get("/health")

    assert limited.status_code == 429
    assert limited.headers["retry-after"].isdigit()


def test_signal_requires_admin_enablement(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()

    consent = client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": True},
    )
    assert consent.status_code == 200
    rejected = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    )
    assert rejected.status_code == 403
    assert "admin enablement" in rejected.text


def test_gateway_rejects_interview_for_missing_candidate(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()

    rejected = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": "missing-candidate"},
    )

    assert rejected.status_code == 404
    assert "candidate not found" in rejected.text


def test_gateway_rejects_consent_for_missing_candidate(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)

    rejected = client.post(
        "/api/consents",
        json={
            "candidate_id": "missing-candidate",
            "consent_type": "behavior_signal",
            "granted": True,
        },
    )

    assert rejected.status_code == 404
    assert "candidate not found" in rejected.text


def test_signal_requires_candidate_consent(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, signal_enabled=True)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()

    rejected = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    )
    assert rejected.status_code == 403
    assert "explicit candidate consent" in rejected.text

    consent = client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": True},
    )
    assert consent.status_code == 200
    accepted = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    )
    assert accepted.status_code == 200
    assert accepted.json()["signal_enabled"] is True


def test_signal_consent_can_be_revoked(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, signal_enabled=True)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()

    granted = client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": True},
    )
    assert granted.status_code == 200
    accepted = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    )
    assert accepted.status_code == 200

    revoked = client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": False},
    )
    assert revoked.status_code == 200
    assert revoked.json()["granted"] is False
    assert revoked.json()["revoked_at"] is not None

    rejected = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    )
    assert rejected.status_code == 403


def test_gateway_websocket_emits_behavior_signal_with_active_consent(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch, signal_enabled=True)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": True},
    )
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "嗯这个项目里我主要负责 FastAPI 编排、重试和 JSON 校验。",
            }
        )
        assert websocket.receive_json()["type"] == "transcript"
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")
        signal, _ = _receive_until(websocket, "signal")

    assert probe["payload"]["suggestions"]
    assert credibility["payload"]["level"] == probe["payload"]["credibility"]["level"]
    assert signal["type"] == "signal"
    assert set(signal["payload"]) == {"turn_id", "fluency", "hesitation", "evasiveness_hint"}
    assert signal["payload"]["hesitation"] > 0


def test_gateway_websocket_suppresses_behavior_signal_after_consent_revocation(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch, signal_enabled=True)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": True},
    )
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"], "signal_enabled": True},
    ).json()
    client.post(
        "/api/consents",
        json={"candidate_id": candidate["id"], "consent_type": "behavior_signal", "granted": False},
    )

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "嗯这个项目里我主要负责 FastAPI 编排、重试和 JSON 校验。",
            }
        )
        assert websocket.receive_json()["type"] == "transcript"
        _receive_until(websocket, "probe")
        _receive_until(websocket, "credibility")
        websocket.send_json({"type": "end"})
        report, messages = _receive_until(websocket, "report")

    assert report["type"] == "report"
    assert all(message["type"] != "signal" for message in messages)
    assert "signal" not in json.dumps(report["payload"], ensure_ascii=False)


def test_gateway_websocket_end_returns_task_queued_in_async_mode(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("OFFLINE_TASK_EXECUTION", "async")
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "嗯这个项目里我主要负责 FastAPI 编排、重试和 JSON 校验。",
            }
        )
        assert websocket.receive_json()["type"] == "transcript"
        _receive_until(websocket, "probe")
        _receive_until(websocket, "credibility")
        websocket.send_json({"type": "end"})
        queued, _ = _receive_until(websocket, "task_queued")

    assert queued["type"] == "task_queued"
    assert queued["payload"]["interview_id"] == interview["id"]
    assert queued["payload"]["status"] == "queued"
    assert queued["payload"]["task_name"] == "interview.offline_scoring"
    assert client.get(f"/api/interviews/{interview['id']}/report").status_code == 404


def test_gateway_websocket_probe_flow(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DIALOGUE_SILENCE_CLOSE_MS", "20")
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    text = "我主要负责优化，做了很多事情，效果比较好。"
    audio = base64.b64encode(text.encode("utf-8")).decode("ascii")
    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
                "audio_format": "pcm",
                "sample_rate_hz": 16000,
                "channels": 1,
            }
        )
        transcript = websocket.receive_json()
        probe, probe_messages = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")
        assert transcript["type"] == "transcript"
        assert any(message["type"] == "probe_chains" for message in probe_messages)
        assert probe["type"] == "probe"
        assert probe["payload"]["credibility"]["level"] in {"vague", "suspicious"}
        assert credibility["type"] == "credibility"
        assert credibility["payload"]["level"] == probe["payload"]["credibility"]["level"]


def test_gateway_websocket_text_turn_probe_flow(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "question": "请说明你在 FastAPI 网关里亲自负责的模块。",
                "question_source": "ai_probe",
                "probe_target": "验证项目真实性",
                "answer": "我主要负责优化，做了很多事情，效果比较好。",
            }
        )
        transcript = websocket.receive_json()
        probe, probe_messages = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")
        websocket.send_json({"type": "end"})
        report, _ = _receive_until(websocket, "report")
        assert transcript["type"] == "transcript"
        assert transcript["payload"]["speaker"] == "candidate"
        assert any(message["type"] == "probe_chains" for message in probe_messages)
        assert probe["type"] == "probe"
        assert probe["payload"]["suggestions"]
        assert credibility["type"] == "credibility"
        assert report["type"] == "report"
        assert (
            report["payload"]["transcript"][0]["question"]
            == "请说明你在 FastAPI 网关里亲自负责的模块。"
        )
        assert report["payload"]["transcript"][0]["question_source"] == "ai_probe"
        assert report["payload"]["transcript"][0]["probe_target"] == "验证项目真实性"


def test_gateway_websocket_question_flow_events_with_question_bank(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("QUESTION_MATCH_THRESHOLD", "0.30")
    client = _client(tmp_path, monkeypatch)
    setup = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "负责 Python FastAPI 网关、限流、降级和 LLM 编排。",
            "resume_text": "姓名：候选人\n独立主导网关优化，响应时间提升 50%。",
        },
    ).json()
    interview_id = setup["interview_id"]

    with client.websocket_connect(f"/ws/interview/{interview_id}") as websocket:
        current = websocket.receive_json()
        assert current["type"] == "current_question"
        current_payload = current["payload"]

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "speaker": "interviewer",
                "answer": current_payload["question"],
                "start_ms": 0,
                "end_ms": 800,
            }
        )
        question_transcript = websocket.receive_json()
        matched, _ = _receive_until(websocket, "question_matched")
        assert question_transcript["type"] == "transcript"
        assert question_transcript["payload"]["speaker"] == "interviewer"
        assert matched["payload"]["matched_option_id"] == current_payload["option_id"]
        assert matched["payload"]["asked_text"] == current_payload["question"]

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 2,
                "speaker": "candidate",
                "answer": "我亲自写了限流中间件、降级开关和监控指标，线上 P95 下降 50%。",
                "start_ms": 1000,
                "end_ms": 2200,
            }
        )
        answer_transcript = websocket.receive_json()
        turn, _ = _receive_until(websocket, "turn")
        next_options, _ = _receive_until(websocket, "next_options")
        assert answer_transcript["payload"]["speaker"] == "candidate"
        assert turn["payload"]["question"] == current_payload["question"]
        assert turn["payload"]["asked_option_id"] == current_payload["option_id"]
        assert turn["payload"]["question_origin"] == "system_suggested"
        assert len(next_options["payload"]["follow_up"]) >= 1
        assert len(next_options["payload"]["alternatives"]) >= 2

        selected = next_options["payload"]["alternatives"][0]
        websocket.send_json({"type": "pick_option", "option_id": selected["option_id"]})
        picked, _ = _receive_until(websocket, "current_question", limit=12)
        assert picked["payload"]["option_id"] == selected["option_id"]
        assert picked["payload"]["question"] == selected["question"]

    persisted_bank = client.get(f"/api/interviews/{interview_id}/question-bank").json()
    current_bank_id = current_payload["bank_question_id"]
    assert any(
        item["question_id"] == current_bank_id and item["asked"] is True
        for item in persisted_bank["items"]
    )


def test_gateway_websocket_emits_next_options_update_when_llm_refines(
    tmp_path: Path, monkeypatch
) -> None:
    class FakeNextOptionsClient:
        async def complete_json(self, messages, schema, fallback, raise_on_error=False):
            assert "NextOptions" in messages[0].content
            refined_alternative = fallback.alternatives[0].model_copy(
                update={
                    "option_id": "llm-alt-1",
                    "question": "请具体说明这次网关优化中你如何设计限流阈值和回滚方案？",
                    "reason": "LLM 精排后优先验证关键技术决策。",
                }
            )
            return fallback.model_copy(
                update={"alternatives": [refined_alternative, *fallback.alternatives[1:]]}
            )

    monkeypatch.setattr(
        "services.interview_orchestrator.question_flow.get_llm_client",
        lambda: FakeNextOptionsClient(),
    )
    client = _client(tmp_path, monkeypatch)
    setup = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "负责 Python FastAPI 网关、限流、降级和 LLM 编排。",
            "resume_text": "姓名：候选人\n独立主导网关优化，响应时间提升 50%。",
        },
    ).json()

    with client.websocket_connect(f"/ws/interview/{setup['interview_id']}") as websocket:
        current = websocket.receive_json()
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "speaker": "interviewer",
                "answer": current["payload"]["question"],
            }
        )
        websocket.receive_json()
        _receive_until(websocket, "question_matched")

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 2,
                "speaker": "candidate",
                "answer": "我亲自写了限流中间件、降级开关和监控指标。",
            }
        )
        websocket.receive_json()
        _receive_until(websocket, "next_options")
        update, _ = _receive_until(websocket, "next_options_update", limit=12)

    assert update["payload"]["alternatives"][0]["option_id"] == "llm-alt-1"
    assert "限流阈值" in update["payload"]["alternatives"][0]["question"]


def test_gateway_websocket_set_steering_recomputes_options_and_persists_context(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    setup = client.post(
        "/api/interviews/quick-setup",
        json={
            "jd_text": "负责 Python FastAPI 网关、限流、降级和 LLM 编排。",
            "resume_text": "姓名：候选人\n独立主导网关优化，响应时间提升 50%。",
        },
    ).json()
    interview_id = setup["interview_id"]
    bank_items = {item["question_id"]: item for item in setup["question_bank"]["items"]}

    with client.websocket_connect(f"/ws/interview/{interview_id}") as websocket:
        current = websocket.receive_json()
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "speaker": "interviewer",
                "answer": current["payload"]["question"],
            }
        )
        websocket.receive_json()
        _receive_until(websocket, "question_matched")

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 2,
                "speaker": "candidate",
                "answer": "我亲自写了限流中间件、降级开关和监控指标。",
            }
        )
        websocket.receive_json()
        _receive_until(websocket, "next_options")

        websocket.send_json({"type": "set_steering", "focus": "resume_drill"})
        steered, _ = _receive_until(websocket, "next_options", limit=12)

    bank_ids = [
        option["bank_question_id"]
        for option in steered["payload"]["alternatives"]
        if option.get("bank_question_id")
    ]
    assert bank_ids
    assert all(bank_items[question_id]["basis"] in {"resume", "jd_resume"} for question_id in bank_ids)
    persisted = client.get(f"/api/interviews/{interview_id}").json()
    assert persisted["context"]["question_steering"] == "resume_drill"
    assert persisted["context"]["steering_history"][-1] == "resume_drill"


def test_gateway_text_turn_works_with_aliyun_ws_provider(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "question": "请说明你在 FastAPI 网关里亲自负责的模块。",
                "answer": "我主要负责优化，做了很多事情，效果比较好。",
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

        assert transcript["type"] == "transcript"
        assert transcript["payload"]["text"] == "我主要负责优化，做了很多事情，效果比较好。"
        assert transcript["payload"]["speaker"] == "candidate"
        assert probe["type"] == "probe"
        assert credibility["type"] == "credibility"


def test_gateway_aliyun_ws_audio_chunk_reads_async_results(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FakeAliyunSession:
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id
            self.finished = False
            self.error_reason = ""
            self.sent_audio: list[bytes] = []
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def send_audio(self, pcm_bytes: bytes) -> None:
            self.sent_audio.append(pcm_bytes)
            await self.result_queue.put(
                TranscriptSegment(
                    session_id=self.session_id,
                    speaker="unknown",
                    text="我负责 FastAPI 网关、异常重试和 JSON 校验。",
                    start_ms=120,
                    end_ms=980,
                    is_final=True,
                    confidence=0.92,
                )
            )

        async def close(self) -> None:
            self.finished = True
            await self.result_queue.put(None)

    class FakeAliyunEngine:
        def __init__(self) -> None:
            self.session: FakeAliyunSession | None = None

        async def get_or_create_session(self, session_id: str) -> FakeAliyunSession:
            if self.session is None or self.session.finished:
                self.session = FakeAliyunSession(session_id)
            return self.session

        async def close_session(self, session_id: str) -> None:
            if self.session is not None and self.session.session_id == session_id:
                await self.session.close()

    engine = FakeAliyunEngine()
    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: engine)
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    audio = base64.b64encode(b"pcm-audio").decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

    assert engine.session is not None
    assert engine.session.sent_audio == [b"pcm-audio"]
    assert transcript["type"] == "transcript"
    assert transcript["payload"]["text"] == "我负责 FastAPI 网关、异常重试和 JSON 校验。"
    assert transcript["payload"]["speaker"] == "candidate"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"


def test_gateway_aliyun_ws_matches_async_result_to_audio_context(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class DelayedAliyunSession:
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id
            self.finished = False
            self.error_reason = ""
            self.sent_audio: list[bytes] = []
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def send_audio(self, pcm_bytes: bytes) -> None:
            self.sent_audio.append(pcm_bytes)
            if len(self.sent_audio) == 2:
                await self.result_queue.put(
                    TranscriptSegment(
                        session_id=self.session_id,
                        speaker="unknown",
                        text="我负责 FastAPI 网关、异常重试和 JSON 校验。",
                        start_ms=120,
                        end_ms=980,
                        is_final=True,
                        confidence=0.92,
                    )
                )

        async def close(self) -> None:
            self.finished = True
            await self.result_queue.put(None)

    class FakeAliyunEngine:
        def __init__(self) -> None:
            self.session: DelayedAliyunSession | None = None

        async def get_or_create_session(self, session_id: str) -> DelayedAliyunSession:
            if self.session is None or self.session.finished:
                self.session = DelayedAliyunSession(session_id)
            return self.session

        async def close_session(self, session_id: str) -> None:
            if self.session is not None and self.session.session_id == session_id:
                await self.session.close()

    engine = FakeAliyunEngine()
    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: engine)
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        # 两个 chunk 必须留在同一采集通道（同 speaker）：FakeAliyunEngine 对不同
        # stream_id 复用同一个 session/队列，若按 speaker 拆成两个通道，会有两个
        # reader 抢同一队列，结果可能被面试官通道认领并误标 speaker，用例会挂起。
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": base64.b64encode(b"candidate-audio").decode("ascii"),
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
                "start_ms": 0,
                "end_ms": 1000,
            }
        )
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 2,
                "audio": base64.b64encode(b"interviewer-audio").decode("ascii"),
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
                "start_ms": 1000,
                "end_ms": 2000,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

    assert engine.session is not None
    assert engine.session.sent_audio == [b"candidate-audio", b"interviewer-audio"]
    assert transcript["type"] == "transcript"
    assert transcript["payload"]["speaker"] == "candidate"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"


def test_gateway_aliyun_ws_start_failure_surfaces_reason(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FailingAliyunEngine:
        async def get_or_create_session(self, session_id: str) -> None:
            raise RuntimeError("aliyun_asr_task_failed:InvalidApiKey:bad key")

    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: FailingAliyunEngine())
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 7,
                "audio": base64.b64encode(b"pcm-audio").decode("ascii"),
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
            }
        )
        warning = websocket.receive_json()

    assert warning == {
        "type": "asr_warning",
        "payload": {
            "reason": "aliyun_asr_task_failed:InvalidApiKey:bad key",
            "seq": 0,
        },
    }


def test_gateway_aliyun_ws_send_retry_preserves_failure_reason(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FailingSendSession:
        def __init__(self, session_id: str, *, reason: str) -> None:
            self.session_id = session_id
            self.reason = reason
            self.finished = False
            self.error_reason = ""
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def send_audio(self, pcm_bytes: bytes) -> None:
            del pcm_bytes
            raise RuntimeError(self.reason)

        async def close(self) -> None:
            if not self.finished:
                self.finished = True
                await self.result_queue.put(None)

    class FailingSendEngine:
        def __init__(self) -> None:
            self.sessions: list[FailingSendSession] = []

        async def get_or_create_session(self, session_id: str) -> FailingSendSession:
            reason = (
                "aliyun_asr_disconnected"
                if not self.sessions
                else "aliyun_asr_task_failed:InvalidApiKey:bad key"
            )
            session = FailingSendSession(session_id, reason=reason)
            self.sessions.append(session)
            return session

        async def close_session(self, session_id: str) -> None:
            for session in self.sessions:
                if session.session_id == session_id and not session.finished:
                    await session.close()

    engine = FailingSendEngine()
    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: engine)
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 9,
                "audio": base64.b64encode(b"pcm-audio").decode("ascii"),
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
            }
        )
        warning = websocket.receive_json()

    assert warning == {
        "type": "asr_warning",
        "payload": {
            "reason": "aliyun_asr_task_failed:InvalidApiKey:bad key",
            "seq": 9,
        },
    }
    assert len(engine.sessions) == 2


def test_gateway_aliyun_nls_ws_audio_chunk_uses_streaming_path(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_nls_ws")
    monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "nls-app-key")
    monkeypatch.setenv("ALIYUN_NLS_TOKEN", "nls-token")

    class FakeNLSSession:
        def __init__(self, session_id: str) -> None:
            self.session_id = session_id
            self.finished = False
            self.error_reason = ""
            self.sent_audio: list[bytes] = []
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def send_audio(self, pcm_bytes: bytes) -> None:
            self.sent_audio.append(pcm_bytes)
            await self.result_queue.put(
                TranscriptSegment(
                    session_id=self.session_id,
                    speaker="unknown",
                    text="我负责 NLS 实时识别接入和异常处理。",
                    start_ms=0,
                    end_ms=900,
                    is_final=True,
                    confidence=0.9,
                )
            )

        async def close(self) -> None:
            self.finished = True
            await self.result_queue.put(None)

    class FakeNLSEngine:
        def __init__(self) -> None:
            self.session: FakeNLSSession | None = None

        async def get_or_create_session(self, session_id: str) -> FakeNLSSession:
            if self.session is None or self.session.finished:
                self.session = FakeNLSSession(session_id)
            return self.session

        async def close_session(self, session_id: str) -> None:
            if self.session is not None and self.session.session_id == session_id:
                await self.session.close()

    engine = FakeNLSEngine()
    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: engine)
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": base64.b64encode(b"nls-audio").decode("ascii"),
                "speaker": "candidate",
                "format": "pcm16",
                "sample_rate_hz": 16000,
                "channels": 1,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

    assert engine.session is not None
    assert engine.session.sent_audio == [b"nls-audio"]
    assert transcript["type"] == "transcript"
    assert transcript["payload"]["speaker"] == "candidate"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"


def test_gateway_websocket_end_error_does_not_close_session(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json({"type": "end"})
        early_end = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 网关的实时通道、重试和异常输入处理。",
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

        websocket.send_json({"type": "end"})
        report, _ = _receive_until(websocket, "report")

    assert early_end["type"] == "error"
    assert "cannot finish interview without candidate turns" in early_end["detail"]
    assert transcript["type"] == "transcript"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"
    assert report["type"] == "report"


def test_gateway_websocket_rejects_blank_text_turn(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json({"type": "text_turn", "seq": 1, "answer": "   "})
        error = websocket.receive_json()

    assert error == {"type": "error", "detail": "text_turn requires answer"}


def test_gateway_websocket_rejects_unknown_event_type_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json({"type": "unknown_event", "seq": 1})
        error = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 项目里的接口编排、重试和 JSON 校验。",
            }
        )
        transcript = websocket.receive_json()

    assert error == {"type": "error", "detail": "unsupported event type"}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_rejects_non_object_event_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(["not", "an", "object"])
        error = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 项目里的实时通道和输入校验。",
            }
        )
        transcript = websocket.receive_json()

    assert error == {"type": "error", "detail": "event payload must be an object"}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_rejects_invalid_json_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_text("not-json")
        error = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 实时通道里的 JSON 解析和恢复策略。",
            }
        )
        transcript = websocket.receive_json()

    assert error == {"type": "error", "detail": "event payload must be valid JSON"}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_rejects_binary_frame_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_bytes(b'{"type":"text_turn","seq":1,"answer":"binary"}')
        error = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 实时通道里的文本帧校验。",
            }
        )
        transcript = websocket.receive_json()

    assert error == {"type": "error", "detail": "event payload must be a text JSON frame"}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_keeps_session_after_asr_failure(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    class FlakyASREngine:
        def __init__(self) -> None:
            self.calls = 0

        async def transcribe_chunk(
            self,
            session_id,
            seq,
            audio_b64,
            *,
            speaker=None,
            start_ms=None,
            end_ms=None,
            is_final=True,
            confidence=None,
        ):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("upstream ASR unavailable")
            return TranscriptSegment(
                session_id=session_id,
                speaker=speaker or "candidate",
                text="我负责 FastAPI 项目里的接口编排、异常重试和 JSON 校验。",
                start_ms=0,
                end_ms=1000,
                is_final=is_final,
                confidence=0.8 if confidence is None else confidence,
            )

    engine = FlakyASREngine()
    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: engine)
    audio = base64.b64encode(b"audio").decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
            }
        )
        warning = websocket.receive_json()
        assert warning == {
            "type": "asr_warning",
            "payload": {"reason": "asr_transcription_failed", "seq": 1},
        }

        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 2,
                "audio": audio,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

    assert transcript["type"] == "transcript"
    assert transcript["payload"]["text"] == "我负责 FastAPI 项目里的接口编排、异常重试和 JSON 校验。"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"


def test_gateway_websocket_preserves_aliyun_asr_failure_reason(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    class FailingASREngine:
        async def transcribe_chunk(
            self,
            session_id,
            seq,
            audio_b64,
            *,
            speaker=None,
            start_ms=None,
            end_ms=None,
            is_final=True,
            confidence=None,
        ):
            del session_id, seq, audio_b64, speaker, start_ms, end_ms, is_final, confidence
            raise RuntimeError("aliyun_asr_task_failed:InvalidApiKey:bad key")

    monkeypatch.setattr("services.gateway.app.get_asr_engine", lambda: FailingASREngine())
    audio = base64.b64encode(b"audio").decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
            }
        )
        warning = websocket.receive_json()

    assert warning == {
        "type": "asr_warning",
        "payload": {
            "reason": "aliyun_asr_task_failed:InvalidApiKey:bad key",
            "seq": 1,
        },
    }


def test_gateway_websocket_manual_probe_bypasses_auto_gates(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json({"type": "manual_probe", "answer": "好"})
        transcript = websocket.receive_json()
        probe, probe_messages = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")
        assert transcript["type"] == "transcript"
        assert any(message["type"] == "probe_chains" for message in probe_messages)
        assert probe["type"] == "probe"
        assert probe["payload"]["suggestions"]
        assert credibility["type"] == "credibility"


def test_gateway_websocket_manual_probe_rejects_invalid_metadata_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "manual_probe",
                "answer": "我负责 FastAPI 编排。",
                "start_ms": "bad",
            }
        )
        bad_start = websocket.receive_json()

        websocket.send_json(
            {
                "type": "manual_probe",
                "answer": "我负责 FastAPI 编排。",
                "confidence": 2,
            }
        )
        bad_confidence = websocket.receive_json()

        websocket.send_json(
            {
                "type": "manual_probe",
                "answer": "我负责 FastAPI 编排、异常重试和 JSON 校验。",
                "start_ms": 0,
                "end_ms": 1000,
                "confidence": 0.9,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")

    assert bad_start == {
        "type": "error",
        "detail": "manual_probe start_ms must be a non-negative integer",
    }
    assert bad_confidence == {
        "type": "error",
        "detail": "manual_probe confidence must be between 0 and 1",
    }
    assert transcript["type"] == "transcript"
    assert probe["type"] == "probe"
    assert credibility["type"] == "credibility"


def test_gateway_websocket_ignores_non_final_and_interviewer_segments(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    text = "我主要负责优化，做了很多事情，效果比较好。"
    audio = base64.b64encode(text.encode("utf-8")).decode("ascii")
    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
                "speaker": "candidate",
                "is_final": "partial",
                "start_ms": 100,
                "end_ms": 600,
                "confidence": 0.6,
            }
        )
        transcript = websocket.receive_json()
        assert transcript["type"] == "transcript"
        assert transcript["payload"]["speaker"] == "candidate"
        assert transcript["payload"]["is_final"] is False
        assert transcript["payload"]["start_ms"] == 100
        assert transcript["payload"]["end_ms"] == 600
        assert transcript["payload"]["confidence"] == 0.6

        interviewer_audio = base64.b64encode("请讲一个你亲手做过的例子。".encode("utf-8")).decode("ascii")
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 3,
                "audio": interviewer_audio,
                "speaker": "interviewer",
                "is_final": True,
            }
        )
        interviewer_transcript = websocket.receive_json()
        assert interviewer_transcript["type"] == "transcript"
        assert interviewer_transcript["payload"]["speaker"] == "interviewer"

        websocket.send_json({"type": "end"})
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert "cannot finish interview without candidate turns" in error["detail"]


def test_gateway_websocket_rejects_invalid_audio_base64(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": "not-base64!",
                "speaker": "candidate",
            }
        )
        warning = websocket.receive_json()
        websocket.send_json({"type": "end"})
        error = websocket.receive_json()

    assert warning["type"] == "asr_warning"
    assert warning["payload"] == {"reason": "invalid_audio_base64", "seq": 1}
    assert error["type"] == "error"
    assert "cannot finish interview without candidate turns" in error["detail"]


def test_gateway_websocket_rejects_invalid_audio_seq_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    audio = base64.b64encode("我负责 FastAPI 编排和重试。".encode("utf-8")).decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": "not-a-number",
                "audio": audio,
                "speaker": "candidate",
            }
        )
        warning = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 项目里的接口编排、重试和 JSON 校验。",
            }
        )
        transcript = websocket.receive_json()

    assert warning["type"] == "asr_warning"
    assert warning["payload"] == {"reason": "invalid_seq", "seq": 0}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_rejects_invalid_text_turn_seq_without_closing(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "text_turn",
                "seq": "not-a-number",
                "answer": "我负责 FastAPI 项目里的接口编排、重试和 JSON 校验。",
            }
        )
        error = websocket.receive_json()

        websocket.send_json(
            {
                "type": "text_turn",
                "seq": 1,
                "answer": "我负责 FastAPI 项目里的接口编排、重试和 JSON 校验。",
            }
        )
        transcript = websocket.receive_json()

    assert error == {"type": "error", "detail": "invalid seq"}
    assert transcript["type"] == "transcript"


def test_gateway_websocket_rejects_unsupported_audio_metadata(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    audio = base64.b64encode("我负责 FastAPI 编排和重试。".encode("utf-8")).decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 1,
                "audio": audio,
                "audio_format": "mp3",
            }
        )
        bad_format = websocket.receive_json()
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 2,
                "audio": audio,
                "sample_rate_hz": 48000,
            }
        )
        bad_rate = websocket.receive_json()
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 3,
                "audio": audio,
                "channels": 2,
            }
        )
        bad_channels = websocket.receive_json()
        websocket.send_json({"type": "end"})
        error = websocket.receive_json()

    assert bad_format["type"] == "asr_warning"
    assert bad_format["payload"] == {"reason": "unsupported_audio_format", "seq": 1}
    assert bad_rate["type"] == "asr_warning"
    assert bad_rate["payload"] == {"reason": "unsupported_sample_rate", "seq": 2}
    assert bad_channels["type"] == "asr_warning"
    assert bad_channels["payload"] == {"reason": "unsupported_channel_count", "seq": 3}
    assert error["type"] == "error"
    assert "cannot finish interview without candidate turns" in error["detail"]


def test_gateway_websocket_rejects_mismatched_audio_session(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    audio = base64.b64encode("我负责 FastAPI 编排和重试。".encode("utf-8")).decode("ascii")

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": "other-session",
                "seq": 7,
                "audio": audio,
                "speaker": "candidate",
            }
        )
        warning = websocket.receive_json()
        websocket.send_json({"type": "end"})
        error = websocket.receive_json()

    assert warning["type"] == "asr_warning"
    assert warning["payload"] == {"reason": "session_id_mismatch", "seq": 7}
    assert error["type"] == "error"
    assert "cannot finish interview without candidate turns" in error["detail"]


def test_gateway_websocket_maps_audio_channel_to_speaker(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    text = "我主要负责优化，做了很多事情，效果比较好。"
    audio = base64.b64encode(text.encode("utf-8")).decode("ascii")
    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 2,
                "audio": audio,
                "channel": "right",
                "is_final": True,
            }
        )
        transcript = websocket.receive_json()
        probe, _ = _receive_until(websocket, "probe")
        credibility, _ = _receive_until(websocket, "credibility")
        assert transcript["type"] == "transcript"
        assert transcript["payload"]["speaker"] == "candidate"
        assert probe["type"] == "probe"
        assert credibility["type"] == "credibility"

        interviewer_text = "请介绍一下项目背景。"
        interviewer_audio = base64.b64encode(interviewer_text.encode("utf-8")).decode("ascii")
        websocket.send_json(
            {
                "type": "audio_chunk",
                "session_id": interview["id"],
                "seq": 3,
                "audio": interviewer_audio,
                "channel": "left",
                "is_final": True,
            }
        )
        interviewer_transcript = websocket.receive_json()
        assert interviewer_transcript["type"] == "transcript"
        assert interviewer_transcript["payload"]["speaker"] == "interviewer"

        websocket.send_json({"type": "end"})
        report = websocket.receive_json()
        assert report["type"] == "report"


def test_gateway_dual_device_streams_share_dialogue_and_sequence_space(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()
    question = "请介绍你负责的网关模块。"
    answer = "我负责限流和降级。"

    with client.websocket_connect(f"/ws/interview/{interview['id']}") as interviewer_ws:
        with client.websocket_connect(f"/ws/interview/{interview['id']}") as candidate_ws:
            interviewer_ws.send_json(
                {
                    "type": "text_turn",
                    "seq": 1,
                    "speaker": "interviewer",
                    "answer": question,
                    "start_ms": 0,
                    "end_ms": 1000,
                }
            )
            assert interviewer_ws.receive_json()["payload"]["speaker"] == "interviewer"
            assert candidate_ws.receive_json()["payload"]["speaker"] == "interviewer"

            candidate_ws.send_json(
                {
                    "type": "text_turn",
                    "seq": 1,
                    "speaker": "candidate",
                    "answer": answer,
                    "start_ms": 1200,
                    "end_ms": 2200,
                }
            )
            assert interviewer_ws.receive_json()["payload"]["speaker"] == "candidate"
            assert candidate_ws.receive_json()["payload"]["speaker"] == "candidate"

            candidate_ws.send_json({"type": "end"})
            candidate_report, candidate_messages = _receive_until(candidate_ws, "report")
            interviewer_report, interviewer_messages = _receive_until(interviewer_ws, "report")

    assert all(message.get("type") != "asr_warning" for message in candidate_messages)
    assert all(message.get("type") != "asr_warning" for message in interviewer_messages)
    assert candidate_report["payload"] == interviewer_report["payload"]
    report = candidate_report["payload"]
    assert report["transcript"][0]["question"] == question
    assert report["transcript"][0]["answer"] == answer
    assert [item["speaker"] for item in report["utterances"]] == [
        "interviewer",
        "candidate",
    ]


def test_gateway_websocket_deduplicates_final_audio_segments(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    job = client.post("/api/jobs", json={"title": "Backend", "jd_text": "Python"}).json()
    candidate = client.post("/api/candidates", json={"name": "Candidate"}).json()
    interview = client.post(
        "/api/interviews",
        json={"job_id": job["id"], "candidate_id": candidate["id"]},
    ).json()

    text = "我主要负责优化，做了很多事情，效果比较好。"
    audio = base64.b64encode(text.encode("utf-8")).decode("ascii")
    event = {
        "type": "audio_chunk",
        "session_id": interview["id"],
        "seq": 1,
        "audio": audio,
        "speaker": "candidate",
        "is_final": True,
    }
    with client.websocket_connect(f"/ws/interview/{interview['id']}") as websocket:
        websocket.send_json(event)
        assert websocket.receive_json()["type"] == "transcript"
        _receive_until(websocket, "probe")
        _receive_until(websocket, "credibility")

        websocket.send_json(event)
        warning, _ = _receive_until(websocket, "asr_warning")
        assert warning["type"] == "asr_warning"
        assert warning["payload"]["reason"] == "duplicate_final_segment"

        websocket.send_json({"type": "end"})
        report, _ = _receive_until(websocket, "report")
        assert report["type"] == "report"


def test_gateway_one_shot_offline_evaluate(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/offline/evaluate",
        json={
            "job_title": "AI 面试系统后端",
            "jd_text": "Python FastAPI LLM 报告生成",
            "candidate_name": "Candidate",
            "resume_text": "做过 AI 应用",
            "turns": [
                {
                    "question": "介绍最核心的项目",
                    "answer": "我主要负责整体架构设计并推动项目落地最终取得显著提升",
                    "answer_start_ms": 0,
                    "answer_end_ms": 1000,
                },
                {
                    "question": "具体你写了哪部分",
                    "answer": "我写了 FastAPI 编排、模型重试和 JSON 校验，因为线上有格式漂移。",
                    "answer_start_ms": 1200,
                    "answer_end_ms": 3000,
                },
            ],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["report"]["score"]["total_score"] > 0
    assert payload["interview"]["status"] == "REPORTED"
    report_id = payload["report"]["interview_id"]
    assert client.get(f"/api/interviews/{report_id}/report").status_code == 200


def test_gateway_exam_solve_requires_api_key_when_enabled(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, gateway_api_key="gateway-secret")

    unauthorized = client.post(
        "/api/exam/solve?filename=exam.png",
        content=b"fake-png",
        headers={"content-type": "image/png"},
    )
    assert unauthorized.status_code == 401


def test_gateway_exam_solve_rejects_empty_and_oversize_images(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "32")
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("VISION_MAX_IMAGE_BYTES", "32")
    get_settings.cache_clear()

    empty = client.post(
        "/api/exam/solve?filename=exam.png",
        content=b"",
        headers={"content-type": "image/png"},
    )
    assert empty.status_code == 400
    assert empty.json() == {"detail": "exam screenshot is empty"}

    oversize = client.post(
        "/api/exam/solve?filename=exam.png",
        content=b"x" * 64,
        headers={"content-type": "image/png"},
    )
    assert oversize.status_code == 400
    assert "larger than" in oversize.json()["detail"]

    unsupported = client.post(
        "/api/exam/solve?filename=exam.pdf",
        content=b"x",
        headers={"content-type": "application/pdf"},
    )
    assert unsupported.status_code == 400
    assert "unsupported exam screenshot type" in unsupported.json()["detail"]


def test_gateway_exam_solve_returns_solution(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    def fake_solve(filename: str, data: bytes, *, question_hint: str = ""):
        assert filename == "exam.png"
        assert data == b"fake-png"
        assert question_hint == "缓存题"
        return ExamSolution(
            question_summary="实现 LRU 缓存",
            key_points=["能说清 O(1)"],
            reference_answer="哈希表 + 双向链表。",
            source="ocr_text",
            used_fallback=True,
        )

    monkeypatch.setattr("services.gateway.app.solve_exam_screenshot", fake_solve)

    response = client.post(
        "/api/exam/solve?filename=exam.png&question_hint=缓存题",
        content=b"fake-png",
        headers={"content-type": "image/png"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "ocr_text"
    assert payload["key_points"] == ["能说清 O(1)"]


def test_gateway_memory_scan_rejects_paths_outside_the_allowlist(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("MEMORY_ENABLED", "true")
    monkeypatch.setenv("MEMORY_REPO_ROOTS", str(tmp_path / "roots"))
    get_settings.cache_clear()

    response = client.post(f"/api/memory/repos/scan?path={tmp_path / 'elsewhere'}")

    assert response.status_code == 400
    assert "MEMORY_REPO_ROOTS" in response.json()["detail"]


def test_gateway_memory_scan_without_path_scans_configured_roots(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr("services.gateway.app.scan_configured_roots", lambda: {"/repo/a": 3})

    response = client.post("/api/memory/repos/scan")

    assert response.status_code == 200
    assert response.json() == {"scanned": {"/repo/a": 3}}


def test_gateway_memory_candidate_delete_validates_input(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "services.gateway.app.delete_candidate_memories",
        lambda candidate_id: 2,
    )

    response = client.delete("/api/memory/candidates/candidate-1")

    assert response.status_code == 200
    assert response.json() == {"deleted": 2}


def test_cockpit_assets_are_served_with_web_media_types(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    home = client.get("/")
    assert 'href="styles.css"' in home.text
    assert 'src="modules/home.js"' in home.text

    settings = client.get("/settings")
    assert 'href="modules/settings.css"' in settings.text
    assert 'src="modules/settings.js"' in settings.text

    cockpit = client.get("/cockpit")
    assert 'src="modules/app.js"' in cockpit.text

    styles = client.get("/styles.css")
    assert styles.status_code == 200
    assert styles.headers["content-type"] == "text/css; charset=utf-8"

    module = client.get("/modules/app.js")
    assert module.status_code == 200
    assert module.headers["content-type"] == "text/javascript; charset=utf-8"
    settings_module = client.get("/modules/settings.js")
    assert settings_module.status_code == 200
    assert settings_module.headers["content-type"] == "text/javascript; charset=utf-8"


def test_cockpit_asset_route_rejects_traversal_and_unknown_files(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    assert client.get("/modules/nope.js").status_code == 404
    # index.html is inside WEB_ROOT but is not a module: only css/js are served.
    assert client.get("/modules/index.html").status_code == 404
    for escape in ("/modules/../index.html", "/modules/..%2f..%2fpyproject.toml"):
        assert client.get(escape).status_code in {307, 404}, escape


def test_cockpit_ui_records_long_term_memory_consent(tmp_path: Path, monkeypatch) -> None:
    """Long-term memory is silently dropped without consent, so the UI must ask for it.

    distill_interview_memories() returns early unless has_active_consent(candidate,
    "long_term_memory") is true, and quick-setup does not record one — so if the
    cockpit never posts to /api/consents, the cross-interview memory can never exist.
    """
    client = _client(tmp_path, monkeypatch)
    bundle = _served_cockpit_bundle(client, client.get("/cockpit").text)

    assert 'id="longTermMemoryConsent"' in bundle
    assert '"/api/consents"' in bundle
    assert 'consent_type: "long_term_memory"' in bundle


def test_cockpit_ui_exposes_memory_scan_and_per_candidate_delete(
    tmp_path: Path, monkeypatch
) -> None:
    """interview_memories holds real-person data, so deletion must be reachable in the UI."""
    client = _client(tmp_path, monkeypatch)
    bundle = _served_cockpit_bundle(client, client.get("/cockpit").text)

    assert 'id="scanRepoMemory"' in bundle
    assert '"/api/memory/repos/scan"' in bundle
    assert 'id="deleteCandidateMemory"' in bundle
    assert "/api/memory/candidates/" in bundle


def test_cockpit_ui_keeps_audio_speaker_label_visible(tmp_path: Path, monkeypatch) -> None:
    """A mislabelled speaker silently disables probing, so the label cannot be implicit.

    should_probe() ignores any segment whose speaker is not "candidate", so audio
    tagged with the wrong role produces no follow-ups and no error.
    """
    client = _client(tmp_path, monkeypatch)
    bundle = _served_cockpit_bundle(client, client.get("/cockpit").text)

    assert "采集中 · 记为候选人" in bundle
    assert "采集中 · 记为面试官" in bundle


def test_cockpit_ui_pins_latest_answer_above_question_options(
    tmp_path: Path, monkeypatch
) -> None:
    """The suggested questions are only usable next to what the candidate just said."""
    client = _client(tmp_path, monkeypatch)
    bundle = _served_cockpit_bundle(client, client.get("/cockpit").text)

    assert 'id="answerEchoText"' in bundle
    assert "renderAnswerEcho" in bundle
    # Cmd/Ctrl+1..9 promotes the n-th suggestion without reaching for the mouse.
    assert "pickQuestionOptionAt" in bundle


def test_cockpit_shell_exposes_screenshot_and_visibility_controls(
    tmp_path: Path, monkeypatch
) -> None:
    """The overlay is only usable live if screenshot and hide are one click or one chord."""
    client = _client(tmp_path, monkeypatch)
    bundle = _served_cockpit_bundle(client, client.get("/cockpit").text)

    assert 'id="cockpitExam"' in bundle
    assert 'id="cockpitVisible"' in bundle
    assert "toggleVisible" in bundle
    assert "cockpit-host" in bundle
    assert 'id="examDock"' in bundle


def test_gateway_root_is_liuwa_home(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    page = client.get("/")
    assert page.status_code == 200
    assert "左右" in page.text
    assert 'src="modules/home.js"' in page.text
    assert "结束并评分" not in page.text
    assert 'id="liuwaReadingPrev"' in page.text
    assert 'id="liuwaReadingNext"' in page.text
    assert 'aria-label="题解翻页"' in page.text
    # favicon 用 link href；正文里不再重复挂 logo 图片。
    assert page.text.count('modules/pangsi-mark.svg') == 1
    assert 'aria-label="全部快捷键"' in page.text
    assert 'data-key-action="newQuestion"' in page.text
    assert 'data-key-action="toggleWindow"' in page.text
    assert 'data-key-action="clearShots"' in page.text
    assert "/api/chat/stream" in client.get("/modules/home.js").text


def test_gateway_settings_page_keeps_only_current_features(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    page = client.get("/settings")
    assert page.status_code == 200
    for label in ("模型接入", "答题偏好", "面试资料", "快捷键", "学习记录", "岗位信息", "简历信息"):
        assert label in page.text
    for element in ("jdText", "resumeText", "saveUiSettings", "studySpecialty", "studySpecialtyOptions", "studyAnswerStyle", "llmToggleKey"):
        assert f'id="{element}"' in page.text
    assert 'src="modules/settings.js"' in page.text
    assert 'href="modules/settings.css"' in page.text
    assert 'href="styles.css"' not in page.text
    assert 'href="/cockpit"' not in page.text
    assert "<iframe" not in page.text
    assert "检查语音服务" not in page.text
    assert 'id="llmName"' not in page.text
    assert 'value="行测"' in page.text
    assert 'value="申论"' in page.text
    script = client.get("/modules/settings.js").text
    assert "/api/ui/settings" in script
    for action in ("toggleWindow", "clearShots", "quitApp"):
        assert action in script
    css = client.get("/modules/settings.css")
    assert css.status_code == 200
    assert css.headers["content-type"].startswith("text/css")


def test_model_key_reveal_is_explicit_local_authenticated_and_not_cached(tmp_path: Path, monkeypatch) -> None:
    from services.gateway import model_config

    _client(tmp_path, monkeypatch, gateway_api_key="local-access")
    monkeypatch.setenv("LLM_PROFILES_PATH", str(tmp_path / "profiles.json"))
    model_config.save_profile(model_config.ProfileInput(
        llm_model="test-model", llm_base_url="https://model.test/v1", llm_api_key="private-test-key",
    ))
    client = TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000))
    headers = {"x-api-key": "local-access", "origin": "http://127.0.0.1:9958"}
    public = client.get("/api/config/llm/profiles", headers=headers)
    assert "private-test-key" not in public.text
    profile_id = public.json()["active_profile_id"]
    path = f"/api/config/llm/profiles/{profile_id}/key"
    assert client.post(path).status_code == 401
    result = client.post(path, headers=headers)
    assert result.status_code == 200
    assert result.json() == {"llm_api_key": "private-test-key"}
    assert result.headers["cache-control"] == "no-store"
    assert client.post(path, headers={**headers, "origin": "http://evil.test"}).status_code == 403
    assert client.post(path, headers={**headers, "origin": "null"}).status_code == 403
    assert client.post(path, headers={**headers, "sec-fetch-site": "cross-site"}).status_code == 403
    assert client.post("/api/config/llm/profiles/missing/key", headers=headers).status_code == 404
    remote = TestClient(app, base_url="http://127.0.0.1:9958", client=("192.168.1.20", 50000))
    assert remote.post(path, headers=headers).status_code == 403
    rebound = TestClient(app, base_url="http://evil.test", client=("127.0.0.1", 50000))
    assert rebound.post(path, headers={"x-api-key": "local-access"}).status_code == 403


def test_ui_settings_roundtrip_persists_briefing_and_hotkeys(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    empty = client.get("/api/ui/settings")
    assert empty.status_code == 200
    assert empty.json()["hotkeys"]["captureRegion"] == "CommandOrControl+H"
    assert empty.json()["hotkeys"]["sendChat"] == "CommandOrControl+Enter"
    assert empty.json()["hotkeys"]["toggleWindow"] == "CommandOrControl+B"
    assert empty.json()["hotkeys"]["clearShots"] == "CommandOrControl+Shift+Backspace"
    assert empty.json()["hotkeys"]["quitApp"] == "CommandOrControl+Q"
    assert empty.json()["hotkeys"]["newQuestion"] == "CommandOrControl+N"

    payload = {
        "study_specialty": "电子信息",
        "study_language": "C++",
        "study_goal": "算法与专业课复习",
        "study_answer_style": "hints",
        "study_instructions": "先用一个小例子说明",
        "jd_text": "负责 FastAPI 网关",
        "resume_text": "做过 LLM 编排",
        "long_term_memory_consent": True,
        "hotkeys": {
            "toggleVisible": "CommandOrControl+Shift+P",
            "toggleCompact": "CommandOrControl+Shift+J",
            "captureRegion": "CommandOrControl+Shift+U",
            "captureScreen": "CommandOrControl+Shift+Y",
        },
    }
    saved = client.post("/api/ui/settings", json=payload)
    assert saved.status_code == 200
    assert saved.json()["jd_text"] == "负责 FastAPI 网关"
    assert saved.json()["study_specialty"] == "电子信息"
    assert saved.json()["study_answer_style"] == "hints"
    loaded = client.get("/api/ui/settings")
    assert loaded.json() == saved.json()


def test_study_settings_flow_into_chat_without_legacy_personal_data(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    captured = []

    class FakeClient:
        async def stream_text(self, messages):
            captured.extend(messages)
            yield "解题思路"

    monkeypatch.setattr("services.chat_service.service.get_llm_client", lambda: FakeClient())
    client.post("/api/ui/settings", json={
        "study_specialty": "电子信息",
        "study_language": "C++",
        "study_answer_style": "hints",
        "study_instructions": "先举例",
        "resume_text": "不应发送的简历信息",
        "jd_text": "不应发送的岗位信息",
    })
    image = "data:image/png;base64," + base64.b64encode(b"image").decode()
    response = client.post("/api/chat/stream", json={"images": [image]})
    assert response.status_code == 200
    assert "解题思路" in response.text
    context = "\n".join(message.content for message in captured)
    assert "电子信息" in context and "C++" in context
    assert "先举例" in context and "不要给出完整可运行代码" in context
    assert "不应发送" not in context
    assert captured[-1].images == (image,)

    captured.clear()
    client.post("/api/ui/settings", json={"study_specialty": "数学"})
    client.post("/api/chat/stream", json={"text": "继续讲解"})
    assert "数学" in captured[1].content
    assert "电子信息" not in captured[1].content

    captured.clear()
    client.post("/api/ui/settings", json={"study_specialty": "行测", "study_language": "Python", "study_goal": "力扣刷题与笔面试复习"})
    client.post("/api/chat/stream", json={"text": "这道数量关系怎么做"})
    xingce = captured[1].content
    assert "行测" in xingce and "判断推理" in xingce and "不要写程序代码" in xingce
    assert "作答语言：中文" in xingce
    assert "Python" not in xingce and "力扣" not in xingce and "参考代码" not in xingce

    captured.clear()
    client.post("/api/ui/settings", json={"study_specialty": "计算机 / 软件工程", "study_goal": "力扣刷题与笔面试复习"})
    client.post("/api/chat/stream", json={"text": "这段报错什么意思"})
    assert "看懂眼前这段代码或报错" in captured[1].content
    assert "力扣" not in captured[1].content
    assert client.get("/api/ui/settings").json()["study_goal"] == "看懂眼前这段代码或报错"


def test_study_settings_validation_preserves_saved_profile(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post("/api/ui/settings", json={"study_specialty": "软件工程"})
    assert client.post("/api/ui/settings", json={"study_answer_style": "invalid"}).status_code == 422
    assert client.post("/api/ui/settings", json={"study_instructions": "x" * 2001}).status_code == 422
    assert client.get("/api/ui/settings").json()["study_specialty"] == "软件工程"


def test_old_settings_files_receive_study_defaults(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    (tmp_path / "ui_settings.json").write_text('{"jd_text": "existing job"}', encoding="utf-8")
    settings = client.get("/api/ui/settings").json()
    assert settings["jd_text"] == "existing job"
    assert settings["study_answer_style"] == "walkthrough"
    assert settings["study_goal"] == "看懂眼前这段代码或报错"


def test_ui_settings_rejects_invalid_hotkeys(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/ui/settings",
        json={
            "jd_text": "x",
            "resume_text": "y",
            "hotkeys": {
                "toggleVisible": "Space",
                "toggleCompact": "CommandOrControl+Shift+J",
                "captureRegion": "CommandOrControl+Shift+U",
                "captureScreen": "CommandOrControl+Shift+Y",
            },
        },
    )
    assert response.status_code == 422


def test_gateway_chat_stream_mock_sse(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/chat/stream", json={"text": "看这张屏"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    pieces: list[str] = []
    done = False
    for line in response.text.splitlines():
        if not line.startswith("data:"):
            continue
        payload = json.loads(line[5:])
        if payload.get("delta"):
            pieces.append(payload["delta"])
        if payload.get("done"):
            done = True
    assert "解题思路" in "".join(pieces)
    assert done is True


def test_gateway_chat_stream_requires_text_or_images(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/chat/stream", json={})
    assert response.status_code == 422


def test_gateway_chat_stream_rejects_invalid_images(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/chat/stream", json={"images": ["not-a-data-url"]})
    assert response.status_code == 400
    assert "data URL" in response.json()["detail"]


def test_quick_settings_patch_preserves_unrelated_fields(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    before = client.get('/api/ui/settings').json()
    before['study_instructions'] = '保留用户偏好'
    client.post('/api/ui/settings', json=before).raise_for_status()
    saved = client.patch('/api/ui/settings', json={'study_language':'Java','answer_language':'en-US','assistant_role':'interviewer'}).json()
    assert saved['study_language'] == 'Java'
    assert saved['answer_language'] == 'en-US'
    assert saved['assistant_role'] == 'interviewer'
    assert saved['study_instructions'] == '保留用户偏好'
    assert saved['hotkeys']['resetView'] == 'CommandOrControl+R'
    assert client.patch('/api/ui/settings', json={'answer_language':'invalid'}).status_code == 422
    assert client.patch('/api/ui/settings', json={'unknown':True}).status_code == 422
    from libs.schemas import UiSettings
    from services.chat_service.service import study_preface
    preface = study_preface(UiSettings.model_validate(saved))
    assert 'English' in preface and '面试官' in preface and 'Java' in preface


def test_separate_models_are_persisted_and_route_to_the_actual_payload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_PROFILES_PATH", str(tmp_path / "model_profiles.json"))
    (tmp_path/'.env').write_text('LLM_API_KEY=keep-existing-key\nLLM_BASE_URL=https://existing.test/v1\n')
    saved=client.post('/api/config/models',json={'screenshot_model':'provider/vision-v2','interview_model':'provider/text-v3'})
    assert saved.status_code == 200
    from libs.llm_client.client import LLMMessage, _payload_model
    assert _payload_model([LLMMessage(role='user',content='题目',images=('data:image/png;base64,AA==',))]) == 'provider/vision-v2'
    assert _payload_model([LLMMessage(role='user',content='面试问题')]) == 'provider/text-v3'
    raw=(tmp_path/'.env').read_text()
    assert 'LLM_API_KEY=keep-existing-key' in raw and 'VISION_MODEL=provider/vision-v2' in raw
    assert 'LLM_MODEL=provider/text-v3' in raw
    for value in ['bad\nLLM_API_KEY=oops', 'bad #comment','']:
        assert client.post('/api/config/models',json={'screenshot_model':value,'interview_model':'okay'}).status_code == 422
    models=client.get('/api/config/models').json()
    assert 'provider/vision-v2' in models['models']
