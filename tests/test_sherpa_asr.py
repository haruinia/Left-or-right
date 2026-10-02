from __future__ import annotations

import array
import asyncio
from pathlib import Path

import pytest

from libs.common.config import Settings
from services.asr_service.sherpa_engine import SherpaASRSession, SherpaOnnxASREngine


class FakeStream:
    def __init__(self) -> None:
        self.samples: list[float] = []

    def accept_waveform(self, sample_rate: int, samples: list[float]) -> None:
        del sample_rate
        self.samples.extend(samples)


class FakeRecognizer:
    def __init__(self) -> None:
        self.chunks = 0
        self.reset_count = 0

    def create_stream(self) -> FakeStream:
        return FakeStream()

    def is_ready(self, stream: FakeStream) -> bool:
        del stream
        return False

    def decode_stream(self, stream: FakeStream) -> None:
        del stream

    def get_result(self, stream: FakeStream) -> str:
        del stream
        if self.chunks == 1:
            return "你好"
        if self.chunks >= 2:
            return "你好世界"
        return ""

    def is_endpoint(self, stream: FakeStream) -> bool:
        del stream
        return self.chunks >= 2

    def reset(self, stream: FakeStream) -> None:
        del stream
        self.reset_count += 1
        self.chunks = 0


def _pcm_chunk(sample_count: int = 1600) -> bytes:
    samples = array.array("h", [1000] * sample_count)
    return samples.tobytes()


def test_settings_accepts_sherpa_onnx_asr_provider() -> None:
    settings = Settings(asr_provider="sherpa_onnx")
    assert settings.asr_provider == "sherpa_onnx"
    assert settings.sherpa_asr_use_int8 is True
    assert settings.sherpa_asr_rule2_min_trailing_silence == 0.8


def test_settings_rejects_empty_sherpa_model_dir() -> None:
    with pytest.raises(ValueError, match="SHERPA_ASR_MODEL_DIR"):
        Settings(asr_provider="sherpa_onnx", sherpa_asr_model_dir="  ")


def test_sherpa_session_emits_partial_then_final() -> None:
    recognizer = FakeRecognizer()

    async def _run() -> list[str]:
        session = SherpaASRSession(
            "sess-1",
            settings=Settings(asr_provider="sherpa_onnx"),
            recognizer=recognizer,
        )
        await session.connect()

        async def feed() -> None:
            recognizer.chunks = 1
            await session.send_audio(_pcm_chunk())
            recognizer.chunks = 2
            await session.send_audio(_pcm_chunk())
            await session.close()

        feeder = asyncio.create_task(feed())
        texts: list[tuple[str, bool]] = []
        while True:
            item = await session.result_queue.get()
            if item is None:
                break
            texts.append((item.text, item.is_final))
        await feeder
        return texts

    results = asyncio.run(_run())
    assert ("你好", False) in results
    assert ("你好世界", False) in results
    assert ("你好世界", True) in results
    assert recognizer.reset_count == 1


def test_sherpa_engine_reuses_session(tmp_path: Path) -> None:
    recognizer = FakeRecognizer()
    engine = SherpaOnnxASREngine(
        settings=Settings(asr_provider="sherpa_onnx"),
        recognizer=recognizer,
    )

    async def _run() -> None:
        first = await engine.get_or_create_session("stream-a")
        second = await engine.get_or_create_session("stream-a")
        assert first is second
        await engine.close_session("stream-a")

    asyncio.run(_run())
