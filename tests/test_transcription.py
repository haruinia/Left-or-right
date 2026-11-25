from __future__ import annotations

import asyncio
import base64
import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from libs.common.config import Settings
from libs.schemas import TranscriptSegment
from services.gateway import asr_config, learning_assets, model_config, transcription

ORIGIN = {"Origin": "http://127.0.0.1:9958"}


class Sessions:
    def __init__(self):
        self.items = []
        self.fail_connect = ""
        self.connect_reason = ""
        self.fail_send = ""
        self.block_connect = False
        self.connect_entered = threading.Event()
        self.tail = False
        self.duplicates = False
        self.same_text = False
        self.provider_end = False

    def create(self, session_id, *, settings):
        session = FakeSession(session_id, settings, self)
        self.items.append(session)
        return session


class FakeSession:
    def __init__(self, session_id, settings, owner):
        self.session_id, self.settings, self.owner = session_id, settings, owner
        self.source = session_id.rsplit(":", 1)[-1] if ":" in session_id else "check"
        self.result_queue = asyncio.Queue()
        self.sent = []
        self.started = self.finished = self.closed = self.cancelled = False
        self.error_reason = ""
        self.ws = None
        self._reader_task = None

    async def connect(self):
        self.owner.connect_entered.set()
        if self.owner.block_connect:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if self.owner.fail_connect == self.source:
            self.error_reason = self.owner.connect_reason
            raise RuntimeError(f"provider rejected secret {self.settings.aliyun_asr_api_key}")
        self.started = True

    def segment(self, text, start, final):
        return TranscriptSegment(session_id=self.session_id, speaker="unknown", text=text, start_ms=start, end_ms=start + 100, is_final=final, confidence=.9)

    async def send_audio(self, pcm):
        self.sent.append(pcm)
        if self.owner.fail_send == self.source:
            raise RuntimeError(f"send failed with {self.settings.aliyun_asr_api_key}")
        if self.owner.provider_end:
            self.error_reason = f"upstream included {self.settings.aliyun_asr_api_key}"
            await self.result_queue.put(None)
            return
        start = (len(self.sent) - 1) * 100
        text = "重复的句子" if self.owner.same_text else f"{self.source} final"
        await self.result_queue.put(self.segment(f"{self.source} partial", start, False))
        final = self.segment(text, start, True)
        await self.result_queue.put(final)
        if self.owner.duplicates:
            await self.result_queue.put(final)
            await self.result_queue.put(self.segment("late partial", start, False))

    async def close(self):
        if self.closed:
            return
        self.closed = self.finished = True
        if self.owner.tail and self.started and self.source != "check":
            await self.result_queue.put(self.segment(f"{self.source} tail", 200, True))
        await self.result_queue.put(None)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, llm_provider="mock", database_url=f"sqlite:///{tmp_path}/data.db")
    monkeypatch.setattr(model_config, "profiles_path", lambda: tmp_path / "model_profiles.json")
    for module in (asr_config, transcription, learning_assets):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    asr_config.save_profile(asr_config.ProfileInput(name="测试语音", api_key="synthetic-secret"))
    sessions = Sessions()
    monkeypatch.setattr(transcription, "AliyunASRSession", sessions.create)
    app = FastAPI()
    app.include_router(transcription.router)
    app.include_router(learning_assets.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000)) as client:
        yield client, sessions, settings


def start(ws, role="candidate", sources=None, api_key=""):
    ws.send_json({"type": "start", "role": role, "sources": sources or ["mic", "system"], "api_key": api_key})
    event = ws.receive_json()
    assert event["type"] == "ready", event
    return event


def audio(ws, source, pcm=b"\x01\x00\x02\x00", seq=0, **extra):
    ws.send_json({"type": "audio", "source": source, "seq": seq, "audio": base64.b64encode(pcm).decode(), **extra})


def until_stopped(ws):
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        if event["type"] == "stopped":
            return events


