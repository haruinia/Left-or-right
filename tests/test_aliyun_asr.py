from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from libs.common.config import Settings
from libs.schemas import TranscriptSegment
from scripts import check_aliyun_asr
from services.asr_service.aliyun_engine import AliyunASRSession


class FakeAliyunWS:
    def __init__(
        self,
        *,
        fail_on_audio: bool = False,
        fail_on_start: bool = False,
        heartbeat_first: bool = False,
    ) -> None:
        self.fail_on_audio = fail_on_audio
        self.fail_on_start = fail_on_start
        self.heartbeat_first = heartbeat_first
        self.closed = False
        self.sent: list[str | bytes] = []
        self._events: asyncio.Queue[str] = asyncio.Queue()

    async def send(self, message: str | bytes) -> None:
        self.sent.append(message)
        if isinstance(message, bytes):
            if self.fail_on_audio:
                await self._events.put(
                    json.dumps(
                        {
                            "header": {
                                "event": "task-failed",
                                "error_code": "InvalidAudio",
                                "error_message": "bad audio",
                            }
                        }
                    )
                )
                return
            if self.heartbeat_first:
                await self._events.put(
                    json.dumps(
                        {
                            "header": {"event": "result-generated"},
                            "payload": {
                                "output": {"sentence": {"heartbeat": True, "text": ""}}
                            },
                        }
                    )
                )
            await self._events.put(
                json.dumps(
                    {
                        "header": {"event": "result-generated"},
                        "payload": {
                            "output": {
                                "sentence": {
                                    "begin_time": 170,
                                    "end_time": 920,
                                    "text": "好，我知道了",
                                    "sentence_end": True,
                                }
                            }
                        },
                    }
                )
            )
            return
        data = json.loads(message)
        action = data.get("header", {}).get("action")
        if action == "run-task":
            if self.fail_on_start:
                await self._events.put(
                    json.dumps(
                        {
                            "header": {
                                "event": "task-failed",
                                "error_code": "InvalidApiKey",
                                "error_message": "bad key",
                            }
                        }
                    )
                )
                return
            await self._events.put(json.dumps({"header": {"event": "task-started"}}))
        elif action == "finish-task":
            assert data["header"]["streaming"] == "duplex"
            assert data["payload"] == {"input": {}}
            await self._events.put(json.dumps({"header": {"event": "task-finished"}}))

    async def recv(self) -> str:
        return await self._events.get()

    async def close(self) -> None:
        self.closed = True


def _settings() -> Settings:
    return Settings(asr_provider="aliyun_ws", aliyun_asr_api_key="dashscope-secret")


def test_aliyun_session_lifecycle() -> None:
    async def run() -> None:
        ws = FakeAliyunWS()
        session = AliyunASRSession("interview-1", settings=_settings(), ws=ws)

        await session.connect()
        await session.send_audio(b"\x00" * 3200)
        segment = await asyncio.wait_for(session.result_queue.get(), timeout=2)
        await session.close()

        assert segment is not None
        assert segment.session_id == "interview-1"
        assert segment.speaker == "unknown"
        assert segment.text == "好，我知道了"
        assert segment.start_ms == 170
        assert segment.end_ms == 920
        assert segment.is_final is True
        assert ws.closed is True

    asyncio.run(run())


def test_aliyun_session_skips_heartbeat() -> None:
    async def run() -> None:
        session = AliyunASRSession(
            "interview-1",
            settings=_settings(),
            ws=FakeAliyunWS(heartbeat_first=True),
        )

        await session.connect()
        await session.send_audio(b"\x00" * 3200)
        segment = await asyncio.wait_for(session.result_queue.get(), timeout=2)
        await session.close()

        assert segment is not None
        assert segment.text == "好，我知道了"

    asyncio.run(run())


def test_aliyun_session_handles_task_failed() -> None:
    async def run() -> None:
        session = AliyunASRSession(
            "interview-1",
            settings=_settings(),
            ws=FakeAliyunWS(fail_on_audio=True),
        )

        await session.connect()
        await session.send_audio(b"\x00" * 3200)
        item = await asyncio.wait_for(session.result_queue.get(), timeout=2)
        await session.close()

        assert item is None
        assert session.error_reason == "aliyun_asr_task_failed:InvalidAudio:bad audio"

    asyncio.run(run())


def test_aliyun_session_closes_websocket_when_start_fails() -> None:
    async def run() -> None:
        ws = FakeAliyunWS(fail_on_start=True)
        session = AliyunASRSession("interview-1", settings=_settings(), ws=ws)

        with pytest.raises(RuntimeError) as exc_info:
            await session.connect()

        assert "aliyun_asr_task_failed:InvalidApiKey:bad key" in str(exc_info.value)
        assert session.error_reason == "aliyun_asr_task_failed:InvalidApiKey:bad key"
        assert ws.closed is True
        assert session.ws is None

    asyncio.run(run())


