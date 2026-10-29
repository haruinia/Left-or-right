from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.datastructures import Headers

from libs.common.config import get_settings
from libs.common.database import init_db
from libs.common.observability import (
    configure_opentelemetry,
    get_rate_limiter,
    log_event,
    metrics_registry,
    request_id_from_header,
    trace_context_from_header,
)
from libs.common.prompts import load_prompt
from libs.common.runtime import RuntimeStatus, get_runtime_status
from libs.common.storage import get_artifact_store
from libs.common.textsim import cosine_similarity, normalize_text
from libs.schemas import (
    AIGCDetectRequest,
    CandidateCreate,
    ConsentCreate,
    CredibilitySignal,
    ExamSolution,
    InterviewCreate,
    JobCreate,
    MemoryHit,
    NextOption,
    OfflineInterviewInput,
    OfflineInterviewResult,
    ProbeResponse,
    OfflineTaskAccepted,
    QuickSetupRequest,
    QuickSetupResponse,
    ProbeRequest,
    ProbeSuggestion,
    QATurn,
    ResumeClaim,
    ReportBuildRequest,
    ScoringRequest,
    SetupExtraction,
    TranscriptSegment,
    ChatStreamRequest,
    UiSettings,
    new_id,
)
from libs.llm_client import LLMMessage, get_llm_client
from services.asr_service.nls_token import AliyunNLSTokenProvider
from services.aigc_detect_service.service import detect_interview
from services.asr_service.service import (
    ASREngine,
    asr_session_manager,
    configure_asr_runtime,
    get_asr_engine,
)
from services.document_service import parse_document
from services.chat_service import iter_chat_deltas
from services.chat_service.service import build_chat_messages
from services.gateway.learning_assets import router as learning_assets_router
from services.gateway import model_config
from services.exam_service import solve_exam_screenshot
from services.memory_service import (
    delete_candidate_memories,
    recall_memories,
    scan_configured_roots,
    scan_repo_memories,
)
from services.interview_orchestrator.dialogue import DialogueAssembler
from services.interview_orchestrator.question_flow import (
    QuestionFlowState,
    fallback_next_options,
    find_option,
    generate_next_options,
    initial_question,
    rebuild_next_options_for_steering,
    suggested_question_key,
)
from services.interview_orchestrator.question_match import match_asked_question
from services.interview_orchestrator.service import (
    add_turn,
    add_utterance,
    create_candidate,
    create_consent,
    create_interview,
    end_interview,
    get_interview,
    get_report,
    get_question_bank,
    get_or_create_candidate,
    has_active_consent,
    save_question_bank,
    save_interview,
    should_probe_turn,
    start_interview,
)
from services.jd_kb_service.service import (
    create_job,
    get_job,
    retrieve_job_probe_patterns,
    update_job_title,
)
from services.probe_service.service import (
    fallback_probe,
    fallback_question_bank,
    generate_probe,
    generate_question_bank,
)
from services.report_service.service import build_report
from services.scoring_service.service import score_interview
from services.signal_service.service import extract_behavior_signal

VALID_SPEAKERS = {"interviewer", "candidate", "unknown"}
SUPPORTED_AUDIO_FORMATS = {
    "pcm",
    "pcm16",
    "pcm-16",
    "linear16",
    "linear-16",
    "s16le",
    "opus",
}
EXPECTED_AUDIO_SAMPLE_RATE_HZ = 16000
EXPECTED_AUDIO_CHANNELS = 1
FALSE_FINALITY_VALUES = {
    "",
    "0",
    "false",
    "no",
    "off",
    "partial",
    "interim",
    "intermediate",
    "non_final",
    "non-final",
    "not_final",
    "not-final",
    "provisional",
}
TRUE_FINALITY_VALUES = {"1", "true", "yes", "on", "final", "finalized", "complete", "completed"}
ALIYUN_AUDIO_CONTEXT_LIMIT = 200
STREAMING_ASR_PROVIDERS = {"aliyun_ws", "aliyun_nls_ws", "sherpa_onnx"}
LOCAL_DEV_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


class _LockedWebSocketSender:
    def __init__(self, websocket: WebSocket) -> None:
        self._websocket = websocket
        self._lock = asyncio.Lock()

    async def send_json(self, payload: dict) -> None:
        async with self._lock:
            await self._websocket.send_json(payload)


# 内容级回声消除：扬声器外放的候选人声音被麦克风拾取后，会以「面试官」身份转写出与
# 候选人近期内容高度相似的文本。用时间窗口 + 文本相似度比对，识别并抑制这种串音回声。
ECHO_SIMILARITY_THRESHOLD = 0.6
ECHO_TIME_WINDOW_MS = 6000
ECHO_REF_BUFFER = 16


@dataclass
class _DialogueSessionRuntime:
    assembler: DialogueAssembler
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    senders: set[_LockedWebSocketSender] = field(default_factory=set)
    epoch: int = 0
    flush_task: asyncio.Task[None] | None = None
    question_flow: QuestionFlowState | None = None
    # 候选人近期转写的 (归一化文本, end_ms)，供麦克风路做回声比对。
    recent_candidate: list[tuple[str, int]] = field(default_factory=list)

    async def send_json(self, payload: dict) -> None:
        stale: list[_LockedWebSocketSender] = []
        for sender in tuple(self.senders):
            try:
                await sender.send_json(payload)
            except Exception:
                stale.append(sender)
        for sender in stale:
            self.senders.discard(sender)


_dialogue_runtimes: dict[str, _DialogueSessionRuntime] = {}


def _dialogue_runtime(interview_id: str, silence_close_ms: int) -> _DialogueSessionRuntime:
    runtime = _dialogue_runtimes.get(interview_id)
    if runtime is None:
        runtime = _DialogueSessionRuntime(
            assembler=DialogueAssembler(silence_close_ms=silence_close_ms)
        )
        _dialogue_runtimes[interview_id] = runtime
    return runtime


def _discard_dialogue_runtime(interview_id: str, runtime: _DialogueSessionRuntime) -> None:
    if _dialogue_runtimes.get(interview_id) is runtime:
        _dialogue_runtimes.pop(interview_id, None)


def _suppress_candidate_echo(runtime: _DialogueSessionRuntime, segment: TranscriptSegment) -> bool:
    """跨双声道的内容级回声消除。

    候选人语音从扬声器外放、被麦克风拾取后，会以 speaker=interviewer 转写出与候选人
    近期内容几乎一致的文本。这里把候选人(扬声器)转写存入参考缓冲，麦克风(面试官)转写
    到达时与时间窗口内的候选人文本比对相似度，超过阈值即判定为串音回声并抑制。

    仅在接入了会议声音(存在候选人参考路)时才会真正生效；纯麦克风场景缓冲为空，永不抑制。
    返回 True 表示该 segment 是回声、应丢弃。这是同步函数，在单线程事件循环中原子执行。
    """
    text = normalize_text(segment.text)
    if not text:
        return False
    if segment.speaker == "candidate":
        runtime.recent_candidate.append((text, segment.end_ms))
        if len(runtime.recent_candidate) > ECHO_REF_BUFFER:
            del runtime.recent_candidate[:-ECHO_REF_BUFFER]
        return False
    if segment.speaker == "interviewer":
        for cand_text, cand_end in runtime.recent_candidate:
            if abs(segment.end_ms - cand_end) > ECHO_TIME_WINDOW_MS:
                continue
            if cosine_similarity(text, cand_text) >= ECHO_SIMILARITY_THRESHOLD:
                return True
    return False


async def _send_initial_question_if_available(
    sender: _LockedWebSocketSender,
    runtime: _DialogueSessionRuntime,
    interview_id: str,
    record,
):
    current: NextOption | None = None
    async with runtime.lock:
        if runtime.question_flow is None:
            try:
                bank = get_question_bank(interview_id)
            except KeyError:
                return record
            runtime.question_flow = QuestionFlowState(
                bank=bank,
                current_question=initial_question(bank),
                steering=record.context.question_steering,
            )
        else:
            runtime.question_flow.steering = record.context.question_steering
        current = runtime.question_flow.current_question
    if current is not None:
        if _register_suggested_questions(record, [current]):
            save_interview(record)
        await sender.send_json({"type": "current_question", "payload": current.model_dump()})
    return record


def _register_suggested_questions(record, options: list[NextOption]) -> bool:
    existing = set(record.context.suggested_question_keys)
    changed = False
    for option in options:
        key = suggested_question_key(option)
        if key and key not in existing:
            record.context.suggested_question_keys.append(key)
            existing.add(key)
            changed = True
    return changed


@dataclass(frozen=True)
class _AliyunAudioContext:
    seq: int
    start_ms: int
    end_ms: int
    audio_b64: str
    speaker_hint: str | None
    question: str
    question_source: str
    probe_target: str | None
    probe_chain_id: str | None


