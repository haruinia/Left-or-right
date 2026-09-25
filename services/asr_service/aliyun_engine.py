from __future__ import annotations

import asyncio
import base64
import json
import ssl
from typing import Any
from uuid import uuid4

from libs.common.config import Settings, get_settings
from libs.schemas import TranscriptSegment
from services.asr_service.service import ASREngine, Speaker


class AliyunASRSession:
    def __init__(
        self,
        session_id: str,
        *,
        settings: Settings | None = None,
        ws: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.settings = settings or get_settings()
        self.task_id = str(uuid4())
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
            await self.ws.send(json.dumps(self._run_task_payload(), ensure_ascii=False))
            event = await asyncio.wait_for(self._receive_json_event(), timeout=10)
        except TimeoutError as exc:
            self.error_reason = "aliyun_asr_connect_failed"
            await self._close_websocket()
            raise RuntimeError(self.error_reason) from exc
        except Exception:
            await self._close_websocket()
            raise
        if event.get("header", {}).get("event") != "task-started":
            self.error_reason = (
                _task_failed_reason(event)
                if event.get("header", {}).get("event") == "task-failed"
                else "aliyun_asr_connect_failed"
            )
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
                await self.ws.send(json.dumps(self._finish_task_payload(), ensure_ascii=False))
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

        headers = {"Authorization": f"Bearer {self.settings.aliyun_asr_api_key}"}
        try:
            return await websockets.connect(
                self.settings.aliyun_asr_endpoint,
                additional_headers=headers,
                proxy=None,
                ssl=_ssl_context(),
            )
        except TypeError:
            return await websockets.connect(
                self.settings.aliyun_asr_endpoint,
                extra_headers=headers,
                ssl=_ssl_context(),
            )

    async def _reader_loop(self) -> None:
        try:
            while self.ws is not None:
                data = await self._receive_json_event()
                event = data.get("header", {}).get("event")
                if event == "result-generated":
                    segment = self._parse_result(data)
                    if segment is not None:
                        await self.result_queue.put(segment)
                elif event == "task-failed":
                    self.error_reason = _task_failed_reason(data)
                    break
                elif event == "task-finished":
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

    def _parse_result(self, data: dict[str, Any]) -> TranscriptSegment | None:
        sentence = data.get("payload", {}).get("output", {}).get("sentence", {})
        if sentence.get("heartbeat"):
            return None
        text = str(sentence.get("text", "")).strip()
        if not text:
            return None
        begin_time = _coerce_non_negative_int(sentence.get("begin_time"), 0)
        end_time = _coerce_non_negative_int(sentence.get("end_time"), begin_time)
        return TranscriptSegment(
            session_id=self.session_id,
            speaker="unknown",
            text=text,
            start_ms=begin_time,
            end_ms=max(begin_time, end_time),
            is_final=bool(sentence.get("sentence_end", False)),
            confidence=0.92,
        )

    def _run_task_payload(self) -> dict[str, Any]:
        hints = [
            item.strip()
            for item in self.settings.aliyun_asr_language_hints.split(",")
            if item.strip()
        ]
        parameters: dict[str, Any] = {
            "format": self.settings.aliyun_asr_format,
            "sample_rate": self.settings.aliyun_asr_sample_rate,
            "language_hints": hints,
        }
        # 可选热词表：提高专业术语/人名识别率（需预先创建并配置其 ID）。
        vocabulary_id = self.settings.aliyun_asr_vocabulary_id.strip()
        if vocabulary_id:
            parameters["vocabulary_id"] = vocabulary_id
        return {
            "header": {
                "action": "run-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": self.settings.aliyun_asr_model,
                "parameters": parameters,
                "input": {},
            },
        }

    def _finish_task_payload(self) -> dict[str, Any]:
        return {
            "header": {
                "action": "finish-task",
                "task_id": self.task_id,
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


class AliyunWSASREngine(ASREngine):
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._sessions: dict[str, AliyunASRSession] = {}

    async def get_or_create_session(self, session_id: str) -> AliyunASRSession:
        session = self._sessions.get(session_id)
        if session is not None and not session.finished:
            return session
        session = AliyunASRSession(session_id, settings=self.settings)
        try:
            await session.connect()
        except Exception:
            self._sessions.pop(session_id, None)
            raise
        self._sessions[session_id] = session
        return session

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


def _coerce_non_negative_int(value: Any, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return fallback


def _task_failed_reason(data: dict[str, Any]) -> str:
    header = data.get("header", {})
    error_code = header.get("error_code") or header.get("code") or "task_failed"
    error_message = header.get("error_message") or header.get("message") or ""
    if error_message:
        return f"aliyun_asr_task_failed:{error_code}:{error_message}"
    return f"aliyun_asr_task_failed:{error_code}"


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())
