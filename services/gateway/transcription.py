from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
from datetime import UTC, datetime
from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError

from libs.common.config import get_settings
from services.asr_service.aliyun_engine import AliyunASRSession
from services.asr_service.nls_engine import AliyunNLSSession, _nls_token_failure
from services.gateway import asr_config
from services.gateway.learning_assets import AssetWrite, upsert_asset

router = APIRouter(tags=["transcription"])
CONNECT_TIMEOUT = 12
CLOSE_TIMEOUT = 14
SEND_TIMEOUT = 5
MAX_FRAME_CHARS = 45000
MAX_TRANSCRIPT_CHARS = 500000
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ActivateInput(BaseModel):
    profile_id: str = Field(min_length=1, max_length=100)


async def _payload(request: Request, model: type[BaseModel]):
    try:
        raw = await request.body()
        if len(raw) > 20000:
            raise ValueError
        return model.model_validate(json.loads(raw))
    except (ValueError, TypeError, ValidationError) as exc:
        raise HTTPException(422, "语音配置参数无效，请检查填写内容") from exc


def _config_call(function, *args):
    try:
        return function(*args)
    except asr_config.ProfileNotFound as exc:
        raise HTTPException(404, "语音配置不存在") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "语音配置读取或保存失败，请重试") from exc


def _local_connection(connection: Request | WebSocket) -> bool:
    try:
        local = connection.client is not None and ip_address(connection.client.host).is_loopback
    except ValueError:
        local = False
    return local and connection.url.hostname in LOCAL_HOSTS


def _same_origin(connection: Request | WebSocket, *, required: bool) -> bool:
    origin = connection.headers.get("origin")
    if not origin:
        return not required
    try:
        parsed = urlsplit(origin)
        expected_scheme = "https" if connection.url.scheme in {"https", "wss"} else "http"
        expected_port = connection.url.port or (443 if expected_scheme == "https" else 80)
        return (
            parsed.scheme == expected_scheme
            and parsed.hostname == connection.url.hostname
            and (parsed.port or (443 if parsed.scheme == "https" else 80)) == expected_port
            and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
            and parsed.path in {"", "/"}
        )
    except ValueError:
        return False


def _require_local_settings(request: Request) -> None:
    if not _local_connection(request) or not _same_origin(request, required=False) or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "语音配置只能在本机设置页面操作")


@router.get("/api/config/asr/profiles")
def list_profiles():
    return _config_call(asr_config.list_response)


@router.post("/api/config/asr/profiles")
async def save_profile(request: Request):
    _require_local_settings(request)
    payload = await _payload(request, asr_config.ProfileInput)
    return _config_call(asr_config.save_profile, payload)


@router.post("/api/config/asr/activate")
async def activate_profile(request: Request):
    _require_local_settings(request)
    payload = await _payload(request, ActivateInput)
    return _config_call(asr_config.activate_profile, payload.profile_id)


@router.delete("/api/config/asr/profiles/{profile_id}")
def delete_profile(profile_id: str, request: Request):
    _require_local_settings(request)
    return _config_call(asr_config.delete_profile, profile_id)