# Dual-path capture sends the interviewer's microphone and the candidate's
# loopback audio at the same time. A streaming ASR session is a single decoder
# over a single PCM timeline, so interleaving two speakers into one session both
# corrupts the decode and makes the time-overlap context matching below
# ambiguous. Each capture channel therefore gets its own session, reader task,
# result counter and context window.
@dataclass
class _AliyunChannel:
    key: str
    stream_id: str
    speaker_hint: str | None
    session: object | None = None
    reader_task: "asyncio.Task[None] | None" = None
    result_seq: int = 1
    contexts: list[_AliyunAudioContext] = field(default_factory=list)


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    configure_opentelemetry(fastapi_app, get_settings())
    configure_asr_runtime()
    init_db()
    try:
        profiles, active = model_config.load_store()
        profile = next((item for item in profiles if item.id == active), None)
        if profile is not None:
            model_config.apply_profile(profile)
    except (OSError, ValueError):
        # A damaged profile store must not stop the gateway; .env remains usable.
        pass
    yield


app = FastAPI(title="Shuihuo Killer", version="0.1.0", lifespan=lifespan)
app.include_router(learning_assets_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "file://"],  # Electron loadFile 的本地页面来源
    allow_origin_regex=LOCAL_DEV_ORIGIN_REGEX,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
WEB_ROOT = Path(__file__).resolve().parents[2] / "web"
WEB_INDEX = WEB_ROOT / "index.html"
WEB_SETTINGS = WEB_ROOT / "settings.html"
WEB_COCKPIT = WEB_ROOT / "cockpit.html"
app.mount("/vendor", StaticFiles(directory=WEB_ROOT / "vendor"), name="vendor")
WEB_ASSET_MEDIA_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


def _client_key(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", maxsplit=1)[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def _route_path(request: Request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", request.url.path)


def _extract_gateway_api_key(headers: Headers, query_key: str | None = None) -> str:
    header_key = headers.get("x-api-key", "")
    if header_key:
        return header_key
    authorization = headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    websocket_key = _extract_websocket_protocol_key(headers)
    if websocket_key:
        return websocket_key
    return query_key or ""


def _extract_websocket_protocol_key(headers: Headers) -> str:
    protocols = headers.get("sec-websocket-protocol", "")
    for protocol in protocols.split(","):
        item = protocol.strip()
        if not item.startswith("gateway-key."):
            continue
        encoded = item.removeprefix("gateway-key.")
        try:
            padding = "=" * (-len(encoded) % 4)
            return base64.urlsafe_b64decode(f"{encoded}{padding}").decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return ""
    return ""


def _gateway_authorized(headers: Headers, expected_key: str, query_key: str | None = None) -> bool:
    if not expected_key:
        return True
    return _extract_gateway_api_key(headers, query_key) == expected_key


@app.middleware("http")
async def observe_and_rate_limit(request: Request, call_next):
    settings = get_settings()
    start = perf_counter()
    status_code = 500
    request_id = request_id_from_header(request.headers.get("x-request-id"))
    trace_context = trace_context_from_header(request.headers.get("traceparent"))
    path = request.url.path
    if request.method != "OPTIONS" and request.url.path.startswith("/api/") and not _gateway_authorized(
        request.headers,
        settings.gateway_api_key,
        request.query_params.get("api_key"),
    ):
        status_code = 401
        duration = perf_counter() - start
        response = PlainTextResponse(
            "unauthorized",
            status_code=status_code,
            headers={"X-Request-ID": request_id, "traceparent": trace_context.traceparent},
        )
        metrics_registry.record_request(
            request.method, path, status_code, duration
        )
        log_event(
            "http.request",
            request_id=request_id,
            trace_id=trace_context.trace_id,
            span_id=trace_context.span_id,
            method=request.method,
            path=path,
            status_code=status_code,
            duration_seconds=round(duration, 6),
        )
        return response

    if settings.rate_limit_enabled:
        decision = get_rate_limiter(settings).check(_client_key(request))
        if not decision.allowed:
            status_code = 429
            duration = perf_counter() - start
            response = PlainTextResponse(
                "rate limit exceeded",
                status_code=status_code,
                headers={
                    "Retry-After": str(decision.retry_after_seconds),
                    "X-Request-ID": request_id,
                    "traceparent": trace_context.traceparent,
                },
            )
            metrics_registry.record_request(
                request.method, path, status_code, duration
            )
            log_event(
                "http.request",
                request_id=request_id,
                trace_id=trace_context.trace_id,
                span_id=trace_context.span_id,
                method=request.method,
                path=path,
                status_code=status_code,
                duration_seconds=round(duration, 6),
            )
            return response

    try:
        response: Response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Request-ID"] = request_id
        response.headers["traceparent"] = trace_context.traceparent
        return response
    finally:
        duration = perf_counter() - start
        route_path = _route_path(request)
        metrics_registry.record_request(
            request.method, route_path, status_code, duration
        )
        log_event(
            "http.request",
            request_id=request_id,
            trace_id=trace_context.trace_id,
            span_id=trace_context.span_id,
            method=request.method,
            path=route_path,
            status_code=status_code,
            duration_seconds=round(duration, 6),
        )


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "shuihuo-killer-gateway",
        "version": app.version,
    }


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> str:
    return metrics_registry.render_prometheus()


@app.get("/api/config/status", response_model=RuntimeStatus)
def config_status() -> RuntimeStatus:
    return get_runtime_status()


@app.get("/api/config/llm/profiles")
def llm_profiles():
    return model_config.list_response()