def test_check_aliyun_asr_smoke_script_uses_pcm_file(
    tmp_path: Path, monkeypatch
) -> None:
    pcm_path = tmp_path / "sample.pcm"
    pcm_path.write_bytes(b"\x00" * 6400)
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FakeSmokeSession:
        instances: list["FakeSmokeSession"] = []

        def __init__(self, session_id: str, *, settings: Settings) -> None:
            self.session_id = session_id
            self.settings = settings
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()
            self.sent_audio: list[bytes] = []
            FakeSmokeSession.instances.append(self)

        async def connect(self) -> None:
            return None

        async def send_audio(self, pcm_bytes: bytes) -> None:
            self.sent_audio.append(pcm_bytes)

        async def close(self) -> None:
            await self.result_queue.put(
                TranscriptSegment(
                    session_id=self.session_id,
                    speaker="unknown",
                    text="水货杀手语音识别测试",
                    start_ms=0,
                    end_ms=1000,
                    is_final=True,
                    confidence=0.92,
                )
            )

    monkeypatch.setattr(check_aliyun_asr, "AliyunASRSession", FakeSmokeSession)

    exit_code = asyncio.run(check_aliyun_asr._run(pcm_path))

    assert exit_code == 0
    assert FakeSmokeSession.instances
    assert FakeSmokeSession.instances[0].sent_audio == [b"\x00" * 3200, b"\x00" * 3200]


def test_check_aliyun_asr_smoke_script_fails_without_transcript(
    tmp_path: Path, monkeypatch
) -> None:
    pcm_path = tmp_path / "sample.pcm"
    pcm_path.write_bytes(b"\x00" * 3200)
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FakeEmptySession:
        def __init__(self, session_id: str, *, settings: Settings) -> None:
            self.session_id = session_id
            self.settings = settings
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def connect(self) -> None:
            return None

        async def send_audio(self, pcm_bytes: bytes) -> None:
            return None

        async def close(self) -> None:
            return None

    monkeypatch.setattr(check_aliyun_asr, "AliyunASRSession", FakeEmptySession)

    exit_code = asyncio.run(check_aliyun_asr._run(pcm_path))

    assert exit_code == 1


def test_check_aliyun_asr_help_clarifies_allow_empty_result() -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "check_aliyun_asr.py"
    result = subprocess.run(
        [sys.executable, str(script), "--help"],
        check=True,
        capture_output=True,
        text=True,
    )

    help_text = " ".join(result.stdout.split())
    assert "Exit 0 when the ASR session completes but no transcript text is returned." in help_text
    assert "Treat a completed ASR session with no transcript text as success." not in help_text


def test_check_aliyun_asr_allow_empty_result_does_not_claim_transcript_verified(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    pcm_path = tmp_path / "sample.pcm"
    pcm_path.write_bytes(b"\x00" * 3200)
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FakeEmptySession:
        def __init__(self, session_id: str, *, settings: Settings) -> None:
            self.session_id = session_id
            self.settings = settings
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()

        async def connect(self) -> None:
            return None

        async def send_audio(self, pcm_bytes: bytes) -> None:
            return None

        async def close(self) -> None:
            return None

    monkeypatch.setattr(check_aliyun_asr, "AliyunASRSession", FakeEmptySession)

    exit_code = asyncio.run(check_aliyun_asr._run(pcm_path, allow_empty_result=True))

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "Aliyun ASR session completed, but no transcript text was verified." in captured.out
    assert "Aliyun ASR smoke test ok." not in captured.out


def test_check_aliyun_asr_smoke_script_closes_session_on_send_failure(
    tmp_path: Path, monkeypatch
) -> None:
    pcm_path = tmp_path / "sample.pcm"
    pcm_path.write_bytes(b"\x00" * 3200)
    monkeypatch.setenv("ALIYUN_ASR_API_KEY", "dashscope-secret")

    class FakeFailingSendSession:
        instances: list["FakeFailingSendSession"] = []

        def __init__(self, session_id: str, *, settings: Settings) -> None:
            self.session_id = session_id
            self.settings = settings
            self.result_queue: asyncio.Queue[TranscriptSegment | None] = asyncio.Queue()
            self.started = False
            self.finished = False
            FakeFailingSendSession.instances.append(self)

        async def connect(self) -> None:
            self.started = True

        async def send_audio(self, pcm_bytes: bytes) -> None:
            raise RuntimeError("aliyun_asr_disconnected")

        async def close(self) -> None:
            self.finished = True

    monkeypatch.setattr(check_aliyun_asr, "AliyunASRSession", FakeFailingSendSession)

    exit_code = asyncio.run(check_aliyun_asr._run(pcm_path))

    assert exit_code == 1
    assert FakeFailingSendSession.instances
    assert FakeFailingSendSession.instances[0].finished is True
