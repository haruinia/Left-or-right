from __future__ import annotations

import base64
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, Literal

import httpx

from libs.common.config import get_settings
from libs.schemas import TranscriptSegment

Speaker = Literal["interviewer", "candidate", "unknown"]
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


@dataclass
class ASRSessionChunk:
    seq: int
    segment: TranscriptSegment


@dataclass
class ASRSessionDecision:
    accepted: bool
    segment: TranscriptSegment | None = None
    reason: str = ""


class SpeakerDiarizer(ABC):
    @abstractmethod
    def resolve_speaker(
        self,
        session_id: str,
        audio_b64: str | None,
        speaker: Speaker,
    ) -> Speaker:
        raise NotImplementedError

    def close(self, session_id: str) -> None:
        return None

    def reset(self) -> None:
        return None


class LocalSpeakerDiarizer(SpeakerDiarizer):
    def resolve_speaker(
        self,
        session_id: str,
        audio_b64: str | None,
        speaker: Speaker,
    ) -> Speaker:
        # Local mode is explicit speaker attribution, not biometric voiceprint matching.
        return speaker


class HTTPSpeakerDiarizer(SpeakerDiarizer):
    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._fallback = LocalSpeakerDiarizer()

    def resolve_speaker(
        self,
        session_id: str,
        audio_b64: str | None,
        speaker: Speaker,
    ) -> Speaker:
        settings = get_settings()
        if not audio_b64 or speaker in {"interviewer", "candidate"}:
            return self._fallback.resolve_speaker(session_id, audio_b64, speaker)
        if not settings.speaker_diarization_base_url:
            raise RuntimeError(
                "SPEAKER_DIARIZATION_PROVIDER=http requires SPEAKER_DIARIZATION_BASE_URL"
            )
        url = (
            settings.speaker_diarization_base_url.rstrip("/")
            + "/"
            + settings.speaker_diarization_api_path.lstrip("/")
        )
        payload = {"session_id": session_id, "audio": audio_b64, "hint_speaker": speaker}
        try:
            with httpx.Client(
                timeout=settings.speaker_diarization_timeout_seconds,
                transport=self._transport,
            ) as client:
                response = client.post(url, headers=_speaker_diarization_headers(), json=payload)
                response.raise_for_status()
            resolved = _coerce_speaker(
                _extract_optional(
                    response.json(),
                    settings.speaker_diarization_speaker_path,
                    speaker,
                )
            )
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return self._fallback.resolve_speaker(session_id, audio_b64, speaker)
        return resolved

    def close(self, session_id: str) -> None:
        self._fallback.close(session_id)

    def reset(self) -> None:
        self._fallback.reset()


@dataclass
class ASRSessionState:
    chunks: dict[int, ASRSessionChunk] = field(default_factory=dict)
    last_final_seq: int = -1
    last_known_speaker: Speaker | None = None
    last_known_end_ms: int | None = None


class ASRSessionManager:
    def __init__(
        self,
        speaker_continuity_gap_ms: int = 1500,
        speaker_diarizer: SpeakerDiarizer | None = None,
    ) -> None:
        self.speaker_continuity_gap_ms = speaker_continuity_gap_ms
        self.speaker_diarizer = speaker_diarizer or LocalSpeakerDiarizer()
        self._sessions: dict[str, ASRSessionState] = {}
        self._lock = Lock()

    def accept_segment(
        self,
        seq: int,
        segment: TranscriptSegment,
        *,
        audio_b64: str | None = None,
        stream_id: str | None = None,
    ) -> ASRSessionDecision:
        with self._lock:
            state_key = stream_id or segment.session_id
            state = self._sessions.setdefault(state_key, ASRSessionState())
            existing = state.chunks.get(seq)
            if existing is not None and existing.segment.is_final and segment.is_final:
                return ASRSessionDecision(False, reason="duplicate_final_segment")
            if segment.is_final and seq <= state.last_final_seq:
                return ASRSessionDecision(False, reason="late_final_segment")

            resolved_speaker = self.speaker_diarizer.resolve_speaker(
                state_key,
                audio_b64,
                segment.speaker,
            )
            if resolved_speaker != segment.speaker:
                segment = segment.model_copy(update={"speaker": resolved_speaker})
            segment = self._smooth_speaker(state, segment)
            state.chunks[seq] = ASRSessionChunk(seq=seq, segment=segment)
            if segment.is_final:
                state.last_final_seq = max(state.last_final_seq, seq)
            if segment.speaker in {"interviewer", "candidate"}:
                state.last_known_speaker = segment.speaker
                state.last_known_end_ms = segment.end_ms
            return ASRSessionDecision(True, segment=segment)

    def close(self, session_id: str, *, stream_id: str | None = None) -> None:
        with self._lock:
            state_key = stream_id or session_id
            self._sessions.pop(state_key, None)
            self.speaker_diarizer.close(state_key)

    def reset(self) -> None:
        with self._lock:
            self._sessions.clear()
            self.speaker_diarizer.reset()

    def configure_speaker_diarizer(self, speaker_diarizer: SpeakerDiarizer) -> None:
        with self._lock:
            self._sessions.clear()
            self.speaker_diarizer.reset()
            self.speaker_diarizer = speaker_diarizer

    def _smooth_speaker(
        self,
        state: ASRSessionState,
        segment: TranscriptSegment,
    ) -> TranscriptSegment:
        if segment.speaker != "unknown" or state.last_known_speaker is None:
            return segment
        if state.last_known_end_ms is None:
            return segment
        gap_ms = segment.start_ms - state.last_known_end_ms
        if 0 <= gap_ms <= self.speaker_continuity_gap_ms:
            return segment.model_copy(update={"speaker": state.last_known_speaker})
        return segment