@app.post("/api/config/llm/profiles/{profile_id}/key")
def reveal_llm_key(profile_id: str, request: Request):
    from ipaddress import ip_address

    try:
        local_client = request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        local_client = False
    origin = request.headers.get("origin")
    if (
        not local_client
        or request.url.hostname not in {"127.0.0.1", "localhost", "::1"}
        or request.headers.get("sec-fetch-site") == "cross-site"
        or (origin and origin.rstrip("/") != str(request.base_url).rstrip("/"))
    ):
        raise HTTPException(status_code=403, detail="密钥只能在本机设置页面查看")
    try:
        key = model_config.profile_api_key(profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return JSONResponse({"llm_api_key": key}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@app.post("/api/config/llm", response_model=RuntimeStatus)
def update_llm_config(payload: model_config.ProfileInput) -> RuntimeStatus:
    """保存并启用一套模型接入配置；密钥只写在本机私有存储。"""
    if not payload.llm_model.strip():
        raise HTTPException(status_code=422, detail="模型名不能为空")
    if not payload.llm_base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="接口地址必须以 http:// 或 https:// 开头")
    try:
        model_config.save_profile(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="模型配置保存失败，请重试") from exc
    # 兼容只读 .env 的旧路径：主配置仍以模型配置文件为准。
    updates = {
        "LLM_PROVIDER": "openai_compatible",
        "LLM_MODEL": payload.llm_model.strip(),
        "LLM_BASE_URL": payload.llm_base_url.strip().rstrip("/"),
    }
    if payload.llm_api_key.strip():
        updates["LLM_API_KEY"] = payload.llm_api_key.strip()
    try:
        _persist_env_updates(updates)
    except OSError:
        pass
    return get_runtime_status()


@app.post("/api/config/llm/activate")
def activate_llm_profile(payload: dict):
    try:
        return model_config.activate_profile(str(payload.get("profile_id", "")))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/api/config/llm/profiles/{profile_id}")
def delete_llm_profile(profile_id: str):
    try:
        return model_config.delete_profile(profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/config/llm/import")
def import_llm_profiles(payload: model_config.ImportPayload):
    try:
        return model_config.import_profiles(payload.config)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="导入保存失败，请重试") from exc


def _persist_env_updates(updates: dict[str, str]) -> None:
    path = Path(".env")
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    replaced: set[str] = set()
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else None
        if key in updates:
            output.append(f"{key}={updates[key]}")
            replaced.add(key)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in replaced:
            output.append(f"{key}={value}")
    handle, temp_name = tempfile.mkstemp(dir=path.parent or Path("."), prefix=".env-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write("\n".join(output) + "\n")
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


class ModelSelection(BaseModel):
    screenshot_model: str
    interview_model: str


def _model_selection() -> dict:
    settings = get_settings()
    return {"screenshot_model": settings.vision_model or settings.llm_model, "interview_model": settings.llm_model}


@app.get("/api/config/models")
async def available_models():
    selected = _model_selection()
    warning = ""
    try:
        models = await get_llm_client().list_models()
    except Exception:
        models = []
        warning = "当前接口未提供模型列表，可输入该接口支持的模型名称。"
    return {**selected, "models": sorted(set(models) | set(selected.values())), "warning": warning}


@app.post("/api/config/models")
def select_models(payload: ModelSelection):
    values = {key: value.strip() for key, value in payload.model_dump().items()}
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,159}", value) for value in values.values()):
        raise HTTPException(422, "请输入有效的模型名称")
    try:
        model_config.update_models(values["screenshot_model"], values["interview_model"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "模型设置保存失败，请重试") from exc
    # 模型名同时写回 .env：旧脚本和未迁移的部署仍按这两个变量读取。
    try:
        _persist_env_updates(
            {"VISION_MODEL": values["screenshot_model"], "LLM_MODEL": values["interview_model"]}
        )
    except OSError as exc:
        raise HTTPException(503, "模型设置保存失败，请重试") from exc
    return _model_selection()


@app.post("/api/config/llm/check")
async def check_llm_connection() -> dict[str, str | bool]:
    status = get_runtime_status()
    if status.llm_provider == "mock":
        return {
            "ok": False,
            "mode": "mock",
            "message": "当前是模型模拟模式，没有调用真实模型。",
        }
    if not status.llm_base_url_configured or not status.llm_api_key_configured:
        return {
            "ok": False,
            "mode": "incomplete",
            "message": "模型配置不完整，请检查 LLM_BASE_URL 和 LLM_API_KEY。",
        }
    fallback = ProbeResponse(
        suggestions=[
            ProbeSuggestion(
                question="fallback",
                target="fallback",
                competency="fallback",
                priority=1,
            )
        ],
        credibility=CredibilitySignal(level="vague", reason="fallback", drill_down_hint="fallback"),
    )
    try:
        response = await get_llm_client().complete_json(
            [
                LLMMessage(
                    role="system",
                    content=(
                        "Return only a JSON object with this exact shape: "
                        '{"suggestions":[{"question":"...","target":"...","competency":"...",'
                        '"priority":1}],"credibility":{"level":"solid","reason":"...",'
                        '"drill_down_hint":"..."}}. The credibility.level must be one of '
                        "solid, vague, suspicious."
                    ),
                ),
                LLMMessage(
                    role="user",
                    content="Generate one concise interview probe question for an LLM connection check.",
                ),
            ],
            ProbeResponse,
            fallback,
            raise_on_error=True,
        )
    except RuntimeError as exc:
        return {"ok": False, "mode": "error", "message": _safe_public_error(str(exc))}
    if response == fallback:
        return {
            "ok": False,
            "mode": "fallback",
            "message": "真实模型调用未得到有效 JSON 响应，请检查 provider 协议和响应字段路径。",
        }
    return {
        "ok": True,
        "mode": "live",
        "message": f"真实模型连接正常：{status.llm_provider} / {status.llm_model}",
    }


def _safe_public_error(message: str) -> str:
    cleaned = " ".join(message.split())
    for secret in _configured_secret_values():
        cleaned = cleaned.replace(secret, "***")
    if "HTTP " in cleaned:
        return cleaned[cleaned.index("HTTP ") :].split(":", maxsplit=1)[0]
    return cleaned[:240] or "unknown LLM error"


def _configured_secret_values() -> list[str]:
    try:
        settings = get_settings()
    except Exception:
        return []
    return [
        secret
        for secret in {
            settings.llm_api_key,
            settings.asr_api_key,
            settings.aliyun_asr_api_key,
            settings.aliyun_nls_token,
            settings.aliyun_ak_secret,
            settings.speaker_diarization_api_key,
            settings.aigc_detector_api_key,
            settings.gateway_api_key,
        }
        if len(secret.strip()) >= 4
    ]


@app.post("/api/config/asr/check")
async def check_asr_readiness() -> dict[str, str | bool]:
    settings = get_settings()
    status = get_runtime_status()
    if status.asr_provider == "stub":
        return {
            "ok": False,
            "mode": "stub",
            "message": "当前是 ASR 模拟模式，没有调用真实语音识别。",
        }
    if status.asr_provider == "http":
        if not status.asr_base_url_configured:
            return {
                "ok": False,
                "mode": "incomplete",
                "message": "HTTP ASR 配置不完整，请检查 ASR_BASE_URL。",
            }
        return {
            "ok": True,
            "mode": "configured",
            "message": "HTTP ASR 基本配置存在；此检查未发送测试音频。",
        }
    if status.asr_provider == "aliyun_ws":
        try:
            import websockets  # noqa: F401
        except ImportError:
            return {
                "ok": False,
                "mode": "missing_dependency",
                "message": "ASR WebSocket 依赖缺失，请重新安装依赖。",
            }
        if not status.aliyun_asr_api_key_configured or not status.aliyun_asr_endpoint_configured:
            return {
                "ok": False,
                "mode": "incomplete",
                "message": "阿里云 DashScope ASR 配置不完整，请检查 API Key 和 Endpoint。",
            }
        return {
            "ok": True,
            "mode": "configured",
            "message": "阿里云 DashScope ASR 基本配置存在；此检查未打开识别会话。",
        }
    if status.asr_provider == "aliyun_nls_ws":
        try:
            import websockets  # noqa: F401
        except ImportError:
            return {
                "ok": False,
                "mode": "missing_dependency",
                "message": "ASR WebSocket 依赖缺失，请重新安装依赖。",
            }
        if not status.aliyun_nls_app_key_configured or not status.aliyun_nls_endpoint_configured:
            return {
                "ok": False,
                "mode": "incomplete",
                "message": "阿里云 NLS ASR 配置不完整，请检查 AppKey 和 Endpoint。",
            }
        if status.aliyun_nls_token_configured:
            if status.aliyun_nls_token_auto_configured:
                try:
                    token = await asyncio.to_thread(
                        AliyunNLSTokenProvider(
                            access_key_id=settings.aliyun_ak_id,
                            access_key_secret=settings.aliyun_ak_secret,
                            endpoint=settings.aliyun_nls_token_endpoint,
                            region_id=settings.aliyun_nls_token_region,
                        ).get_token
                    )
                except Exception as exc:
                    return {
                        "ok": True,
                        "mode": "fixed_token",
                        "message": _safe_public_error(
                            f"阿里云 NLS ASR 固定 Token 已配置；AK 自动 Token 创建失败: {exc}"
                        ),
                    }
                if token.strip():
                    return {
                        "ok": True,
                        "mode": "fixed_token_auto_ready",
                        "message": "阿里云 NLS ASR 就绪：固定 Token 已配置，AK 自动 Token 可生成；固定 Token 被拒绝时会自动刷新重试。",
                    }
            return {
                "ok": True,
                "mode": "fixed_token",
                "message": "阿里云 NLS ASR 基本配置存在：固定 Token 已配置；此轻量检查不打开音频识别会话。",
            }
        if status.aliyun_nls_token_auto_configured:
            try:
                token = await asyncio.to_thread(
                    AliyunNLSTokenProvider(
                        access_key_id=settings.aliyun_ak_id,
                        access_key_secret=settings.aliyun_ak_secret,
                        endpoint=settings.aliyun_nls_token_endpoint,
                        region_id=settings.aliyun_nls_token_region,
                    ).get_token
                )
            except Exception as exc:
                return {
                    "ok": False,
                    "mode": "token_error",
                    "message": _safe_public_error(f"NLS Token 创建失败: {exc}"),
                }
            if token.strip():
                return {
                    "ok": True,
                    "mode": "token_ready",
                    "message": "阿里云 NLS ASR 就绪：WebSocket 依赖存在，自动 Token 可生成。",
                }
        return {
            "ok": False,
            "mode": "incomplete",
            "message": "阿里云 NLS ASR 缺少 Token，请配置固定 Token 或 AK 自动 Token。",
        }
    if status.asr_provider == "sherpa_onnx":
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError:
            return {
                "ok": False,
                "mode": "missing_dependency",
                "message": '本地 ASR 依赖缺失，请执行：pip install -e ".[sherpa]"',
            }
        if not status.sherpa_asr_model_ready:
            return {
                "ok": False,
                "mode": "incomplete",
                "message": (
                    "本地 sherpa-onnx 模型未就绪。"
                    "请运行：python scripts/download_sherpa_asr_model.py"
                ),
            }
        return {
            "ok": True,
            "mode": "configured",
            "message": (
                f"本地 sherpa-onnx ASR 就绪（{status.sherpa_asr_provider} / "
                f"{status.sherpa_asr_sample_rate} Hz）。"
            ),
        }
    return {"ok": False, "mode": "unknown", "message": "ASR provider 状态未知。"}


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return WEB_INDEX.read_text(encoding="utf-8")


@app.get("/settings", response_class=HTMLResponse)
@app.get("/settings.html", response_class=HTMLResponse)
def settings_page() -> str:
    return WEB_SETTINGS.read_text(encoding="utf-8")


@app.get("/cockpit", response_class=HTMLResponse)
def cockpit() -> str:
    return WEB_COCKPIT.read_text(encoding="utf-8")


def _ui_settings_path() -> Path:
    raw = get_settings().database_url
    if raw.startswith("sqlite:///"):
        db_path = Path(raw.removeprefix("sqlite:///"))
        if str(db_path) not in {":memory:", ""}:
            return db_path.parent / "ui_settings.json"
    return Path("data") / "ui_settings.json"


# 旧版默认键位。存档里出现这些值，说明用户从没改过、只是旧默认被写进去了；
# 不迁移的话新默认（⌘H / ⌘Enter / ⌘B …）会被旧值覆盖，改代码等于没改。
_LEGACY_HOTKEYS = {
    "captureRegion": "CommandOrControl+Shift+U",
    "sendChat": "CommandOrControl+Shift+Enter",
    "toggleWindow": "CommandOrControl+Shift+H",
    "quitApp": "CommandOrControl+Shift+Q",
    "newQuestion": "CommandOrControl+Shift+N",
    "clearShots": "CommandOrControl+Shift+Backspace",
    "readPrev": "CommandOrControl+Shift+Left",
    "readNext": "CommandOrControl+Shift+Right",
    "scrollUp": "CommandOrControl+Shift+Up",
    "scrollDown": "CommandOrControl+Shift+Down",
    "moveUp": "CommandOrControl+Shift+Alt+Up",
    "moveDown": "CommandOrControl+Shift+Alt+Down",
    "moveLeft": "CommandOrControl+Shift+Alt+Left",
    "moveRight": "CommandOrControl+Shift+Alt+Right",
}


def _read_ui_settings() -> UiSettings:
    path = _ui_settings_path()
    raw: dict = {}
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
    hotkeys = raw.get("hotkeys")
    if isinstance(hotkeys, dict) and raw.get("_hotkeys_version", 1) < 2:
        # 只丢掉「还是旧默认值」的项，用户真改过的不动。
        migrated = {
            action: value
            for action, value in hotkeys.items()
            if _LEGACY_HOTKEYS.get(action) != value
        }
        if migrated != hotkeys:
            raw["hotkeys"] = migrated
    try:
        settings = UiSettings.model_validate(raw) if raw else UiSettings()
    except Exception:
        settings = UiSettings()
    if settings.study_goal.strip() == "力扣刷题与笔面试复习":
        settings.study_goal = "看懂眼前这段代码或报错"
    return settings


@app.get("/api/ui/settings", response_model=UiSettings)
def get_ui_settings() -> UiSettings:
    return _read_ui_settings()


@app.post("/api/ui/settings", response_model=UiSettings)
def save_ui_settings(payload: UiSettings) -> UiSettings:
    try:
        payload.hotkeys.validate_unique()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    path = _ui_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 只迁移旧版默认值；用户在新版显式保存旧组合键时，读取不能再把它改掉。
    stored = {**payload.model_dump(), "_hotkeys_version": 2}
    path.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


@app.patch("/api/ui/settings", response_model=UiSettings)
def patch_ui_settings(payload: dict):
    if set(payload) - set(UiSettings.model_fields):
        raise HTTPException(422, "未知设置项")
    current = _read_ui_settings().model_dump()
    if isinstance(payload.get("hotkeys"), dict):
        payload = {**payload, "hotkeys": {**current["hotkeys"], **payload["hotkeys"]}}
    try:
        settings = UiSettings.model_validate({**current, **payload})
    except ValueError as exc:
        raise HTTPException(422, "设置值无效") from exc
    return save_ui_settings(settings)


@app.get("/styles.css")
@app.get("/modules/{name}")
def web_asset(request: Request, name: str = "") -> Response:
    """Serve the split cockpit assets that index.html references.

    The path is resolved under WEB_ROOT and rejected if it escapes, so a crafted
    `name` cannot read files elsewhere on disk.
    """
    relative = f"modules/{name}" if name else "styles.css"
    target = (WEB_ROOT / relative).resolve()
    if not target.is_file() or WEB_ROOT.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail="asset not found")
    media_type = WEB_ASSET_MEDIA_TYPES.get(target.suffix)
    if media_type is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return Response(target.read_text(encoding="utf-8"), media_type=media_type)


def _probe_request_for_turn(
    record,
    turn: QATurn,
    memory_hits: list[MemoryHit] | None = None,
) -> ProbeRequest:
    return ProbeRequest(
        job_id=record.job_id,
        competency_model=record.context.competency_model,
        recent_turns=record.context.turns[-5:],
        latest_answer=turn.answer,
        resume_claims=_resume_claims_for_probe(record),
        probe_chains=record.context.probe_chains,
        memory_hits=memory_hits or [],
    )


def _recall_memory_hits(record, turn: QATurn) -> list[MemoryHit]:
    """Recall project/past-interview memory for this answer. Never fails the probe path."""
    if not get_settings().memory_enabled:
        return []
    query = f"{turn.question} {turn.answer}".strip()
    try:
        return recall_memories(query, exclude_interview_id=record.id)
    except Exception:
        return []


def _resume_claims_for_probe(record) -> list[ResumeClaim]:
    markers = ("独立", "主导", "负责", "提升", "优化", "上线", "%", "qps", "ms", "指标")
    claims: list[ResumeClaim] = []
    for raw in re.split(r"[。\n；;]", record.context.candidate_resume_text):
        text = raw.strip()
        if len(text) < 8 or not any(marker in text for marker in markers):
            continue
        tags = [marker for marker in markers if marker in text][:4]
        claims.append(ResumeClaim(text=text, tags=tags or ["resume"]))
        if len(claims) >= 5:
            break
    return claims


async def _refine_question_bank_in_background(
    interview_id: str,
    jd_text: str,
    resume_text: str,
    competency_model,
    fallback_bank,
) -> None:
    try:
        refined = await generate_question_bank(
            interview_id, jd_text, resume_text, competency_model
        )
    except Exception:
        return
    # 按题目内容比较：mock/兜底场景下重新生成的题库只有随机 id 不同，不应覆盖
    def bank_signature(bank) -> list[tuple[str, str, str]]:
        return [(item.question, item.category, item.basis) for item in bank.items]

    if bank_signature(refined) == bank_signature(fallback_bank):
        return
    try:
        # 保留兜底题库中已经被问过的题（按题面匹配）
        current = get_question_bank(interview_id)
        asked_questions = {item.question.strip() for item in current.items if item.asked}
        if asked_questions:
            refined = refined.model_copy(
                update={
                    "items": [
                        item.model_copy(update={"asked": item.question.strip() in asked_questions})
                        for item in refined.items
                    ]
                }
            )
        save_question_bank(refined)
    except (KeyError, ValueError):
        return
    runtime = _dialogue_runtimes.get(interview_id)
    if runtime is None:
        return
    async with runtime.lock:
        if runtime.question_flow is not None:
            runtime.question_flow.bank = refined
    await runtime.send_json(
        {"type": "question_bank_update", "payload": refined.model_dump()}
    )


def _provisional_job_title(jd_text: str) -> str:
    first_line = next((line.strip() for line in jd_text.splitlines() if line.strip()), "")
    return first_line[:40] or "未命名岗位"


def _extract_quick_setup_fields(payload: QuickSetupRequest) -> tuple[SetupExtraction, bool]:
    fallback = SetupExtraction(job_title="未命名岗位", candidate_name="候选人")
    messages = [
        LLMMessage(role="system", content=load_prompt("setup_extract.md")),
        LLMMessage(
            role="user",
            content=json.dumps(
                {"jd_text": payload.jd_text, "resume_text": payload.resume_text},
                ensure_ascii=False,
            ),
        ),
    ]
    client = get_llm_client()
    if hasattr(client, "complete_json_sync_with_meta"):
        extraction, used_fallback = client.complete_json_sync_with_meta(
            messages,
            SetupExtraction,
            fallback,
        )
    else:
        extraction = client.complete_json_sync(messages, SetupExtraction, fallback)
        used_fallback = extraction == fallback
    confident = (
        not used_fallback
        and extraction.job_title != "未命名岗位"
        and extraction.candidate_name != "候选人"
    )
    return extraction, confident


def _schedule_probe_task(
    runtime: _DialogueSessionRuntime,
    record,
    turn: QATurn,
) -> None:
    request = _probe_request_for_turn(record, turn)

    async def _run() -> None:
        try:
            fallback = fallback_probe(request)
        except Exception:
            return
        await runtime.send_json({"type": "probe", "payload": fallback.model_dump()})
        await runtime.send_json(
            {"type": "credibility", "payload": fallback.credibility.model_dump()}
        )
        signal = (
            extract_behavior_signal(turn)
            if record.signal_enabled and has_active_consent(record.candidate_id, "behavior_signal")
            else None
        )
        if signal is not None:
            await runtime.send_json({"type": "signal", "payload": signal.model_dump()})
        memory_hits = await asyncio.to_thread(_recall_memory_hits, record, turn)
        if memory_hits:
            await runtime.send_json(
                {
                    "type": "memory_hits",
                    "payload": {
                        "interview_id": record.id,
                        "turn_id": turn.turn_id,
                        "items": [hit.model_dump() for hit in memory_hits],
                    },
                }
            )
        try:
            probe = await generate_probe(
                _probe_request_for_turn(record, turn, memory_hits) if memory_hits else request
            )
        except Exception:
            return
        if probe.model_dump() != fallback.model_dump():
            await runtime.send_json({"type": "probe_update", "payload": probe.model_dump()})

    asyncio.create_task(_run())


def _schedule_next_options_update(
    runtime: _DialogueSessionRuntime,
    record,
    turn: QATurn,
    fallback_options,
) -> None:
    async def _run() -> None:
        if runtime.question_flow is None:
            return
        try:
            memory_hits = await asyncio.to_thread(_recall_memory_hits, record, turn)
            refined = await generate_next_options(
                record,
                runtime.question_flow.bank,
                turn,
                fallback_options,
                memory_hits,
            )
        except Exception:
            return
        if refined.model_dump() == fallback_options.model_dump():
            return
        async with runtime.lock:
            if runtime.question_flow is None:
                return
            runtime.question_flow.last_options = refined
        try:
            latest_record = get_interview(record.id)
            if _register_suggested_questions(
                latest_record,
                [*refined.follow_up, *refined.alternatives],
            ):
                save_interview(latest_record)
        except (KeyError, ValueError):
            return
        await runtime.send_json({"type": "next_options_update", "payload": refined.model_dump()})

    asyncio.create_task(_run())


def _manual_probe_segment(interview_id: str, event: dict) -> TranscriptSegment:
    text = str(event.get("answer") or event.get("latest_answer") or "").strip()
    start_ms = _manual_probe_int(event, "start_ms", 0)
    end_ms = _manual_probe_int(event, "end_ms", start_ms)
    if end_ms < start_ms:
        raise ValueError("manual_probe end_ms must be greater than or equal to start_ms")
    return TranscriptSegment(
        session_id=interview_id,
        speaker="candidate",
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        is_final=True,
        confidence=_manual_probe_confidence(event),
    )


def _manual_probe_int(event: dict, key: str, default: int) -> int:
    value = event.get(key)
    if value is None or value == "":
        return default
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        raise ValueError(f"manual_probe {key} must be a non-negative integer") from None
    if parsed < 0:
        raise ValueError(f"manual_probe {key} must be a non-negative integer")
    return parsed


def _manual_probe_confidence(event: dict) -> float:
    value = event.get("confidence")
    if value is None or value == "":
        return 1.0
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        raise ValueError("manual_probe confidence must be a number") from None
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("manual_probe confidence must be between 0 and 1")
    return confidence


def _event_question(event: dict) -> str:
    return str(event.get("question") or "实时输入片段").strip() or "实时输入片段"


def _event_question_source(event: dict) -> str:
    return "ai_probe" if str(event.get("question_source") or "").strip() == "ai_probe" else "interviewer"


def _event_probe_target(event: dict) -> str | None:
    value = str(event.get("probe_target") or "").strip()
    return value or None


def _event_probe_chain_id(event: dict) -> str | None:
    value = str(event.get("chain_id") or event.get("probe_chain_id") or "").strip()
    return value or None


def _aliyun_warning_reason(exc: Exception) -> str:
    reason = str(exc).strip()
    return reason if reason.startswith("aliyun_asr_") else "aliyun_asr_connect_failed"


def _asr_warning_reason(exc: Exception) -> str:
    reason = str(exc).strip()
    if reason.startswith("aliyun_asr_"):
        return reason
    return "asr_transcription_failed"


def _select_aliyun_audio_context(
    contexts: list[_AliyunAudioContext],
    segment: TranscriptSegment,
) -> _AliyunAudioContext | None:
    if not contexts:
        return None

    def score(context: _AliyunAudioContext) -> tuple[int, int, int]:
        overlap = min(context.end_ms, segment.end_ms) - max(context.start_ms, segment.start_ms)
        if overlap >= 0:
            return (2, overlap, context.seq)
        if context.end_ms <= segment.start_ms:
            return (1, -abs(segment.start_ms - context.end_ms), context.seq)
        return (0, -abs(context.start_ms - segment.end_ms), context.seq)

    return max(contexts, key=score)


async def _send_asr_warning(websocket: WebSocket, reason: str, seq: int) -> None:
    await websocket.send_json({"type": "asr_warning", "payload": {"reason": reason, "seq": seq}})


async def _transcribe_or_warn(
    websocket: WebSocket,
    engine: ASREngine,
    *,
    seq: int,
    session_id: str,
    audio_b64: str,
    speaker: str | None = None,
    start_ms: object = None,
    end_ms: object = None,
    is_final: bool = True,
    confidence: object = None,
) -> TranscriptSegment | None:
    try:
        return await engine.transcribe_chunk(
            session_id=session_id,
            seq=seq,
            audio_b64=audio_b64,
            speaker=speaker,
            start_ms=start_ms,
            end_ms=end_ms,
            is_final=is_final,
            confidence=confidence,
        )
    except (httpx.HTTPError, KeyError, RuntimeError, TypeError, ValueError) as exc:
        log_event(
            "asr.transcription.failed",
            seq=seq,
            session_id=session_id,
            error_type=type(exc).__name__,
        )
        await _send_asr_warning(websocket, _asr_warning_reason(exc), seq)
        return None


def _event_speaker(event: dict) -> str | None:
    speaker = event.get("speaker")
    if speaker in VALID_SPEAKERS:
        return str(speaker)
    channel = _event_channel(event)
    if channel is None:
        return None
    settings = get_settings()
    if channel in _channel_aliases(settings.asr_interviewer_channels):
        return "interviewer"
    if channel in _channel_aliases(settings.asr_candidate_channels):
        return "candidate"
    return None


def _event_channel(event: dict) -> str | None:
    for key in ("channel", "audio_channel", "track"):
        if key in event and event[key] is not None:
            return str(event[key]).strip().lower()
    return None


# The transport key for dual-path capture. It is deliberately the same field the
# existing single-source client already sends ("channel" carries the speaker
# name), so a one-source client keeps using exactly one channel.
def _event_capture_channel(event: dict) -> str:
    return _event_channel(event) or _event_speaker(event) or "default"


def _event_session_mismatch(interview_id: str, event: dict) -> bool:
    session_id = str(event.get("session_id", "")).strip()
    return bool(session_id and session_id != interview_id)


def _channel_aliases(raw: str) -> set[str]:
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _event_bool(event: dict, key: str, default: bool) -> bool:
    value = event.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in FALSE_FINALITY_VALUES:
            return False
        if lowered in TRUE_FINALITY_VALUES:
            return True
    return bool(value)


def _event_timestamp_bounds(event: dict, seq: int) -> tuple[int, int]:
    start_ms = _event_int(event, "start_ms")
    end_ms = _event_int(event, "end_ms")
    start = max(0, start_ms if start_ms is not None else seq * 1000)
    end = end_ms if end_ms is not None else start + 900
    return start, max(start, end)


def _event_confidence(event: dict, default: float) -> float:
    value = event.get("confidence", default)
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, confidence))


