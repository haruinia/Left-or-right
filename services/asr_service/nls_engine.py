from __future__ import annotations

import asyncio
import base64
import json
import ssl
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

from libs.common.config import Settings, get_settings
from libs.schemas import TranscriptSegment
from services.asr_service.nls_token import AliyunNLSTokenProvider
from services.asr_service.service import ASREngine, Speaker


class AliyunNLSSession:
    def __init__(
        self,
        session_id: str,
        *,
        settings: Settings | None = None,
        ws: Any | None = None,
        token_provider: AliyunNLSTokenProvider | None = None,
        prefer_auto_token: bool = False,
    ) -> None:
        self.session_id = session_id
        self.settings = settings or get_settings()
        self._token_provider = token_provider
        self._prefer_auto_token = prefer_auto_token
        self.task_id = uuid4().hex
        self.ws = ws
        self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self.started = False
        self.finished = False
        self.error_reason = ""

    async def connect(self) -> None:
        if self.started and self.ws is not None:
            return
        if self.ws is None:
            self.ws = await self._connect_websocket()
        try:
            await self.ws.send(json.dumps(self._start_payload(), ensure_ascii=False))
            event = await asyncio.wait_for(self._receive_json_event(), timeout=10)
        except TimeoutError as exc:
            self.error_reason = "aliyun_asr_connect_failed"
            await self._close_websocket()
            raise RuntimeError(self.error_reason) from exc
        except Exception:
            await self._close_websocket()
            raise
        if not _nls_event_ok(event, "TranscriptionStarted"):
            self.error_reason = _nls_failed_reason(event) or "aliyun_asr_connect_failed"
            await self._close_websocket()
            raise RuntimeError(self.error_reason)
        self.started = True
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if not self.started:
            await self.connect()
        if self.finished or self.ws is None:
            raise RuntimeError("aliyun_asr_session_finished")
        await self.ws.send(pcm_bytes)

    async def close(self) -> None:
        if self.finished:
            await self._close_websocket()
            return
        self.finished = True
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps(self._stop_payload(), ensure_ascii=False))
            except Exception:
                self.error_reason = self.error_reason or "aliyun_asr_disconnected"
        if self._reader_task is not None:
            try:
                await asyncio.wait_for(self._reader_task, timeout=10)
            except TimeoutError:
                self._reader_task.cancel()
                self.error_reason = self.error_reason or "aliyun_asr_close_timeout"
                await self.result_queue.put(None)
        await self._close_websocket()

    async def _connect_websocket(self) -> Any:
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("aliyun_asr_websockets_dependency_missing") from exc

        endpoint = self.settings.aliyun_nls_endpoint
        separator = "&" if "?" in endpoint else "?"
        token = await self._resolve_token()
        url = f"{endpoint}{separator}{urlencode({'token': token})}"
        try:
            return await websockets.connect(url, proxy=None, ssl=_ssl_context())
        except TypeError:
            return await websockets.connect(url, ssl=_ssl_context())

    async def _resolve_token(self) -> str:
        token = self.settings.aliyun_nls_token.strip()
        if token and not self._prefer_auto_token:
            return token
        provider = self._token_provider or self._build_token_provider()
        return await asyncio.to_thread(provider.get_token)

    def _build_token_provider(self) -> AliyunNLSTokenProvider:
        if not (self.settings.aliyun_ak_id.strip() and self.settings.aliyun_ak_secret.strip()):
            raise RuntimeError("aliyun_nls_token_missing")
        self._token_provider = AliyunNLSTokenProvider(
            access_key_id=self.settings.aliyun_ak_id,
            access_key_secret=self.settings.aliyun_ak_secret,
            endpoint=self.settings.aliyun_nls_token_endpoint,
            region_id=self.settings.aliyun_nls_token_region,
        )
        return self._token_provider

    async def _reader_loop(self) -> None:
        try:
            while self.ws is not None:
                data = await self._receive_json_event()
                event_name = data.get("header", {}).get("name")
                if not _nls_status_ok(data):
                    self.error_reason = _nls_failed_reason(data)
                    break
                if event_name in {"TranscriptionResultChanged", "SentenceEnd"}:
                    segment = self._parse_result(data, is_final=event_name == "SentenceEnd")
                    if segment is not None:
                        await self.result_queue.put(segment)
                elif event_name in {"TranscriptionCompleted", "TaskFailed"}:
                    if event_name == "TaskFailed":
                        self.error_reason = _nls_failed_reason(data)
                    break
        except Exception:
            self.error_reason = self.error_reason or "aliyun_asr_disconnected"
        finally:
            self.finished = True
            await self.result_queue.put(None)

    async def _receive_json_event(self) -> dict[str, Any]:
        if self.ws is None:
            raise RuntimeError("aliyun_asr_not_connected")
        while True:
            message = await self.ws.recv()
            if isinstance(message, bytes):
                continue
            data = json.loads(message)
            if isinstance(data, dict):
                return data

    def _parse_result(self, data: dict[str, Any], *, is_final: bool) -> TranscriptSegment | None:
        payload = data.get("payload", {})
        text = str(payload.get("result", "")).strip()
        if not text:
            return None
        start_ms = _coerce_non_negative_int(payload.get("begin_time"), 0)
        end_ms = _coerce_non_negative_int(payload.get("time"), start_ms)
        confidence = _coerce_confidence(payload.get("confidence"), 0.92)
        return TranscriptSegment(
            session_id=self.session_id,
            speaker="unknown",
            text=text,
            start_ms=start_ms,
            end_ms=max(start_ms, end_ms),
            is_final=is_final,
            confidence=confidence,
        )

    def _start_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "format": self.settings.aliyun_nls_format,
            "sample_rate": self.settings.aliyun_nls_sample_rate,
            "enable_intermediate_result": True,
            "enable_punctuation_prediction": True,
            "enable_inverse_text_normalization": True,
        }
        # 可选热词表 / 定制模型：提高专业术语、人名等的识别率（需预先创建并配置其 ID）。
        vocabulary_id = self.settings.aliyun_nls_vocabulary_id.strip()
        if vocabulary_id:
            payload["vocabulary_id"] = vocabulary_id
        customization_id = self.settings.aliyun_nls_customization_id.strip()
        if customization_id:
            payload["customization_id"] = customization_id
        return {
            "header": {
                "appkey": self.settings.aliyun_nls_app_key,
                "namespace": "SpeechTranscriber",
                "name": "StartTranscription",
                "task_id": self.task_id,
                "message_id": uuid4().hex,
            },
            "payload": payload,
        }

    def _stop_payload(self) -> dict[str, Any]:
        return {
            "header": {
                "appkey": self.settings.aliyun_nls_app_key,
                "namespace": "SpeechTranscriber",
                "name": "StopTranscription",
                "task_id": self.task_id,
                "message_id": uuid4().hex,
            },
            "payload": {},
        }

    async def _close_websocket(self) -> None:
        if self.ws is None:
            return
        close = getattr(self.ws, "close", None)
        if close is not None:
            result = close()
            if hasattr(result, "__await__"):
                await result
        self.ws = None