class ASREngine(ABC):
    @abstractmethod
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
        raise NotImplementedError


class StubASREngine(ASREngine):
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
        try:
            raw = base64.b64decode(audio_b64).decode("utf-8")
        except Exception:
            raw = ""
        resolved_start_ms, resolved_end_ms = _coerce_timestamp_bounds(
            start_ms,
            end_ms,
            seq=seq,
        )
        return TranscriptSegment(
            session_id=session_id,
            speaker=speaker or ("candidate" if seq % 2 else "interviewer"),
            text=raw or "本地 ASR stub 收到音频片段，生产环境请替换为云 ASR 或 faster-whisper。",
            start_ms=resolved_start_ms,
            end_ms=resolved_end_ms,
            is_final=is_final,
            confidence=0.8 if confidence is None else confidence,
        )


class HTTPASREngine(ASREngine):
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

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
        settings = get_settings()
        if not settings.asr_base_url:
            raise RuntimeError("ASR_PROVIDER=http requires ASR_BASE_URL")
        url = settings.asr_base_url.rstrip("/") + "/" + settings.asr_api_path.lstrip("/")
        payload = {
            "session_id": session_id,
            "seq": seq,
            "audio": audio_b64,
            "speaker": speaker,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "is_final": is_final,
            "confidence": confidence,
        }
        headers = _asr_headers()
        async with httpx.AsyncClient(
            timeout=settings.asr_timeout_seconds,
            transport=self._transport,
        ) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
        data = response.json()
        resolved_start_ms = _extract_optional(data, settings.asr_start_ms_path, start_ms)
        resolved_end_ms = _extract_optional(data, settings.asr_end_ms_path, end_ms)
        resolved_start_ms, resolved_end_ms = _coerce_timestamp_bounds(
            resolved_start_ms,
            resolved_end_ms,
            seq=seq,
        )
        resolved_confidence = _extract_optional(data, settings.asr_confidence_path, confidence)
        if resolved_confidence is None:
            resolved_confidence = 0.0
        resolved_final = _extract_optional(data, settings.asr_is_final_path, is_final)
        return TranscriptSegment(
            session_id=session_id,
            speaker=_coerce_speaker(_extract_optional(data, settings.asr_speaker_path, speaker)),
            text=str(_extract_path(data, settings.asr_text_path)),
            start_ms=resolved_start_ms,
            end_ms=resolved_end_ms,
            is_final=_coerce_bool(resolved_final),
            confidence=_clamp_float(resolved_confidence, minimum=0.0, maximum=1.0),
        )


def _asr_headers() -> dict[str, str]:
    settings = get_settings()
    if not settings.asr_api_key:
        return {}
    auth_value = (
        f"{settings.asr_auth_scheme} {settings.asr_api_key}"
        if settings.asr_auth_scheme
        else settings.asr_api_key
    )
    return {settings.asr_auth_header: auth_value}


def _speaker_diarization_headers() -> dict[str, str]:
    settings = get_settings()
    if not settings.speaker_diarization_api_key:
        return {}
    auth_value = (
        f"{settings.speaker_diarization_auth_scheme} {settings.speaker_diarization_api_key}"
        if settings.speaker_diarization_auth_scheme
        else settings.speaker_diarization_api_key
    )
    return {settings.speaker_diarization_auth_header: auth_value}


def _extract_path(payload: Any, path: str) -> Any:
    value = payload
    for part in path.split("."):
        if isinstance(value, list):
            value = value[int(part)]
        elif isinstance(value, dict):
            value = value[part]
        else:
            raise KeyError(path)
    return value


def _extract_optional(payload: Any, path: str, fallback: Any) -> Any:
    try:
        return _extract_path(payload, path)
    except (KeyError, IndexError, TypeError, ValueError):
        return fallback


def _coerce_speaker(value: Any) -> Speaker:
    if value in {"interviewer", "candidate", "unknown"}:
        return value
    return "unknown"


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in FALSE_FINALITY_VALUES:
            return False
        if lowered in TRUE_FINALITY_VALUES:
            return True
    return bool(value)


def _clamp_float(value: Any, *, minimum: float, maximum: float) -> float:
    resolved = float(value)
    return max(minimum, min(maximum, resolved))


def _coerce_timestamp_bounds(
    start_ms: Any,
    end_ms: Any,
    *,
    seq: int,
) -> tuple[int, int]:
    start = max(0, _coerce_int(start_ms, seq * 1000))
    end = _coerce_int(end_ms, start + 900)
    return start, max(start, end)


def _coerce_int(value: Any, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def get_asr_engine() -> ASREngine:
    settings = get_settings()
    if settings.asr_provider == "aliyun_ws":
        from services.asr_service.aliyun_engine import AliyunWSASREngine

        return AliyunWSASREngine()
    if settings.asr_provider == "aliyun_nls_ws":
        from services.asr_service.nls_engine import AliyunNLSWSASREngine

        return AliyunNLSWSASREngine()
    if settings.asr_provider == "sherpa_onnx":
        from services.asr_service.sherpa_engine import SherpaOnnxASREngine

        return SherpaOnnxASREngine()
    if settings.asr_provider == "http":
        return HTTPASREngine()
    return StubASREngine()


def get_speaker_diarizer() -> SpeakerDiarizer:
    settings = get_settings()
    if (
        settings.speaker_mode == "http_diarization"
        or settings.speaker_diarization_provider == "http"
    ):
        return HTTPSpeakerDiarizer()
    return LocalSpeakerDiarizer()


asr_session_manager = ASRSessionManager(speaker_diarizer=get_speaker_diarizer())


def configure_asr_runtime() -> None:
    asr_session_manager.configure_speaker_diarizer(get_speaker_diarizer())
