from __future__ import annotations

import asyncio
import base64

import httpx
import pytest

from libs.common.config import get_settings
from libs.schemas import TranscriptSegment
from services.asr_service.service import (
    ASRSessionManager,
    HTTPSpeakerDiarizer,
    HTTPASREngine,
    LocalSpeakerDiarizer,
    StubASREngine,
    asr_session_manager,
    configure_asr_runtime,
    get_asr_engine,
    get_speaker_diarizer,
)
from services.asr_service.aliyun_engine import AliyunWSASREngine
from services.asr_service.nls_engine import AliyunNLSWSASREngine
from services.asr_service.xfyun_engine import XfyunRTASREngine


def test_stub_asr_decodes_text_and_metadata() -> None:
    engine = StubASREngine()
    audio = base64.b64encode("候选人的回答".encode("utf-8")).decode("ascii")

    segment = asyncio.run(engine.transcribe_chunk(
        "session-1",
        2,
        audio,
        speaker="candidate",
        start_ms=100,
        end_ms=900,
        is_final=False,
        confidence=0.7,
    ))

    assert segment.text == "候选人的回答"
    assert segment.speaker == "candidate"
    assert segment.start_ms == 100
    assert segment.end_ms == 900
    assert segment.is_final is False
    assert segment.confidence == 0.7


def test_stub_asr_normalizes_string_timestamp_bounds() -> None:
    engine = StubASREngine()
    audio = base64.b64encode("候选人的回答".encode("utf-8")).decode("ascii")

    segment = asyncio.run(
        engine.transcribe_chunk("session-1", 2, audio, start_ms="-10", end_ms="5.8")
    )

    assert segment.start_ms == 0
    assert segment.end_ms == 5


def test_transcript_segment_rejects_blank_contract_fields() -> None:
    with pytest.raises(ValueError, match="transcript segment session_id"):
        TranscriptSegment(
            session_id=" ",
            speaker="candidate",
            text="候选人的回答",
            start_ms=0,
            end_ms=100,
            is_final=True,
            confidence=0.8,
        )

    with pytest.raises(ValueError, match="transcript segment text"):
        TranscriptSegment(
            session_id="session-1",
            speaker="candidate",
            text=" ",
            start_ms=0,
            end_ms=100,
            is_final=True,
            confidence=0.8,
        )


def test_http_asr_engine_posts_audio_and_maps_response(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "result": {
                    "text": "我写了 FastAPI 的异常降级。",
                    "speaker": "candidate",
                    "start_ms": 120,
                    "end_ms": 980,
                    "is_final": True,
                    "confidence": 0.91,
                }
            },
        )

    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com/v1")
    monkeypatch.setenv("ASR_API_PATH", "/streaming/transcribe")
    monkeypatch.setenv("ASR_API_KEY", "asr-secret")
    monkeypatch.setenv("ASR_TEXT_PATH", "result.text")
    monkeypatch.setenv("ASR_SPEAKER_PATH", "result.speaker")
    monkeypatch.setenv("ASR_START_MS_PATH", "result.start_ms")
    monkeypatch.setenv("ASR_END_MS_PATH", "result.end_ms")
    monkeypatch.setenv("ASR_IS_FINAL_PATH", "result.is_final")
    monkeypatch.setenv("ASR_CONFIDENCE_PATH", "result.confidence")
    get_settings.cache_clear()
    engine = HTTPASREngine(transport=httpx.MockTransport(handler))

    segment = asyncio.run(engine.transcribe_chunk(
        "session-1",
        7,
        "YXVkaW8=",
        speaker="candidate",
        start_ms=100,
        end_ms=900,
        is_final=False,
        confidence=0.5,
    ))

    assert segment.text == "我写了 FastAPI 的异常降级。"
    assert segment.speaker == "candidate"
    assert segment.start_ms == 120
    assert segment.end_ms == 980
    assert segment.is_final is True
    assert segment.confidence == 0.91
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://asr.example.com/v1/streaming/transcribe"
    assert request.headers["Authorization"] == "Bearer asr-secret"
    assert b'"seq":7' in request.content
    assert b'"audio":"YXVkaW8="' in request.content


def test_http_asr_engine_coerces_string_final_and_clamps_confidence(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "text": "临时识别片段",
                "speaker": "candidate",
                "is_final": "false",
                "confidence": 1.7,
            },
        )

    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com")
    get_settings.cache_clear()
    engine = HTTPASREngine(transport=httpx.MockTransport(handler))

    segment = asyncio.run(
        engine.transcribe_chunk(
            "session-1",
            3,
            "YXVkaW8=",
            speaker="candidate",
            start_ms=100,
            end_ms=900,
            is_final=True,
            confidence=0.5,
        )
    )

    assert segment.is_final is False
    assert segment.confidence == 1.0


