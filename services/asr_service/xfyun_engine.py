from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import ssl
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from libs.common.config import Settings, get_settings
from libs.schemas import TranscriptSegment
from services.asr_service.service import ASREngine, Speaker

FRAME_BYTES = 1280


def signed_url(settings: Settings, *, timestamp: int) -> str:
    app_id = settings.xfyun_app_id
    digest = hashlib.md5(f"{app_id}{timestamp}".encode()).hexdigest()
    signature = base64.b64encode(
        hmac.new(settings.xfyun_api_key.encode(), digest.encode(), hashlib.sha1).digest()
    ).decode()
    query = urlencode({"appid": app_id, "ts": str(timestamp), "signa": signature})
    parts = urlsplit(settings.xfyun_rtasr_endpoint)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


class XfyunRTASRSession:
    def __init__(
        self,
        session_id: str,
        *,
        settings: Settings | None = None,
        ws: Any | None = None,
        timestamp: int | None = None,
    ) -> None:
        self.session_id = session_id
        self.settings = settings or get_settings()
        self.ws = ws
        self._timestamp = timestamp
        self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._audio_tail = b""
        self._queue_ended = False
        self.started = False
        self.finished = False
        self.error_reason = ""

    async def connect(self) -> None:
        if self.started and self.ws is not None:
            return
        if self.finished:
            raise RuntimeError("xfyun_asr_session_finished")
        if self.ws is None:
            self.ws = await self._connect_websocket()
        try:
            event = await asyncio.wait_for(self._receive_json_event(), timeout=10)
            if event.get("action") != "started" or str(event.get("code")) != "0":
                self.error_reason = _server_error(event)
                raise RuntimeError(self.error_reason)
        except TimeoutError as exc:
            self.error_reason = "xfyun_asr_connect_timeout"
            await self._close_websocket()
            raise RuntimeError(self.error_reason) from exc
        except asyncio.CancelledError:
            await self._close_websocket()
            raise
        except Exception as exc:
            if not self.error_reason:
                self.error_reason = "xfyun_asr_connect_failed"
            await self._close_websocket()
            if isinstance(exc, RuntimeError) and str(exc) == self.error_reason:
                raise
            raise RuntimeError(self.error_reason) from exc
        self.started = True
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if not self.started:
            await self.connect()
        if self.finished or self.ws is None:
            raise RuntimeError("xfyun_asr_session_finished")
        if not isinstance(pcm_bytes, bytes) or not pcm_bytes or len(pcm_bytes) % 2:
            raise ValueError("xfyun_asr_requires_pcm16_mono")
        data = self._audio_tail + pcm_bytes
        end = len(data) - len(data) % FRAME_BYTES
        for offset in range(0, end, FRAME_BYTES):
            await self.ws.send(data[offset:offset + FRAME_BYTES])
        self._audio_tail = data[end:]

    async def close(self) -> None:
        if self.finished:
            await self._cleanup()
            return
        self.finished = True
        if self.ws is not None:
            try:
                if self.started:
                    if self._audio_tail:
                        await self.ws.send(self._audio_tail)
                        self._audio_tail = b""
                    await self.ws.send(b'{"end":true}')
            except asyncio.CancelledError:
                await self._cancel_reader()
                await self._close_websocket()
                raise
            except Exception:
                self.error_reason = self.error_reason or "xfyun_asr_disconnected"
        if self._reader_task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._reader_task), timeout=10)
            except TimeoutError:
                self.error_reason = self.error_reason or "xfyun_asr_close_timeout"
                await self._cancel_reader()
            except asyncio.CancelledError:
                await self._cancel_reader()
                await self._close_websocket()
                raise
            except Exception:
                self.error_reason = self.error_reason or "xfyun_asr_disconnected"
        await self._cleanup()

    async def _connect_websocket(self) -> Any:
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("xfyun_asr_websockets_dependency_missing") from exc
        import time

        timestamp = int(time.time()) if self._timestamp is None else self._timestamp
        try:
            return await websockets.connect(
                signed_url(self.settings, timestamp=timestamp), proxy=None, ssl=_ssl_context()
            )
        except TypeError:
            return await websockets.connect(
                signed_url(self.settings, timestamp=timestamp), ssl=_ssl_context()
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise RuntimeError("xfyun_asr_connect_failed") from exc

    async def _receive_json_event(self) -> dict[str, Any]:
        if self.ws is None:
            raise RuntimeError("xfyun_asr_not_connected")
        while True:
            message = await self.ws.recv()
            if isinstance(message, bytes):
                message = message.decode("utf-8")
            data = json.loads(message)
            if isinstance(data, dict):
                return data

    async def _reader_loop(self) -> None:
        try:
            while self.ws is not None:
                event = await self._receive_json_event()
                if event.get("action") == "result":
                    segment = self._parse_result(event)
                    if segment is not None:
                        await self.result_queue.put(segment)
                    continue
                if str(event.get("code", "0")) != "0":
                    self.error_reason = _server_error(event)
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if type(exc).__name__ != "ConnectionClosedOK":
                self.error_reason = self.error_reason or "xfyun_asr_disconnected"
        finally:
            self.finished = True
            await self._end_queue()

    def _parse_result(self, event: dict[str, Any]) -> TranscriptSegment | None:
        try:
            payload = json.loads(event["data"])
            sentence = payload["cn"]["st"]
            start_ms = _non_negative_int(sentence.get("bg"), 0)
            end_ms = _non_negative_int(sentence.get("ed"), start_ms)
            text = "".join(
                str(candidate.get("w", ""))
                for result in sentence.get("rt", [])
                for word in result.get("ws", [])
                for candidate in word.get("cw", [])
            ).strip()
        except (KeyError, TypeError, ValueError, AttributeError):
            self.error_reason = "xfyun_asr_invalid_result"
            return None
        if not text:
            return None
        return TranscriptSegment(
            session_id=self.session_id,
            speaker="unknown",
            text=text,
            start_ms=start_ms,
            end_ms=max(start_ms, end_ms),
            is_final=str(sentence.get("type")) == "0",
            confidence=0.92,
        )

    async def _cancel_reader(self) -> None:
        if self._reader_task is None:
            return
        self._reader_task.cancel()
        await asyncio.gather(self._reader_task, return_exceptions=True)

    async def _end_queue(self) -> None:
        if not self._queue_ended:
            self._queue_ended = True
            await self.result_queue.put(None)

    async def _close_websocket(self) -> None:
        ws, self.ws = self.ws, None
        if ws is None:
            return
        close = getattr(ws, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                try:
                    await result
                except Exception:
                    self.error_reason = self.error_reason or "xfyun_asr_disconnected"

    async def _cleanup(self) -> None:
        if self._reader_task is not None and not self._reader_task.done():
            await self._cancel_reader()
        await self._close_websocket()
        self.finished = True
        await self._end_queue()


class XfyunRTASREngine(ASREngine):
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._sessions: dict[str, XfyunRTASRSession] = {}

    async def get_or_create_session(self, session_id: str) -> XfyunRTASRSession:
        session = self._sessions.get(session_id)
        if session is not None and not session.finished:
            return session
        session = XfyunRTASRSession(session_id, settings=self.settings)
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
            raise RuntimeError(session.error_reason or "xfyun_asr_no_result")
        return item


def _server_error(event: dict[str, Any]) -> str:
    code = event.get("code", "unknown")
    description = str(event.get("desc", ""))[:160].replace("\r", " ").replace("\n", " ")
    return f"xfyun_asr_server_error:{code}" + (f":{description}" if description else "")


def _non_negative_int(value: Any, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return fallback


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())