class AliyunNLSWSASREngine(ASREngine):
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._token_provider = self._build_token_provider()
        self._prefer_auto_token = False
        self._sessions: dict[str, AliyunNLSSession] = {}

    def _build_token_provider(self) -> AliyunNLSTokenProvider | None:
        if not (self.settings.aliyun_ak_id.strip() and self.settings.aliyun_ak_secret.strip()):
            return None
        return AliyunNLSTokenProvider(
            access_key_id=self.settings.aliyun_ak_id,
            access_key_secret=self.settings.aliyun_ak_secret,
            endpoint=self.settings.aliyun_nls_token_endpoint,
            region_id=self.settings.aliyun_nls_token_region,
        )

    async def get_or_create_session(self, session_id: str) -> AliyunNLSSession:
        session = self._sessions.get(session_id)
        if session is not None and not session.finished:
            return session
        session = self._new_session(session_id)
        try:
            await session.connect()
        except Exception as exc:
            if self._token_provider is not None and _nls_token_failure(exc):
                self._token_provider.invalidate()
                self._prefer_auto_token = True
                session = self._new_session(session_id)
                try:
                    await session.connect()
                except Exception:
                    self._sessions.pop(session_id, None)
                    raise
            else:
                self._sessions.pop(session_id, None)
                raise
        self._sessions[session_id] = session
        return session

    def _new_session(self, session_id: str) -> AliyunNLSSession:
        return AliyunNLSSession(
            session_id,
            settings=self.settings,
            token_provider=self._token_provider,
            prefer_auto_token=self._prefer_auto_token,
        )

    async def close_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is not None:
            await session.close()

    async def transcribe_chunk(
        self,
        session_id: str,
        seq: int,
        audio_b64: str,
        *,
        speaker: Speaker | None = None,
        start_ms: int | None = None,
        end_ms: int | None = None,
        is_final: bool = True,
        confidence: float | None = None,
    ) -> TranscriptSegment:
        del seq, speaker, start_ms, end_ms, is_final, confidence
        session = await self.get_or_create_session(session_id)
        await session.send_audio(base64.b64decode(audio_b64))
        item = await asyncio.wait_for(session.result_queue.get(), timeout=10)
        if item is None:
            raise RuntimeError(session.error_reason or "aliyun_asr_no_result")
        return item


def _nls_token_failure(exc: Exception) -> bool:
    reason = str(exc).lower()
    return (
        "40000002" in reason
        or "bad token" in reason
        or "invalid token" in reason
        or "http 403" in reason
        or "forbidden" in reason
    )


def _nls_event_ok(data: dict[str, Any], event_name: str) -> bool:
    return data.get("header", {}).get("name") == event_name and _nls_status_ok(data)


def _nls_status_ok(data: dict[str, Any]) -> bool:
    status = data.get("header", {}).get("status")
    return status in {None, 20000000, "20000000"}


def _nls_failed_reason(data: dict[str, Any]) -> str:
    header = data.get("header", {})
    status = header.get("status") or header.get("status_code") or "task_failed"
    status_text = header.get("status_text") or header.get("message") or ""
    if status_text:
        return f"aliyun_asr_task_failed:{status}:{status_text}"
    return f"aliyun_asr_task_failed:{status}"


def _coerce_non_negative_int(value: Any, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return fallback


def _coerce_confidence(value: Any, fallback: float) -> float:
    if value is None:
        return fallback
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return fallback


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())