def _valid_audio_b64(value: object) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return bool(base64.b64decode(value, validate=True))
    except Exception:
        return False


def _event_seq(event: dict, default: int) -> int | None:
    value = event.get("seq", default)
    try:
        seq = int(value)
    except (TypeError, ValueError):
        return None
    return seq if seq >= 0 else None


def _audio_contract_warning(event: dict) -> str | None:
    audio_format = _event_string(event, "format", "audio_format", "codec")
    if audio_format is not None and audio_format not in SUPPORTED_AUDIO_FORMATS:
        return "unsupported_audio_format"
    sample_rate_hz = _event_int(event, "sample_rate_hz", "sample_rate", "rate")
    if sample_rate_hz is not None and sample_rate_hz != EXPECTED_AUDIO_SAMPLE_RATE_HZ:
        return "unsupported_sample_rate"
    channels = _event_int(event, "channels", "channel_count")
    if channels is not None and channels != EXPECTED_AUDIO_CHANNELS:
        return "unsupported_channel_count"
    return None


def _event_string(event: dict, *keys: str) -> str | None:
    for key in keys:
        value = event.get(key)
        if value is None:
            continue
        text = str(value).strip().lower().replace("_", "-")
        if text:
            return text
    return None


def _event_int(event: dict, *keys: str) -> int | None:
    for key in keys:
        value = event.get(key)
        if value is None or value == "":
            continue
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return -1
    return None