def test_http_asr_engine_treats_partial_strings_as_non_final(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "text": "临时识别片段",
                "speaker": "candidate",
                "is_final": "partial",
                "confidence": 0.8,
            },
        )

    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com")
    get_settings.cache_clear()
    engine = HTTPASREngine(transport=httpx.MockTransport(handler))

    segment = asyncio.run(engine.transcribe_chunk("session-1", 3, "YXVkaW8="))

    assert segment.is_final is False


def test_http_asr_engine_normalizes_timestamp_bounds(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "text": "时间戳异常片段",
                "speaker": "candidate",
                "start_ms": "-120",
                "end_ms": "-240",
                "is_final": "final",
                "confidence": 0.8,
            },
        )

    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com")
    get_settings.cache_clear()
    engine = HTTPASREngine(transport=httpx.MockTransport(handler))

    segment = asyncio.run(engine.transcribe_chunk("session-1", 3, "YXVkaW8="))

    assert segment.start_ms == 0
    assert segment.end_ms == 0
    assert segment.is_final is True


def test_http_asr_engine_rejects_blank_transcript_text(monkeypatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "   ", "speaker": "candidate"})

    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com")
    get_settings.cache_clear()
    engine = HTTPASREngine(transport=httpx.MockTransport(handler))

    with pytest.raises(ValueError, match="transcript segment text"):
        asyncio.run(engine.transcribe_chunk("session-1", 3, "YXVkaW8="))


def test_get_asr_engine_uses_http_provider(monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "http")
    monkeypatch.setenv("ASR_BASE_URL", "https://asr.example.com")
    get_settings.cache_clear()

    assert isinstance(get_asr_engine(), HTTPASREngine)