@router.post("/api/config/asr/profiles/{profile_id}/key")
def reveal_key(profile_id: str, request: Request):
    _require_local_settings(request)
    key = _config_call(asr_config.profile_api_key, profile_id)
    return JSONResponse({"api_key": key}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@router.post("/api/config/asr/profiles/{profile_id}/secrets/{field}")
def reveal_nls_secret(profile_id: str, field: str, request: Request):
    _require_local_settings(request)
    value = _config_call(asr_config.profile_secret, profile_id, field)
    return JSONResponse({"value": value}, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


def _create_provider_session(session_id: str, profile: asr_config.AsrProfile, settings):
    if profile.provider == "aliyun_ws":
        return AliyunASRSession(session_id, settings=settings)
    provider = asr_config.nls_token_provider(profile)
    session = AliyunNLSSession(session_id, settings=settings, token_provider=provider)
    session._configured_token_provider = provider
    return session


async def _connect_provider(session, profile: asr_config.AsrProfile) -> None:
    provider = getattr(session, "_configured_token_provider", None)
    try:
        await session.connect()
        return
    except Exception as exc:
        if profile.provider != "aliyun_nls_ws":
            raise
        reason = session.error_reason or str(exc)
        if session.started or provider is None or not _nls_token_failure(RuntimeError(reason)):
            if "No permission" in reason or "40020503" in reason:
                session.error_reason = "nls_token_permission_denied"
            raise
    provider.invalidate()
    session._prefer_auto_token = True
    session.error_reason = ""
    session.task_id = uuid4().hex
    await session.connect()


async def _close_provider(session) -> None:
    try:
        await asyncio.wait_for(session.close(), CLOSE_TIMEOUT)
    finally:
        reader = getattr(session, "_reader_task", None)
        if reader is not None and not reader.done():
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        socket = getattr(session, "ws", None)
        if socket is not None:
            transport = getattr(socket, "transport", None)
            if transport is not None:
                transport.abort()


def _provider_failure_detail(reason: str, provider: str = "aliyun_ws") -> str:
    if provider == "aliyun_nls_ws":
        lowered = reason.lower()
        if "nls_token_permission_denied" in reason or "40020503" in reason or "no permission" in lowered:
            return "NLS 自动鉴权无权限，请检查 RAM AccessKey 是否获得 nls:CreateToken 权限，以及所属账号是否已开通智能语音交互。"
        if any(value in lowered for value in ("bad token", "invalid token", "token expired", "40000002", "http 403", "forbidden")):
            return "NLS Token 无效或已过期，请更新临时 Token，或使用 AccessKey 自动签发；AppKey 与 Token 必须属于同一账号。"
        if "appkey" in lowered or "app key" in lowered:
            return "NLS 项目 AppKey 验证失败，请检查项目、服务开通状态及凭据所属账号。"
        if "concurrent" in lowered or "concurrency" in lowered:
            return "NLS 并发连接额度不足，双音源需要两路实时识别连接，请检查账号并发额度。"
        return "NLS 连接失败，请检查项目 AppKey、Token 或自动鉴权权限、服务开通状态及网络。"
    if "AccessDenied.Unpurchased" in reason:
        return "阿里云返回 AccessDenied.Unpurchased：当前账号或业务空间未获准调用该模型，请先确认百炼服务已开通及模型调用权限。充值不等于服务开通。"
    if "Model.AccessDenied" in reason or "Workspace.AccessDenied" in reason:
        return "阿里云拒绝模型或业务空间访问，请检查 API Key 所属业务空间的模型授权。"
    if "InvalidApiKey" in reason:
        return "阿里云 API Key 验证失败，请检查密钥是否有效，以及所属地域与接口是否匹配。"
    if "Arrearage" in reason:
        return "阿里云提示账户欠费，请检查该 API Key 所属账号的计费状态。"
    return "语音服务连接失败，请检查密钥、接口、模型及网络。"


@router.post("/api/config/asr/profiles/{profile_id}/check")
async def check_profile(profile_id: str, request: Request):
    _require_local_settings(request)
    profile, settings = _config_call(asr_config.snapshot, profile_id)
    session = _create_provider_session(f"check-{uuid4().hex}", profile, settings)
    ok = False
    reason = ""
    try:
        await asyncio.wait_for(_connect_provider(session, profile), CONNECT_TIMEOUT)
        ok = True
    except Exception:
        reason = session.error_reason
    finally:
        try:
            await _close_provider(session)
        except Exception:
            ok = False
    ok = ok and not session.error_reason
    return {
        "ok": ok,
        "detail": "连接验证通过，尚未进行语音识别；请在面试转写中测试声音。" if ok else _provider_failure_detail(reason or session.error_reason, profile.provider),
    }


class StartFrame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["start"]
    role: Literal["candidate", "interviewer"]
    sources: list[Literal["mic", "system"]] = Field(min_length=1, max_length=2)
    api_key: str = Field(default="", repr=False)


class AudioFrame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["audio"]
    source: Literal["mic", "system"]
    seq: StrictInt = Field(ge=0)
    audio: str = Field(min_length=1, max_length=42668)


class SessionError(Exception):
    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(code)


async def _receive(websocket: WebSocket) -> dict:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text = message.get("text")
    if not isinstance(text, str) or len(text) > MAX_FRAME_CHARS:
        raise SessionError("invalid_message", "转写消息格式或大小无效")
    try:
        frame = json.loads(text)
    except ValueError as exc:
        raise SessionError("invalid_message", "转写消息格式无效") from exc
    if not isinstance(frame, dict):
        raise SessionError("invalid_message", "转写消息格式无效")
    return frame


class Transcription:
    def __init__(self, websocket: WebSocket, start: StartFrame):
        self.websocket = websocket
        self.start = start
        self.session_id = f"transcription_{uuid4().hex}"
        self.started_at = datetime.now(UTC).isoformat()
        self.profile, self.settings = asr_config.snapshot()
        self.sessions = {source: _create_provider_session(f"{self.session_id}:{source}", self.profile, self.settings) for source in start.sources}
        self.sequences = {source: 0 for source in start.sources}
        self.readers: list[asyncio.Task] = []
        self.final_segments: dict[str, dict] = {}
        self.text_chars = 0
        self.send_lock = asyncio.Lock()
        self.failure = asyncio.Event()
        self.failure_code = "provider_failed"
        self.connected = True
        self.finishing = False

    async def send(self, event: dict) -> None:
        if not self.connected:
            return
        try:
            async with self.send_lock:
                await asyncio.wait_for(self.websocket.send_json(event), SEND_TIMEOUT)
        except (TimeoutError, RuntimeError, WebSocketDisconnect, OSError):
            self.connected = False
            self.failure_code = "connection_closed"
            self.failure.set()

    async def connect(self) -> None:
        tasks = [asyncio.create_task(asyncio.wait_for(_connect_provider(session, self.profile), CONNECT_TIMEOUT)) for session in self.sessions.values()]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def read_source(self, source: str) -> None:
        session = self.sessions[source]
        try:
            while True:
                item = await session.result_queue.get()
                if item is None:
                    if session.error_reason or not self.finishing:
                        self.failure.set()
                    return
                segment_id = f"{source}:{item.start_ms}"
                if not item.is_final and segment_id in self.final_segments:
                    continue
                speaker = self.start.role if source == "mic" else "interviewer" if self.start.role == "candidate" else "candidate"
                event = {
                    "type": "transcript", "source": source, "speaker": speaker,
                    "text": item.text, "start_ms": item.start_ms, "end_ms": item.end_ms,
                    "is_final": item.is_final, "segment_id": segment_id,
                }
                if item.is_final:
                    previous = self.final_segments.get(segment_id)
                    if previous == event:
                        continue
                    count = self.text_chars + len(item.text) - (len(previous["text"]) if previous else 0)
                    if count > MAX_TRANSCRIPT_CHARS or (not previous and len(self.final_segments) >= 3000):
                        self.failure_code = "transcript_limit"
                        self.failure.set()
                        return
                    self.text_chars = count
                    self.final_segments[segment_id] = event
                await self.send(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failure.set()

    async def audio(self, raw: dict) -> None:
        try:
            frame = AudioFrame.model_validate(raw)
            if frame.source not in self.sessions or frame.seq != self.sequences[frame.source]:
                raise ValueError
            pcm = base64.b64decode(frame.audio, validate=True)
            if not pcm or len(pcm) > 32000 or len(pcm) % 2:
                raise ValueError
        except (ValueError, TypeError, binascii.Error, ValidationError) as exc:
            raise SessionError("invalid_audio", "音频帧、来源或序号无效，请重新开始转写") from exc
        self.sequences[frame.source] += 1
        try:
            await asyncio.wait_for(self.sessions[frame.source].send_audio(pcm), SEND_TIMEOUT)
        except Exception as exc:
            raise SessionError("provider_failed", "语音服务连接中断，已停止双路采集") from exc

    async def finish(self) -> None:
        self.finishing = True
        closures = await asyncio.gather(*(_close_provider(session) for session in self.sessions.values()), return_exceptions=True)
        if any(isinstance(result, BaseException) for result in closures):
            self.failure.set()
        if self.readers:
            try:
                await asyncio.wait_for(asyncio.gather(*self.readers), CLOSE_TIMEOUT)
            except Exception:
                self.failure.set()
                for task in self.readers:
                    task.cancel()
                await asyncio.gather(*self.readers, return_exceptions=True)

    async def save(self) -> tuple[bool, dict | None]:
        if not self.final_segments:
            return False, None
        segments = sorted(self.final_segments.values(), key=lambda item: (item["start_ms"], item["source"]))
        record = {
            "id": self.session_id,
            "kind": "transcription",
            "startedAt": self.started_at,
            "endedAt": datetime.now(UTC).isoformat(),
            "note": f"面试转写 · {self.profile.name}",
            "turnCount": len(segments),
            "turns": [{"role": "user", "source": item["source"], "speaker": item["speaker"], "text": item["text"], "start_ms": item["start_ms"], "end_ms": item["end_ms"]} for item in segments],
        }
        try:
            await asyncio.to_thread(upsert_asset, "sessions", AssetWrite(item=record))
            return True, record
        except Exception:
            return False, record

    async def run(self) -> None:
        connector = asyncio.create_task(self.connect())
        receiver = asyncio.create_task(_receive(self.websocket))
        failure_waiter = asyncio.create_task(self.failure.wait())
        error: SessionError | None = None
        try:
            done, _pending = await asyncio.wait({connector, receiver}, return_when=asyncio.FIRST_COMPLETED)
            if receiver in done:
                first = receiver.result()
                if first != {"type": "stop"}:
                    raise SessionError("not_ready", "请等待语音服务就绪后发送音频")
                return
            try:
                await connector
            except Exception as exc:
                reason = " ".join(session.error_reason for session in self.sessions.values())
                raise SessionError("connect_failed", _provider_failure_detail(reason, self.profile.provider)) from exc
            self.readers = [asyncio.create_task(self.read_source(source)) for source in self.sessions]
            await self.send({"type": "ready", "session_id": self.session_id, "role": self.start.role, "sources": self.start.sources, "profile": {"id": self.profile.id, "name": self.profile.name, "model": self.profile.model}})
            while self.connected:
                done, _pending = await asyncio.wait({receiver, failure_waiter}, return_when=asyncio.FIRST_COMPLETED)
                if failure_waiter in done:
                    raise SessionError(self.failure_code, "语音服务已中断，转写已停止；已收到的文字会保留")
                frame = receiver.result()
                if frame == {"type": "stop"}:
                    break
                if frame.get("type") != "audio":
                    raise SessionError("invalid_message", "转写消息格式无效")
                await self.audio(frame)
                receiver = asyncio.create_task(_receive(self.websocket))
        except WebSocketDisconnect:
            self.connected = False
        except SessionError as exc:
            error = exc
            await self.send({"type": "error", "code": exc.code, "detail": exc.detail})
        except Exception:
            error = SessionError("transcription_failed", "转写无法继续，已收到的文字会保留")
            await self.send({"type": "error", "code": error.code, "detail": error.detail})
        finally:
            for task in (connector, receiver, failure_waiter):
                if not task.done():
                    task.cancel()
            await asyncio.gather(connector, receiver, failure_waiter, return_exceptions=True)
            await self.finish()
            if self.failure.is_set() and not error and self.connected:
                await self.send({"type": "error", "code": "provider_failed", "detail": "语音服务结束时发生异常，已收到的文字会保留"})
            saved, record = await self.save()
            if record is not None and not saved:
                await self.send({"type": "error", "code": "save_failed", "detail": "文字记录保存失败，请重试保存或导出当前文字"})
            await self.send({"type": "stopped", "saved": saved, "record_id": self.session_id, "record": record})
            if self.connected:
                try:
                    await self.websocket.close(code=1000)
                except (RuntimeError, WebSocketDisconnect, OSError):
                    pass


@router.websocket("/ws/transcription")
async def transcribe(websocket: WebSocket):
    if not _local_connection(websocket) or not _same_origin(websocket, required=True):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(_receive(websocket), 5)
        start = StartFrame.model_validate(raw)
        if len(set(start.sources)) != len(start.sources):
            raise ValueError
        expected_key = get_settings().gateway_api_key
        if not hmac.compare_digest(start.api_key.encode(), expected_key.encode()):
            await websocket.close(code=1008)
            return
    except WebSocketDisconnect:
        return
    except (ValueError, TypeError, TimeoutError, SessionError, ValidationError):
        await websocket.send_json({"type": "error", "code": "invalid_start", "detail": "转写启动参数无效"})
        await websocket.close(code=1008)
        return
    try:
        session = Transcription(websocket, start)
    except (ValueError, OSError):
        await websocket.send_json({"type": "error", "code": "not_configured", "detail": "请先在语音接入中保存并选择有效配置"})
        await websocket.close(code=1008)
        return
    await session.run()