@app.post("/api/jobs")
def api_create_job(payload: JobCreate):
    return create_job(payload)


@app.post("/api/documents/parse")
async def api_parse_document(request: Request, kind: str = "resume", filename: str = "upload"):
    if kind not in {"jd", "resume"}:
        raise HTTPException(status_code=400, detail="kind must be jd or resume")
    data = await request.body()
    try:
        return parse_document(
            filename,
            data,
            kind=kind,  # type: ignore[arg-type]
            content_type=request.headers.get("content-type", ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/chat/stream")
async def api_chat_stream(request: Request, payload: ChatStreamRequest):
    study_settings = _read_ui_settings()
    try:
        build_chat_messages(payload, study_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def events():
        stream = iter_chat_deltas(payload, study_settings)
        try:
            async for delta in stream:
                if await request.is_disconnected():
                    return
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - stream errors to the client as SSE
            # 出错时不再发送 done：前端据此保留已生成内容并标记为中断。
            yield f"data: {json.dumps({'error': _safe_public_error(str(exc))}, ensure_ascii=False)}\n\n"
        finally:
            await stream.aclose()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/exam/solve", response_model=ExamSolution)
async def api_solve_exam(
    request: Request,
    filename: str = "exam.png",
    question_hint: str = "",
):
    data = await request.body()
    try:
        return await asyncio.to_thread(
            solve_exam_screenshot,
            filename,
            data,
            question_hint=question_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/memory/repos/scan")
async def api_scan_repo_memory(path: str = ""):
    try:
        if path.strip():
            return {"scanned": {path: await asyncio.to_thread(scan_repo_memories, path)}}
        return {"scanned": await asyncio.to_thread(scan_configured_roots)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/memory/candidates/{candidate_id}")
def api_delete_candidate_memory(candidate_id: str):
    try:
        return {"deleted": delete_candidate_memories(candidate_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str):
    try:
        return get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/jobs/{job_id}/probe-patterns")
def api_job_probe_patterns(job_id: str, q: str = "", limit: int = 5):
    try:
        return retrieve_job_probe_patterns(job_id, q, limit=max(1, min(limit, 20)))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/candidates")
def api_create_candidate(payload: CandidateCreate):
    return create_candidate(payload)


@app.post("/api/consents")
def api_create_consent(payload: ConsentCreate):
    try:
        return create_consent(payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/interviews")
def api_create_interview(payload: InterviewCreate):
    try:
        return create_interview(payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/interviews/quick-setup", response_model=QuickSetupResponse)
async def api_quick_setup(payload: QuickSetupRequest) -> QuickSetupResponse:
    # 字段提取与胜任力模型并行；题库先用确定性兜底立即返回，
    # 真实模型题库在后台生成，完成后入库并通过 WebSocket 推送补充。
    provisional_title = _provisional_job_title(payload.jd_text)
    extraction_task = asyncio.create_task(
        asyncio.to_thread(_extract_quick_setup_fields, payload)
    )
    job_task = asyncio.create_task(
        asyncio.to_thread(
            create_job, JobCreate(title=provisional_title, jd_text=payload.jd_text)
        )
    )
    (extraction, extraction_confident), job = await asyncio.gather(extraction_task, job_task)
    if extraction.job_title != job.title:
        job = update_job_title(job.id, extraction.job_title)
    candidate = get_or_create_candidate(
        CandidateCreate(name=extraction.candidate_name, resume_text=payload.resume_text)
    )
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    question_bank = fallback_question_bank(
        interview.id,
        payload.jd_text,
        payload.resume_text,
        job.competency_model,
    )
    save_question_bank(question_bank)
    asyncio.create_task(
        _refine_question_bank_in_background(
            interview.id,
            payload.jd_text,
            payload.resume_text,
            job.competency_model,
            question_bank,
        )
    )
    return QuickSetupResponse(
        interview_id=interview.id,
        job_id=job.id,
        job_title=job.title,
        candidate_id=candidate.id,
        candidate_name=candidate.name,
        extraction_confident=extraction_confident,
        question_bank=question_bank,
    )


@app.get("/api/interviews/{interview_id}")
def api_get_interview(interview_id: str):
    try:
        return get_interview(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/interviews/{interview_id}/question-bank")
def api_get_question_bank(interview_id: str):
    try:
        return get_question_bank(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/interviews/{interview_id}/start")
def api_start_interview(interview_id: str):
    try:
        return start_interview(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/interviews/{interview_id}/turns")
def api_add_turn(interview_id: str, turn: QATurn):
    try:
        return add_turn(interview_id, turn)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/probe")
async def api_probe(payload: ProbeRequest):
    try:
        return await generate_probe(payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/aigc/detect")
def api_aigc_detect(payload: AIGCDetectRequest):
    return detect_interview(payload.turns)


@app.post("/api/scoring/score")
def api_scoring_score(payload: ScoringRequest):
    try:
        return score_interview(payload.context, payload.aigc_results)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/report/build")
def api_report_build(payload: ReportBuildRequest):
    try:
        report, _ = build_report(payload.context, payload.score, payload.aigc_results)
        return report
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/offline/evaluate", response_model=OfflineInterviewResult)
def api_offline_evaluate(payload: OfflineInterviewInput):
    job = create_job(JobCreate(title=payload.job_title, jd_text=payload.jd_text))
    candidate = create_candidate(
        CandidateCreate(name=payload.candidate_name, resume_text=payload.resume_text)
    )
    interview = create_interview(InterviewCreate(job_id=job.id, candidate_id=candidate.id))
    for turn in payload.turns:
        add_turn(interview.id, turn)
    start_interview(interview.id)
    report = end_interview(interview.id, execute_inline=True)
    interview = get_interview(interview.id)
    return OfflineInterviewResult(
        job=job,
        candidate=candidate,
        interview=interview,
        report=report,
    )


@app.post("/api/interviews/{interview_id}/end")
def api_end_interview(interview_id: str):
    try:
        return end_interview(interview_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/interviews/{interview_id}/report")
def api_report(interview_id: str):
    try:
        report, _ = get_report(interview_id)
        return report
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/interviews/{interview_id}/report.html")
def api_report_html(interview_id: str):
    try:
        _, html = get_report(interview_id)
        return HTMLResponse(html)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/interviews/{interview_id}/report.json")
def api_report_json(interview_id: str):
    try:
        report, _ = get_report(interview_id)
        json_path = report.get("json_path")
        if json_path and Path(json_path).exists():
            return FileResponse(
                json_path,
                media_type="application/json",
                filename=f"{interview_id}.report.json",
            )
        return JSONResponse(
            report,
            headers={"content-disposition": f'attachment; filename="{interview_id}.report.json"'},
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/interviews/{interview_id}/report.pdf")
def api_report_pdf(interview_id: str):
    try:
        report, _ = get_report(interview_id)
        pdf_path = report.get("pdf_path")
        if pdf_path and Path(pdf_path).exists():
            # 下载名遵循命名规则：合格/不合格-姓名-分数.pdf
            return FileResponse(
                pdf_path, media_type="application/pdf", filename=Path(pdf_path).name
            )
        pdf_uri = report.get("artifact_uris", {}).get("pdf")
        if pdf_uri:
            artifact = get_artifact_store().get_file(pdf_uri)
            download_name = Path(pdf_uri).name or f"{interview_id}.pdf"
            return Response(
                content=artifact.content,
                media_type=artifact.content_type or "application/pdf",
                headers={
                    "content-disposition": f"attachment; filename*=UTF-8''{quote(download_name)}"
                },
            )
        raise KeyError(f"report pdf not found: {interview_id}")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (OSError, ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=404, detail=f"report pdf not found: {interview_id}") from exc


@app.get("/api/interviews/{interview_id}/report.transcript.json")
def api_report_transcript(interview_id: str):
    try:
        report, _ = get_report(interview_id)
        transcript_path = report.get("transcript_path")
        if transcript_path and Path(transcript_path).exists():
            return FileResponse(
                transcript_path,
                media_type="application/json",
                filename=f"{interview_id}.transcript.json",
            )
        transcript = report.get("transcript")
        if transcript is None:
            raise KeyError(f"report transcript not found: {interview_id}")
        return JSONResponse(
            {
                "qa_turns": transcript,
                "full_transcript": report.get("utterances", []),
                "probe_chains": report.get("probe_chains", []),
                "analysis_mode": report.get("analysis_mode", "llm"),
            },
            headers={
                "content-disposition": f'attachment; filename="{interview_id}.transcript.json"'
            },
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.websocket("/ws/interview/{interview_id}")
async def ws_interview(websocket: WebSocket, interview_id: str):
    settings = get_settings()
    if not _gateway_authorized(
        websocket.headers,
        settings.gateway_api_key,
        websocket.query_params.get("api_key"),
    ):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    sender = _LockedWebSocketSender(websocket)
    runtime = _dialogue_runtime(interview_id, settings.dialogue_silence_close_ms)
    runtime.senders.add(sender)
    asr_stream_id = f"{interview_id}:{new_id()}"
    engine = get_asr_engine()
    aliyun_channels: dict[str, _AliyunChannel] = {}

    def cancel_dialogue_silence_flush() -> None:
        if runtime.flush_task is not None and not runtime.flush_task.done():
            runtime.flush_task.cancel()
        runtime.flush_task = None

    def schedule_dialogue_silence_flush() -> None:
        if settings.dialogue_silence_close_ms < 0:
            return
        runtime.epoch += 1
        scheduled_epoch = runtime.epoch
        cancel_dialogue_silence_flush()

        async def _flush_after_silence() -> None:
            try:
                await asyncio.sleep(settings.dialogue_silence_close_ms / 1000)
                async with runtime.lock:
                    if scheduled_epoch != runtime.epoch:
                        return
                    await persist_dialogue_result(runtime.assembler.flush())
            except asyncio.CancelledError:
                return

        runtime.flush_task = asyncio.create_task(_flush_after_silence())

    async def handle_dialogue_segment(
        segment: TranscriptSegment,
        *,
        fallback_question: str | None = None,
        question_source: str = "interviewer",
        probe_target: str | None = None,
        probe_chain_id: str | None = None,
        force_close: bool = False,
        emit_probe: bool = True,
        force_probe: bool = False,
    ) -> None:
        async with runtime.lock:
            if segment.is_final:
                runtime.epoch += 1
                cancel_dialogue_silence_flush()
            result = runtime.assembler.feed(
                segment,
                fallback_question=fallback_question,
                question_source=question_source,
                probe_target=probe_target,
                probe_chain_id=probe_chain_id,
                force_close=force_close,
            )
            await persist_dialogue_result(result, emit_probe=emit_probe, force_probe=force_probe)
            if segment.is_final and not force_close:
                schedule_dialogue_silence_flush()

    async def persist_dialogue_result(
        result,
        *,
        emit_probe: bool = True,
        force_probe: bool = False,
    ) -> None:
        nonlocal record
        for utterance in result.utterances:
            record = add_utterance(interview_id, utterance)
            if utterance.speaker == "interviewer" and runtime.question_flow is not None:
                matched_id, stored_question = match_asked_question(
                    utterance.text,
                    runtime.question_flow.current_question,
                    runtime.question_flow.last_options,
                    runtime.question_flow.bank,
                )
                question_origin = (
                    "system_suggested" if matched_id is not None else "interviewer_custom"
                )
                runtime.assembler.annotate_pending_question(
                    stored_question,
                    asked_option_id=matched_id,
                    question_origin=question_origin,
                )
                if matched_id is not None:
                    save_question_bank(runtime.question_flow.bank)
                await runtime.send_json(
                    {
                        "type": "question_matched",
                        "payload": {
                            "utterance_id": utterance.utterance_id,
                            "matched_option_id": matched_id,
                            "asked_text": utterance.text,
                        },
                    }
                )
        for turn in result.turns:
            record = add_turn(interview_id, turn)
            await runtime.send_json({"type": "turn", "payload": turn.model_dump()})
            await runtime.send_json(
                {
                    "type": "probe_chains",
                    "payload": [chain.model_dump() for chain in record.context.probe_chains],
                }
            )
            if runtime.question_flow is not None:
                options = fallback_next_options(
                    record,
                    runtime.question_flow.bank,
                    turn,
                    steering=runtime.question_flow.steering,
                )
                runtime.question_flow.last_options = options
                if _register_suggested_questions(
                    record,
                    [*options.follow_up, *options.alternatives],
                ):
                    save_interview(record)
                await runtime.send_json({"type": "next_options", "payload": options.model_dump()})
                _schedule_next_options_update(runtime, record, turn, options)
            if emit_probe and (force_probe or should_probe_turn(turn, record)):
                _schedule_probe_task(runtime, record, turn)

    def aliyun_channel_for(event: dict) -> _AliyunChannel:
        # The first channel keeps the bare stream id so a single-source client
        # (the manual-switch path, and every existing test) behaves exactly as
        # before; only a genuinely second channel gets a suffixed stream.
        key = _event_capture_channel(event)
        channel = aliyun_channels.get(key)
        if channel is not None:
            return channel
        stream_id = asr_stream_id if not aliyun_channels else f"{asr_stream_id}:{key}"
        channel = _AliyunChannel(
            key=key,
            stream_id=stream_id,
            speaker_hint=_event_speaker(event),
        )
        aliyun_channels[key] = channel
        return channel

    async def ensure_aliyun_session(channel: _AliyunChannel):
        if settings.asr_provider not in STREAMING_ASR_PROVIDERS:
            return None
        if channel.session is not None and not getattr(channel.session, "finished", False):
            return channel.session
        try:
            channel.session = await engine.get_or_create_session(channel.stream_id)  # type: ignore[attr-defined]
        except Exception as exc:
            await _send_asr_warning(sender, _aliyun_warning_reason(exc), 0)
            return None
        channel.reader_task = asyncio.create_task(_aliyun_result_reader(channel))
        return channel.session

    async def close_aliyun_channels(*, await_readers: bool) -> None:
        for channel in list(aliyun_channels.values()):
            if channel.session is not None:
                await channel.session.close()
            if await_readers and channel.reader_task is not None:
                await channel.reader_task

    async def _aliyun_result_reader(channel: _AliyunChannel) -> None:
        nonlocal record
        session = channel.session
        while True:
            item = await session.result_queue.get()
            if item is None:
                if session.error_reason:
                    await _send_asr_warning(sender, session.error_reason, channel.result_seq)
                return
            seq = channel.result_seq
            channel.result_seq += 1
            context = _select_aliyun_audio_context(channel.contexts, item)
            if item.session_id != interview_id:
                item = item.model_copy(update={"session_id": interview_id})
            # Within one channel every chunk carries the same speaker, so the
            # channel's own hint is a safer fallback than the time-matched
            # context when the two disagree.
            hint = (context.speaker_hint if context is not None else None) or channel.speaker_hint
            if hint is not None and item.speaker == "unknown":
                item = item.model_copy(update={"speaker": hint})
            decision = asr_session_manager.accept_segment(
                seq,
                item,
                audio_b64=context.audio_b64 if context is not None else None,
                stream_id=channel.stream_id,
            )
            if not decision.accepted or decision.segment is None:
                await _send_asr_warning(sender, decision.reason, seq)
                continue
            segment = decision.segment
            if _suppress_candidate_echo(runtime, segment):
                continue
            await runtime.send_json({"type": "transcript", "payload": segment.model_dump()})
            await handle_dialogue_segment(
                segment,
                fallback_question=context.question if context is not None else "实时语音片段",
                question_source=context.question_source if context is not None else "interviewer",
                probe_target=context.probe_target if context is not None else None,
                probe_chain_id=context.probe_chain_id if context is not None else None,
            )

    try:
        record = start_interview(interview_id)
        record = await _send_initial_question_if_available(sender, runtime, interview_id, record)
        while True:
            try:
                event = await websocket.receive_json()
            except json.JSONDecodeError:
                await sender.send_json(
                    {"type": "error", "detail": "event payload must be valid JSON"}
                )
                continue
            except KeyError:
                await sender.send_json(
                    {"type": "error", "detail": "event payload must be a text JSON frame"}
                )
                continue
            if not isinstance(event, dict):
                await sender.send_json(
                    {"type": "error", "detail": "event payload must be an object"}
                )
                continue
            if event.get("type") == "audio_chunk":
                seq = _event_seq(event, 0)
                if seq is None:
                    await _send_asr_warning(sender, "invalid_seq", 0)
                    continue
                if _event_session_mismatch(interview_id, event):
                    await _send_asr_warning(sender, "session_id_mismatch", seq)
                    continue
                audio_b64 = event.get("audio", "")
                if not _valid_audio_b64(audio_b64):
                    await _send_asr_warning(sender, "invalid_audio_base64", seq)
                    continue
                contract_warning = _audio_contract_warning(event)
                if contract_warning is not None:
                    await _send_asr_warning(sender, contract_warning, seq)
                    continue
                if settings.asr_provider in STREAMING_ASR_PROVIDERS:
                    channel = aliyun_channel_for(event)
                    session = await ensure_aliyun_session(channel)
                    if session is None:
                        continue
                    start_ms, end_ms = _event_timestamp_bounds(event, seq)
                    channel.contexts.append(
                        _AliyunAudioContext(
                            seq=seq,
                            start_ms=start_ms,
                            end_ms=end_ms,
                            audio_b64=audio_b64,
                            speaker_hint=_event_speaker(event),
                            question=_event_question(event),
                            question_source=_event_question_source(event),
                            probe_target=_event_probe_target(event),
                            probe_chain_id=_event_probe_chain_id(event),
                        )
                    )
                    if len(channel.contexts) > ALIYUN_AUDIO_CONTEXT_LIMIT:
                        del channel.contexts[:-ALIYUN_AUDIO_CONTEXT_LIMIT]
                    pcm_bytes = base64.b64decode(audio_b64)
                    try:
                        await session.send_audio(pcm_bytes)
                    except Exception:
                        if channel.session is not None:
                            await channel.session.close()
                        if hasattr(engine, "close_session"):
                            await engine.close_session(channel.stream_id)  # type: ignore[attr-defined]
                        channel.session = None
                        session = await ensure_aliyun_session(channel)
                        if session is None:
                            continue
                        try:
                            await session.send_audio(pcm_bytes)
                        except Exception as exc:
                            await _send_asr_warning(sender, _asr_warning_reason(exc), seq)
                    continue
                segment = await _transcribe_or_warn(
                    sender,
                    engine,
                    session_id=interview_id,
                    seq=seq,
                    audio_b64=audio_b64,
                    speaker=_event_speaker(event),
                    start_ms=event.get("start_ms"),
                    end_ms=event.get("end_ms"),
                    is_final=_event_bool(event, "is_final", True),
                    confidence=event.get("confidence"),
                )
                if segment is None:
                    continue
                decision = asr_session_manager.accept_segment(
                    seq,
                    segment,
                    audio_b64=audio_b64,
                    stream_id=asr_stream_id,
                )
                if not decision.accepted or decision.segment is None:
                    await _send_asr_warning(sender, decision.reason, seq)
                    continue
                segment = decision.segment
                if _suppress_candidate_echo(runtime, segment):
                    continue
                await runtime.send_json({"type": "transcript", "payload": segment.model_dump()})
                await handle_dialogue_segment(
                    segment,
                    fallback_question=_event_question(event),
                    question_source=_event_question_source(event),
                    probe_target=_event_probe_target(event),
                    probe_chain_id=_event_probe_chain_id(event),
                )
            elif event.get("type") == "text_turn":
                seq = _event_seq(event, 1)
                if seq is None:
                    await sender.send_json({"type": "error", "detail": "invalid seq"})
                    continue
                text = str(event.get("answer", "")).strip()
                if not text:
                    await sender.send_json(
                        {"type": "error", "detail": "text_turn requires answer"}
                    )
                    continue
                encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
                if settings.asr_provider in STREAMING_ASR_PROVIDERS:
                    start_ms, end_ms = _event_timestamp_bounds(event, seq)
                    segment = TranscriptSegment(
                        session_id=interview_id,
                        speaker=_event_speaker(event) or "candidate",
                        text=text,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        is_final=_event_bool(event, "is_final", True),
                        confidence=_event_confidence(event, 1.0),
                    )
                else:
                    segment = await _transcribe_or_warn(
                        sender,
                        engine,
                        session_id=interview_id,
                        seq=seq,
                        audio_b64=encoded,
                        speaker=_event_speaker(event) or "candidate",
                        start_ms=event.get("start_ms"),
                        end_ms=event.get("end_ms"),
                        is_final=_event_bool(event, "is_final", True),
                        confidence=event.get("confidence"),
                    )
                    if segment is None:
                        continue
                decision = asr_session_manager.accept_segment(
                    seq,
                    segment,
                    audio_b64=encoded,
                    stream_id=asr_stream_id,
                )
                if not decision.accepted or decision.segment is None:
                    await _send_asr_warning(sender, decision.reason, seq)
                    continue
                segment = decision.segment
                if _suppress_candidate_echo(runtime, segment):
                    continue
                await runtime.send_json({"type": "transcript", "payload": segment.model_dump()})
                await handle_dialogue_segment(
                    segment,
                    fallback_question=_event_question(event),
                    question_source=_event_question_source(event),
                    probe_target=_event_probe_target(event),
                    probe_chain_id=_event_probe_chain_id(event),
                    force_close=True,
                )
            elif event.get("type") == "manual_probe":
                if not str(event.get("answer") or event.get("latest_answer") or "").strip():
                    await sender.send_json(
                        {"type": "error", "detail": "manual_probe requires answer"}
                    )
                    continue
                try:
                    segment = _manual_probe_segment(interview_id, event)
                except ValueError as exc:
                    await sender.send_json({"type": "error", "detail": str(exc)})
                    continue
                await runtime.send_json({"type": "transcript", "payload": segment.model_dump()})
                await handle_dialogue_segment(
                    segment,
                    fallback_question=_event_question(event),
                    question_source=_event_question_source(event),
                    probe_target=_event_probe_target(event),
                    probe_chain_id=_event_probe_chain_id(event),
                    force_close=True,
                    force_probe=True,
                )
            elif event.get("type") == "pick_option":
                option_id = str(event.get("option_id") or "").strip()
                if not option_id:
                    await sender.send_json({"type": "error", "detail": "pick_option requires option_id"})
                    continue
                async with runtime.lock:
                    if runtime.question_flow is None:
                        await sender.send_json(
                            {"type": "error", "detail": "question flow is not available"}
                        )
                        continue
                    option = find_option(runtime.question_flow, option_id)
                    if option is None:
                        await sender.send_json(
                            {"type": "error", "detail": "unknown question option_id"}
                        )
                        continue
                    runtime.question_flow.current_question = option
                    if _register_suggested_questions(record, [option]):
                        save_interview(record)
                    await runtime.send_json(
                        {"type": "current_question", "payload": option.model_dump()}
                    )
            elif event.get("type") == "set_steering":
                focus = str(event.get("focus") or "").strip()
                if focus not in {"balanced", "resume_drill", "jd_professional"}:
                    await sender.send_json({"type": "error", "detail": "invalid steering focus"})
                    continue
                next_options = None
                async with runtime.lock:
                    record.context.question_steering = focus  # type: ignore[assignment]
                    record.context.steering_history.append(focus)  # type: ignore[arg-type]
                    if runtime.question_flow is not None:
                        runtime.question_flow.steering = focus  # type: ignore[assignment]
                        if runtime.question_flow.last_options is not None:
                            next_options = rebuild_next_options_for_steering(
                                record,
                                runtime.question_flow.bank,
                                runtime.question_flow.last_options,
                                focus,  # type: ignore[arg-type]
                            )
                            runtime.question_flow.last_options = next_options
                            _register_suggested_questions(
                                record,
                                [*next_options.follow_up, *next_options.alternatives],
                            )
                    save_interview(record)
                if next_options is not None:
                    await runtime.send_json(
                        {"type": "next_options", "payload": next_options.model_dump()}
                    )
            elif event.get("type") == "end":
                try:
                    cancel_dialogue_silence_flush()
                    await close_aliyun_channels(await_readers=True)
                    async with runtime.lock:
                        runtime.epoch += 1
                        await persist_dialogue_result(
                            runtime.assembler.flush(),
                            emit_probe=False,
                        )
                    result = await asyncio.to_thread(end_interview, interview_id)
                except (KeyError, ValueError) as exc:
                    await sender.send_json({"type": "error", "detail": str(exc)})
                    continue
                event_type = "task_queued" if isinstance(result, OfflineTaskAccepted) else "report"
                await runtime.send_json(
                    {"type": event_type, "payload": result.model_dump(mode="json")}
                )
                break
            else:
                await sender.send_json({"type": "error", "detail": "unsupported event type"})
    except WebSocketDisconnect:
        await close_aliyun_channels(await_readers=False)
        return
    except KeyError as exc:
        await close_aliyun_channels(await_readers=False)
        await sender.send_json({"type": "error", "detail": str(exc)})
    except ValueError as exc:
        await close_aliyun_channels(await_readers=False)
        await sender.send_json({"type": "error", "detail": str(exc)})
    finally:
        runtime.senders.discard(sender)
        stream_ids = [channel.stream_id for channel in aliyun_channels.values()] or [
            asr_stream_id
        ]
        for stream_id in stream_ids:
            asr_session_manager.close(interview_id, stream_id=stream_id)
            if hasattr(engine, "close_session"):
                try:
                    await engine.close_session(stream_id)  # type: ignore[attr-defined]
                except Exception:
                    pass
        if not runtime.senders:
            cancel_dialogue_silence_flush()
            try:
                async with runtime.lock:
                    await persist_dialogue_result(runtime.assembler.flush(), emit_probe=False)
            except (KeyError, ValueError):
                pass
            _discard_dialogue_runtime(interview_id, runtime)