def test_get_asr_engine_uses_aliyun_ws_provider(monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_ws")
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")
    get_settings.cache_clear()

    assert isinstance(get_asr_engine(), AliyunWSASREngine)


def test_get_asr_engine_uses_aliyun_nls_ws_provider(monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "aliyun_nls_ws")
    monkeypatch.setenv("ALIYUN_NLS_APP_KEY", "nls-app-key")
    monkeypatch.setenv("ALIYUN_NLS_TOKEN", "nls-token")
    get_settings.cache_clear()

    assert isinstance(get_asr_engine(), AliyunNLSWSASREngine)


def test_get_asr_engine_uses_xfyun_rtasr_provider(monkeypatch) -> None:
    monkeypatch.setenv("ASR_PROVIDER", "xfyun_rtasr")
    monkeypatch.setenv("XFYUN_APP_ID", "synthetic-app-id")
    monkeypatch.setenv("XFYUN_API_KEY", "synthetic-api-key")
    get_settings.cache_clear()

    assert isinstance(get_asr_engine(), XfyunRTASREngine)


def test_asr_session_manager_accepts_partial_then_final_same_seq() -> None:
    manager = ASRSessionManager()
    partial = TranscriptSegment(
        session_id="session-1",
        speaker="candidate",
        text="我写了",
        start_ms=0,
        end_ms=400,
        is_final=False,
        confidence=0.6,
    )
    final = partial.model_copy(update={"text": "我写了 FastAPI 编排。", "is_final": True})

    first = manager.accept_segment(1, partial)
    second = manager.accept_segment(1, final)
    duplicate = manager.accept_segment(1, final)

    assert first.accepted is True
    assert second.accepted is True
    assert second.segment is not None
    assert second.segment.text == "我写了 FastAPI 编排。"
    assert duplicate.accepted is False
    assert duplicate.reason == "duplicate_final_segment"


def test_asr_session_manager_isolates_sequence_numbers_by_stream() -> None:
    manager = ASRSessionManager()
    segment = TranscriptSegment(
        session_id="interview-1",
        speaker="candidate",
        text="回答",
        start_ms=0,
        end_ms=1000,
        is_final=True,
        confidence=0.9,
    )

    first = manager.accept_segment(1, segment, stream_id="device-a")
    second = manager.accept_segment(1, segment, stream_id="device-b")
    duplicate = manager.accept_segment(1, segment, stream_id="device-a")

    assert first.accepted is True
    assert second.accepted is True
    assert duplicate.accepted is False
    assert duplicate.reason == "duplicate_final_segment"


def test_asr_session_manager_smooths_unknown_speaker_by_continuity() -> None:
    manager = ASRSessionManager(speaker_continuity_gap_ms=1000)
    known = TranscriptSegment(
        session_id="session-1",
        speaker="candidate",
        text="第一段",
        start_ms=0,
        end_ms=500,
        is_final=True,
        confidence=0.9,
    )
    unknown = TranscriptSegment(
        session_id="session-1",
        speaker="unknown",
        text="连续补充",
        start_ms=800,
        end_ms=1200,
        is_final=True,
        confidence=0.7,
    )

    manager.accept_segment(1, known)
    decision = manager.accept_segment(2, unknown)

    assert decision.accepted is True
    assert decision.segment is not None
    assert decision.segment.speaker == "candidate"


def test_asr_session_manager_does_not_fake_voiceprint_matching() -> None:
    manager = ASRSessionManager(speaker_continuity_gap_ms=0)
    audio = base64.b64encode(b"candidate-voiceprint").decode("ascii")
    known = TranscriptSegment(
        session_id="session-1",
        speaker="candidate",
        text="第一段",
        start_ms=0,
        end_ms=500,
        is_final=True,
        confidence=0.9,
    )
    unknown_same_voice = TranscriptSegment(
        session_id="session-1",
        speaker="unknown",
        text="同一个说话人稍后补充",
        start_ms=5000,
        end_ms=5600,
        is_final=True,
        confidence=0.7,
    )

    manager.accept_segment(1, known, audio_b64=audio)
    decision = manager.accept_segment(2, unknown_same_voice, audio_b64=audio)

    assert decision.accepted is True
    assert decision.segment is not None
    assert decision.segment.speaker == "unknown"


def test_http_speaker_diarizer_maps_unknown_speaker(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"result": {"speaker": "candidate"}})

    monkeypatch.setenv("SPEAKER_DIARIZATION_PROVIDER", "http")
    monkeypatch.setenv("SPEAKER_DIARIZATION_BASE_URL", "https://diarize.example.com/v1")
    monkeypatch.setenv("SPEAKER_DIARIZATION_API_PATH", "/resolve")
    monkeypatch.setenv("SPEAKER_DIARIZATION_API_KEY", "diarize-secret")
    monkeypatch.setenv("SPEAKER_DIARIZATION_SPEAKER_PATH", "result.speaker")
    get_settings.cache_clear()
    diarizer = HTTPSpeakerDiarizer(transport=httpx.MockTransport(handler))

    speaker = diarizer.resolve_speaker(
        "session-1",
        base64.b64encode(b"audio").decode("ascii"),
        "unknown",
    )

    assert speaker == "candidate"
    assert len(requests) == 1
    assert str(requests[0].url) == "https://diarize.example.com/v1/resolve"
    assert requests[0].headers["Authorization"] == "Bearer diarize-secret"
    assert b'"session_id":"session-1"' in requests[0].content


def test_get_speaker_diarizer_uses_http_provider(monkeypatch) -> None:
    monkeypatch.setenv("SPEAKER_DIARIZATION_PROVIDER", "http")
    monkeypatch.setenv("SPEAKER_DIARIZATION_BASE_URL", "https://diarize.example.com")
    get_settings.cache_clear()

    assert isinstance(get_speaker_diarizer(), HTTPSpeakerDiarizer)


def test_configure_asr_runtime_reloads_speaker_diarizer_from_settings(monkeypatch) -> None:
    monkeypatch.setenv("SPEAKER_DIARIZATION_PROVIDER", "http")
    monkeypatch.setenv("SPEAKER_DIARIZATION_BASE_URL", "https://diarize.example.com")
    get_settings.cache_clear()

    configure_asr_runtime()

    assert isinstance(asr_session_manager.speaker_diarizer, HTTPSpeakerDiarizer)

    monkeypatch.setenv("SPEAKER_DIARIZATION_PROVIDER", "local")
    get_settings.cache_clear()
    configure_asr_runtime()

    assert isinstance(asr_session_manager.speaker_diarizer, LocalSpeakerDiarizer)


def test_get_speaker_diarizer_defaults_to_local(monkeypatch) -> None:
    monkeypatch.delenv("SPEAKER_DIARIZATION_PROVIDER", raising=False)
    get_settings.cache_clear()

    assert isinstance(get_speaker_diarizer(), LocalSpeakerDiarizer)