@pytest.mark.parametrize("role,expected", [("candidate", {"mic": "candidate", "system": "interviewer"}), ("interviewer", {"mic": "interviewer", "system": "candidate"})])
def test_two_sources_receive_separate_pcm_and_correct_roles(setup, role, expected):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        ready = start(ws, role)
        assert len(sessions.items) == 2
        assert "synthetic-secret" not in json.dumps(ready)
        audio(ws, "mic", b"\x01\x00")
        audio(ws, "system", b"\x02\x00")
        received = [ws.receive_json() for _ in range(4)]
        for item in received:
            assert item["speaker"] == expected[item["source"]]
            assert item["segment_id"] == f"{item['source']}:0"
        ws.send_json({"type": "stop"})
        stopped = until_stopped(ws)[-1]
        assert stopped["saved"] is True
        assert stopped["record"]["id"] == ready["session_id"]
        assert stopped["record"]["turnCount"] == 2
        assert stopped["record"]["kind"] == "transcription"
    by_source = {session.source: session for session in sessions.items}
    assert by_source["mic"].sent == [b"\x01\x00"]
    assert by_source["system"].sent == [b"\x02\x00"]
    assert all(session.closed for session in sessions.items)
    records = client.get("/api/learning-assets/sessions").json()["items"]
    assert len(records) == 1
    assert all("audio" not in turn and "images" not in turn for turn in records[0]["turns"])
    assert "synthetic-secret" not in json.dumps(records)


def test_stop_drains_tail_finals_and_deduplicates_without_cross_source_echo_deletion(setup):
    client, sessions, _settings = setup
    sessions.tail = sessions.duplicates = sessions.same_text = True
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws)
        audio(ws, "mic")
        audio(ws, "system")
        ws.send_json({"type": "stop"})
        events = until_stopped(ws)
    stopped = events[-1]
    assert stopped["record"]["turnCount"] == 4
    assert [turn["text"] for turn in stopped["record"]["turns"]].count("重复的句子") == 2
    finals = [event for event in events if event["type"] == "transcript" and event["is_final"]]
    assert len(finals) == 4
    assert not any(event.get("text") == "late partial" for event in events)
    assert {event["source"] for event in finals if event["start_ms"] == 200} == {"mic", "system"}


def test_empty_session_is_not_saved_and_one_source_is_supported(setup):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws, sources=["mic"])
        ws.send_json({"type": "stop"})
        stopped = until_stopped(ws)[-1]
    assert len(sessions.items) == 1 and sessions.items[0].source == "mic"
    assert stopped["saved"] is False and stopped["record"] is None
    assert client.get("/api/learning-assets/sessions").json()["items"] == []


@pytest.mark.parametrize("frame", [
    {"type": "audio", "source": "mic", "seq": True, "audio": "AAA="},
    {"type": "audio", "source": "mic", "seq": 1, "audio": "AAA="},
    {"type": "audio", "source": "unknown", "seq": 0, "audio": "AAA="},
    {"type": "audio", "source": "mic", "seq": 0, "audio": "not-base64"},
    {"type": "audio", "source": "mic", "seq": 0, "audio": "AA=="},
    {"type": "audio", "source": "mic", "seq": 0, "audio": base64.b64encode(b"\0" * 32002).decode()},
    {"type": "audio", "source": "mic", "seq": 0, "audio": "AAA=", "speaker": "interviewer"},
    {"type": "unexpected"},
])
def test_invalid_audio_stops_both_sources_without_forwarding(setup, frame):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws)
        ws.send_json(frame)
        events = until_stopped(ws)
    assert any(event["type"] == "error" for event in events)
    assert all(session.closed and not session.sent for session in sessions.items)
    assert "synthetic-secret" not in json.dumps(events)


def test_sequence_is_monotonic_independently_per_source(setup):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws)
        audio(ws, "mic", seq=0)
        audio(ws, "system", seq=0)
        audio(ws, "mic", seq=1)
        ws.send_json({"type": "stop"})
        events = until_stopped(ws)
    assert not any(event["type"] == "error" for event in events)
    assert [len(session.sent) for session in sessions.items] == [2, 1]


