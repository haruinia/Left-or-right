from __future__ import annotations

import asyncio
import base64
import array
import threading
from pathlib import Path
from typing import Any

from libs.common.config import Settings, get_settings
from libs.schemas import TranscriptSegment
from services.asr_service.service import ASREngine, Speaker


def _pcm16_to_float32(pcm_bytes: bytes) -> list[float]:
    if not pcm_bytes:
        return []
    samples = array.array("h")
    samples.frombytes(pcm_bytes[: len(pcm_bytes) - (len(pcm_bytes) % 2)])
    return [sample / 32768.0 for sample in samples]


def resolve_sherpa_model_paths(settings: Settings) -> dict[str, Path]:
    root = Path(settings.sherpa_asr_model_dir).expanduser()
    if not root.is_absolute():
        root = Path.cwd() / root
    suffix = ".int8.onnx" if settings.sherpa_asr_use_int8 else ".onnx"
    encoder = root / f"encoder{suffix}"
    decoder = root / f"decoder{suffix}"
    tokens = root / "tokens.txt"
    return {"root": root, "encoder": encoder, "decoder": decoder, "tokens": tokens}


def sherpa_model_ready(settings: Settings | None = None) -> bool:
    resolved = resolve_sherpa_model_paths(settings or get_settings())
    return all(resolved[key].is_file() for key in ("encoder", "decoder", "tokens"))


def create_sherpa_recognizer(settings: Settings):
    try:
        import sherpa_onnx
    except ImportError as exc:
        raise RuntimeError(
            "ASR_PROVIDER=sherpa_onnx requires the optional dependency: "
            'pip install -e ".[sherpa]"'
        ) from exc
    paths = resolve_sherpa_model_paths(settings)
    missing = [str(paths[key]) for key in ("encoder", "decoder", "tokens") if not paths[key].is_file()]
    if missing:
        raise RuntimeError(
            "sherpa_onnx model files missing: "
            + ", ".join(missing)
            + ". Run: python scripts/download_sherpa_asr_model.py"
        )
    return sherpa_onnx.OnlineRecognizer.from_paraformer(
        tokens=str(paths["tokens"]),
        encoder=str(paths["encoder"]),
        decoder=str(paths["decoder"]),
        num_threads=settings.sherpa_asr_num_threads,
        sample_rate=settings.sherpa_asr_sample_rate,
        feature_dim=80,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=settings.sherpa_asr_rule1_min_trailing_silence,
        rule2_min_trailing_silence=settings.sherpa_asr_rule2_min_trailing_silence,
        rule3_min_utterance_length=settings.sherpa_asr_rule3_min_utterance_length,
        provider=settings.sherpa_asr_provider,
    )


class SherpaASRSession:
    def __init__(
        self,
        session_id: str,
        *,
        settings: Settings | None = None,
        recognizer: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.settings = settings or get_settings()
        self.recognizer = recognizer
        self.stream: Any | None = None
        self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()
        self.finished = False
        self.error_reason = ""
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._cursor_ms = 0
        self._utterance_start_ms = 0
        self._last_emitted = ""

    async def connect(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self.recognizer is None:
            self.recognizer = await asyncio.to_thread(create_sherpa_recognizer, self.settings)
        self.stream = self.recognizer.create_stream()
        self.finished = False
        self.error_reason = ""
        self._cursor_ms = 0
        self._utterance_start_ms = 0
        self._last_emitted = ""

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if self.finished:
            raise RuntimeError(self.error_reason or "sherpa_asr_finished")
        if self.stream is None or self.recognizer is None:
            raise RuntimeError("sherpa_asr_not_connected")
        await asyncio.to_thread(self._feed_and_decode, pcm_bytes)

    def _feed_and_decode(self, pcm_bytes: bytes) -> None:
        samples = _pcm16_to_float32(pcm_bytes)
        if not samples:
            return
        duration_ms = int(round(len(samples) * 1000 / self.settings.sherpa_asr_sample_rate))
        with self._lock:
            if self.stream is None or self.recognizer is None or self.finished:
                return
            if self._cursor_ms == 0:
                self._utterance_start_ms = 0
            self.stream.accept_waveform(self.settings.sherpa_asr_sample_rate, samples)
            while self.recognizer.is_ready(self.stream):
                self.recognizer.decode_stream(self.stream)
            text = str(self.recognizer.get_result(self.stream) or "").strip()
            endpoint = bool(self.recognizer.is_endpoint(self.stream))
            end_ms = self._cursor_ms + duration_ms
            start_ms = self._utterance_start_ms
            self._cursor_ms = end_ms
            if text and text != self._last_emitted:
                self._last_emitted = text
                self._emit(
                    TranscriptSegment(
                        session_id=self.session_id,
                        speaker="unknown",
                        text=text,
                        start_ms=start_ms,
                        end_ms=max(start_ms, end_ms),
                        is_final=False,
                        confidence=0.9,
                    )
                )
            if endpoint:
                if text:
                    self._emit(
                        TranscriptSegment(
                            session_id=self.session_id,
                            speaker="unknown",
                            text=text,
                            start_ms=start_ms,
                            end_ms=max(start_ms, end_ms),
                            is_final=True,
                            confidence=0.95,
                        )
                    )
                self.recognizer.reset(self.stream)
                self._utterance_start_ms = self._cursor_ms
                self._last_emitted = ""

    def _emit(self, segment: TranscriptSegment) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self.result_queue.put_nowait, segment)

    async def close(self) -> None:
        if self.finished:
            return
        self.finished = True
        with self._lock:
            if self.stream is not None and self.recognizer is not None:
                try:
                    text = str(self.recognizer.get_result(self.stream) or "").strip()
                except Exception:
                    text = ""
                if text:
                    self._emit(
                        TranscriptSegment(
                            session_id=self.session_id,
                            speaker="unknown",
                            text=text,
                            start_ms=self._utterance_start_ms,
                            end_ms=max(self._utterance_start_ms, self._cursor_ms),
                            is_final=True,
                            confidence=0.9,
                        )
                    )
            self.stream = None
        await self.result_queue.put(None)


class SherpaOnnxASREngine(ASREngine):
    def __init__(self, *, settings: Settings | None = None, recognizer: Any | None = None) -> None:
        self.settings = settings or get_settings()
        self._shared_recognizer = recognizer
        self._sessions: dict[str, SherpaASRSession] = {}
        self._recognizer_lock = asyncio.Lock()

    async def _shared(self):
        if self._shared_recognizer is not None:
            return self._shared_recognizer
        async with self._recognizer_lock:
            if self._shared_recognizer is None:
                self._shared_recognizer = await asyncio.to_thread(
                    create_sherpa_recognizer, self.settings
                )
            return self._shared_recognizer

    async def get_or_create_session(self, session_id: str) -> SherpaASRSession:
        session = self._sessions.get(session_id)
        if session is not None and not session.finished:
            return session
        recognizer = await self._shared()
        session = SherpaASRSession(session_id, settings=self.settings, recognizer=recognizer)
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
            raise RuntimeError(session.error_reason or "sherpa_asr_no_result")
        return item