@pytest.mark.parametrize("origin", [None, "null", "http://evil.test", "http://127.0.0.1:9960", "https://127.0.0.1:9958", "http://127.0.0.1:9958/path"])
def test_cross_origin_websockets_are_rejected_before_provider_creation(setup, origin):
    client, sessions, _settings = setup
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers={"Origin": origin} if origin else {}):
            pass
    assert exc.value.code == 1008
    assert not sessions.items


def test_first_frame_authentication_does_not_accept_query_credentials(setup):
    client, sessions, settings = setup
    settings.gateway_api_key = "gateway-test-key"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription?api_key=gateway-test-key", headers=ORIGIN) as ws:
            ws.send_json({"type": "start", "role": "candidate", "sources": ["mic"], "api_key": "wrong"})
            ws.receive_json()
    assert not sessions.items
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws, api_key="gateway-test-key")
        ws.send_json({"type": "stop"})
        until_stopped(ws)


@pytest.mark.parametrize("frame", [
    {"type": "start", "role": "candidate", "sources": ["mic", "mic"]},
    {"type": "start", "role": "unknown", "sources": ["mic"]},
    {"type": "start", "role": "candidate", "sources": []},
    {"type": "start", "role": "candidate", "sources": ["mic"], "speaker": "interviewer"},
])
def test_invalid_start_does_not_allocate_provider_sessions(setup, frame):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        ws.send_json(frame)
        assert ws.receive_json()["code"] == "invalid_start"
    assert not sessions.items


def test_active_profile_is_snapshotted_for_the_whole_session(setup):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        ready = start(ws)
        response = client.post("/api/config/asr/profiles", json={"id": ready["profile"]["id"], "name": "改名", "api_key": "new-key", "model": "new-model"})
        assert response.status_code == 200
        audio(ws, "mic")
        ws.send_json({"type": "stop"})
        events = until_stopped(ws)
    assert all(session.settings.aliyun_asr_api_key == "synthetic-secret" for session in sessions.items)
    assert all(session.settings.aliyun_asr_model == "paraformer-realtime-v2" for session in sessions.items)
    assert events[-1]["record"]["note"] == "面试转写 · 测试语音"


@pytest.mark.parametrize("failure", ["connect", "send", "reader"])
def test_upstream_failures_are_redacted_and_close_both_sources(setup, failure):
    client, sessions, _settings = setup
    if failure == "connect":
        sessions.fail_connect = "system"
    elif failure == "send":
        sessions.fail_send = "mic"
    else:
        sessions.provider_end = True
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        if failure == "connect":
            ws.send_json({"type": "start", "role": "candidate", "sources": ["mic", "system"]})
        else:
            start(ws)
            audio(ws, "mic")
        events = until_stopped(ws)
    assert any(event["type"] == "error" for event in events)
    assert all(session.closed for session in sessions.items)
    assert "synthetic-secret" not in json.dumps(events)


def test_stop_during_connect_cancels_pending_startup(setup):
    client, sessions, _settings = setup
    sessions.block_connect = True
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        ws.send_json({"type": "start", "role": "candidate", "sources": ["mic", "system"]})
        assert sessions.connect_entered.wait(2)
        ws.send_json({"type": "stop"})
        events = until_stopped(ws)
    assert not any(event["type"] == "ready" for event in events)
    assert all(session.closed and session.cancelled for session in sessions.items)


def test_disconnect_releases_both_channels_and_saves_final_text(setup):
    client, sessions, _settings = setup
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        ready = start(ws)
        audio(ws, "mic")
        ws.receive_json()
        assert ws.receive_json()["is_final"] is True
        ws.close()
        deadline = time.monotonic() + 2
        records = []
        while time.monotonic() < deadline:
            records = client.get("/api/learning-assets/sessions").json()["items"]
            if records:
                break
            time.sleep(.01)
        assert records[0]["id"] == ready["session_id"]
    assert all(session.closed for session in sessions.items)


def test_save_failure_returns_retryable_text_record_without_audio(setup, monkeypatch):
    client, sessions, _settings = setup
    def fail_save(*_args):
        raise OSError("disk unavailable")
    monkeypatch.setattr(transcription, "upsert_asset", fail_save)
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as ws:
        start(ws)
        audio(ws, "mic")
        ws.send_json({"type": "stop"})
        events = until_stopped(ws)
    assert any(event.get("code") == "save_failed" for event in events)
    stopped = events[-1]
    assert not stopped["saved"] and stopped["record"]["turnCount"] == 1
    for _ in range(2):
        assert client.post("/api/learning-assets/sessions/upsert", json={"item": stopped["record"]}).status_code == 200
    assert len(client.get("/api/learning-assets/sessions").json()["items"]) == 1


def test_provider_close_timeout_cancels_reader_and_aborts_owned_transport(monkeypatch):
    monkeypatch.setattr(transcription, "CLOSE_TIMEOUT", .02)
    async def run():
        aborted = []
        class Transport:
            def abort(self):
                aborted.append(True)
        class Socket:
            transport = Transport()
        class HungSession:
            ws = Socket()
            _reader_task = asyncio.create_task(asyncio.Event().wait())
            async def close(self):
                await asyncio.Event().wait()
        session = HungSession()
        with pytest.raises(TimeoutError):
            await transcription._close_provider(session)
        assert session._reader_task.cancelled()
        assert aborted == [True]
    asyncio.run(run())


@pytest.mark.parametrize('reason,expected', [
    ('AccessDenied.Unpurchased', '充值不等于服务开通'),
    ('Model.AccessDenied', '模型授权'),
    ('Workspace.AccessDenied', '模型授权'),
    ('InvalidApiKey', '所属地域'),
    ('Arrearage', '计费状态'),
])
def test_provider_configuration_errors_are_actionable_and_never_echo_secrets(setup, reason, expected):
    client, sessions, _settings = setup
    sessions.fail_connect = 'check'
    sessions.connect_reason = f'{reason}: synthetic-secret'
    profile_id = asr_config.list_response()['active_profile_id']
    result = client.post(f'/api/config/asr/profiles/{profile_id}/check').json()
    assert result['ok'] is False
    assert expected in result['detail']
    assert 'synthetic-secret' not in json.dumps(result)
    assert all(session.closed for session in sessions.items)


def test_start_reports_model_permission_failure_and_closes_both_sources(setup):
    client, sessions, _settings = setup
    sessions.fail_connect = 'mic'
    sessions.connect_reason = 'AccessDenied.Unpurchased: synthetic-secret'
    with client.websocket_connect('ws://127.0.0.1:9958/ws/transcription', headers=ORIGIN) as ws:
        ws.send_json({'type':'start','role':'candidate','sources':['mic','system'],'api_key':''})
        error = ws.receive_json()
        assert error['type'] == 'error' and error['code'] == 'connect_failed'
        assert '充值不等于服务开通' in error['detail']
        assert 'synthetic-secret' not in json.dumps(error)
        stopped = ws.receive_json()
        assert stopped['type'] == 'stopped'
    assert len(sessions.items) == 2 and all(session.closed for session in sessions.items)


def test_connectivity_check_sends_bounded_audio_without_claiming_text_accuracy(setup):
    client, sessions, _settings = setup
    profile_id = asr_config.list_response()["active_profile_id"]
    checked = client.post(f"/api/config/asr/profiles/{profile_id}/check").json()
    assert checked["ok"] is True
    assert "音频验证通过" in checked["detail"]
    assert len(sessions.items) == 1 and sessions.items[0].closed
    assert len(sessions.items[0].sent) == 1 and len(sessions.items[0].sent[0]) == 1600
    sessions.fail_connect = "check"
    failed = client.post(f"/api/config/asr/profiles/{profile_id}/check").json()
    assert not failed["ok"] and "synthetic-secret" not in json.dumps(failed)
    assert all(session.closed for session in sessions.items)
