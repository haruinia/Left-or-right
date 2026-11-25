from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from libs.common.config import Settings
from libs.schemas import TranscriptSegment
from services.asr_service import xfyun_engine
from services.asr_service.xfyun_engine import XfyunRTASRSession
from services.gateway import asr_config, learning_assets, model_config, transcription

ORIGIN = {"Origin": "http://127.0.0.1:9958"}


def settings(**updates):
    values = {
        "_env_file": None,
        "asr_provider": "xfyun_rtasr",
        "xfyun_app_id": "synthetic-app-id",
        "xfyun_api_key": "synthetic-api-key",
    }
    return Settings(**values | updates)


def result_event(text="你好，世界。", final=True, start="120", end="980"):
    words = [{"cw": [{"w": character}]} for character in text]
    return {
        "action": "result",
        "code": "0",
        "data": json.dumps({
            "cn": {"st": {"type": "0" if final else "1", "bg": start, "ed": end, "rt": [{"ws": words}]}},
        }, ensure_ascii=False),
    }


class ConnectionClosedOK(Exception):
    pass


class FakeSocket:
    def __init__(self, *, handshake=None, disconnect=False):
        self.events = asyncio.Queue()
        self.events.put_nowait(json.dumps(handshake or {"action": "started", "code": "0"}))
        self.sent = []
        self.closed = 0
        self.fail_next_recv = False

    async def send(self, message):
        self.sent.append(message)
        if message == b'{"end":true}':
            assert len(self.sent) >= 2
            await self.events.put(json.dumps(result_event()))
            await self.events.put(ConnectionClosedOK())

    async def recv(self):
        event = await self.events.get()
        if self.fail_next_recv:
            self.fail_next_recv = False
            raise RuntimeError("signed wss URL and synthetic-api-key must not leak")
        if isinstance(event, Exception):
            raise event
        return event

    async def close(self):
        self.closed += 1


def test_signature_uses_md5_then_hmac_sha1_and_reuses_ssl(monkeypatch):
    calls = []
    context = object()
    monkeypatch.setattr(xfyun_engine, "_ssl_context", lambda: context)

    async def connect(url, **kwargs):
        calls.append((url, kwargs))
        return FakeSocket()

    monkeypatch.setattr(xfyun_engine, "signed_url", xfyun_engine.signed_url)
    import websockets
    monkeypatch.setattr(websockets, "connect", connect)
    session = XfyunRTASRSession("sign", settings=settings(), timestamp=1700000000)
    socket = asyncio.run(session._connect_websocket())
    assert isinstance(socket, FakeSocket)
    assert calls[0][1]["ssl"] is context
    assert calls[0][1]["proxy"] is None
    query = parse_qs(urlsplit(calls[0][0]).query)
    assert query["appid"] == ["synthetic-app-id"]
    assert query["ts"] == ["1700000000"]
    digest = hashlib.md5(b"synthetic-app-id1700000000").hexdigest()
    expected = base64.b64encode(hmac.new(b"synthetic-api-key", digest.encode(), hashlib.sha1).digest()).decode()
    assert query["signa"] == [expected]


def test_audio_frames_partial_final_and_close_drain_without_duplicate_none():
    async def run():
        ws = FakeSocket()
        session = XfyunRTASRSession("dual:mic", settings=settings(), ws=ws)
        await session.connect()
        await ws.events.put(json.dumps(result_event("临时内容", final=False, start="-4", end="90")))
        await session.send_audio(b"a" * 3000)
        await session.send_audio(b"b" * 700)
        await session.send_audio(b"c" * 980)
        assert [len(frame) for frame in ws.sent] == [1280, 1280, 1280]
        partial = await asyncio.wait_for(session.result_queue.get(), 1)
        assert partial.text == "临时内容" and partial.is_final is False
        assert (partial.start_ms, partial.end_ms) == (0, 90)
        await session.close()
        final = await asyncio.wait_for(session.result_queue.get(), 1)
        assert final.text == "你好，世界。" and final.is_final is True
        assert (final.start_ms, final.end_ms) == (120, 980)
        assert await asyncio.wait_for(session.result_queue.get(), 1) is None
        await session.close()
        assert session.result_queue.empty()
        assert ws.sent[-2] == b"c" * 840
        assert ws.closed == 1 and session.ws is None
        assert session._reader_task.done() and not session.error_reason

    asyncio.run(run())


def test_failed_handshake_and_disconnect_are_redacted_and_release_resources():
    async def run():
        failed = FakeSocket(handshake={"action": "error", "code": "10114", "desc": "invalid signature"})
        session = XfyunRTASRSession("failure", settings=settings(), ws=failed)
        with pytest.raises(RuntimeError) as error:
            await session.connect()
        assert "10114" in str(error.value)
        for private in ("synthetic-app-id", "synthetic-api-key", "signa="):
            assert private not in str(error.value)
        assert failed.closed == 1 and session.ws is None

        disconnected = FakeSocket(disconnect=True)
        disconnected.fail_next_recv = False
        await disconnected.events.put(RuntimeError("signed wss URL and synthetic-api-key must not leak"))
        session = XfyunRTASRSession("disconnect", settings=settings(), ws=disconnected)
        await session.connect()
        assert await asyncio.wait_for(session.result_queue.get(), 1) is None
        await session.close()
        assert "synthetic-api-key" not in session.error_reason
        assert disconnected.closed == 1 and session._reader_task.done()
        assert session.result_queue.empty()

    asyncio.run(run())


def test_xfyun_concurrency_rejection_has_actionable_error():
    detail = transcription._provider_failure_detail("xfyun_asr_server_error:10800:over max connect limit", "xfyun_rtasr")
    assert "并发连接额度不足" in detail and "双音源" in detail
    assert "10800" not in detail


def test_engine_factory_and_runtime_require_explicit_xfyun_credentials(monkeypatch):
    from services.asr_service.service import get_asr_engine
    from services.asr_service.xfyun_engine import XfyunRTASREngine
    monkeypatch.setattr("services.asr_service.service.get_settings", settings)
    assert isinstance(get_asr_engine(), XfyunRTASREngine)
    with pytest.raises(ValueError, match="XFYUN_APP_ID and XFYUN_API_KEY"):
        settings(xfyun_app_id="")


@pytest.fixture
def profile_files(tmp_path, monkeypatch):
    configured = settings(
        llm_provider="mock",
        database_url=f"sqlite:///{tmp_path}/test.db",
        aliyun_asr_api_key="old-bailian",
        aliyun_nls_token="old-nls",
    )
    monkeypatch.setattr(model_config, "profiles_path", lambda: tmp_path / "models.json")
    for module in (asr_config, transcription, learning_assets):
        monkeypatch.setattr(module, "get_settings", lambda: configured)
    return tmp_path


def xfyun(**updates):
    return asr_config.ProfileInput.model_validate({
        "name": "讯飞测试", "provider": "xfyun_rtasr", "app_id": "private-app-id", "api_key": "private-api-key", **updates,
    })


def test_profile_defaults_secret_privacy_and_snapshot_isolation(profile_files):
    response = asr_config.save_profile(xfyun())
    public = response["profiles"][0]
    assert public["endpoint"] == asr_config.XFYUN_ENDPOINT
    assert public["app_id_configured"] and public["api_key_configured"] and public["configured"]
    assert not public["app_key_configured"] and not public["nls_token_configured"]
    assert "private-app-id" not in json.dumps(response) and "private-api-key" not in json.dumps(response)
    selected, snapshot = asr_config.snapshot()
    assert selected.model == "" and selected.vocabulary_id == ""
    assert snapshot.xfyun_app_id == "private-app-id" and snapshot.xfyun_api_key == "private-api-key"
    assert snapshot.xfyun_sample_rate == 16000 and snapshot.xfyun_format == "pcm"
    assert snapshot.aliyun_asr_api_key == snapshot.aliyun_nls_token == snapshot.aliyun_nls_app_key == ""
    assert "private-app-id" not in repr(selected) and "private-api-key" not in repr(selected)


def test_xfyun_secrets_are_explicit_local_only_and_masked_on_edit(profile_files):
    identifier = asr_config.save_profile(xfyun())["active_profile_id"]
    app = FastAPI()
    app.include_router(transcription.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000)) as client:
        key = client.post(f"/api/config/asr/profiles/{identifier}/key", headers=ORIGIN)
        app_id = client.post(f"/api/config/asr/profiles/{identifier}/secrets/app_id", headers=ORIGIN)
        assert key.json() == {"api_key": "private-api-key"}
        assert app_id.json() == {"value": "private-app-id"}
        assert key.headers["cache-control"] == app_id.headers["cache-control"] == "no-store"
        assert client.post(f"/api/config/asr/profiles/{identifier}/secrets/app_key", headers=ORIGIN).status_code == 422
        denied = client.post(f"/api/config/asr/profiles/{identifier}/secrets/app_id", headers={"Origin": "https://evil.test"})
        assert denied.status_code == 403 and "private-app-id" not in denied.text
    asr_config.save_profile(asr_config.ProfileInput(id=identifier, name="只修改名称"))
    selected, snapshot = asr_config.snapshot()
    assert selected.name == "只修改名称" and snapshot.xfyun_app_id == "private-app-id"


class FakeXfyunProvider:
    instances = []

    def __init__(self, session_id, *, settings):
        self.session_id, self.settings = session_id, settings
        self.source = session_id.rsplit(":", 1)[-1]
        self.result_queue = asyncio.Queue()
        self.sent = []
        self.error_reason = ""
        self.started = self.finished = False
        self.ws = self._reader_task = None
        FakeXfyunProvider.instances.append(self)

    async def connect(self):
        await asyncio.sleep(0)
        self.started = True

    async def send_audio(self, pcm):
        self.sent.append(pcm)
        await self.result_queue.put(TranscriptSegment(session_id=self.session_id, speaker="unknown", text=f"{self.source} final", start_ms=100, end_ms=200, is_final=True, confidence=.9))

    async def close(self):
        if self.finished:
            return
        self.finished = True
        await self.result_queue.put(None)


def test_xfyun_dual_sources_keep_independent_audio_roles_and_cleanup(profile_files, monkeypatch):
    FakeXfyunProvider.instances = []
    asr_config.save_profile(xfyun())
    monkeypatch.setattr(transcription, "XfyunRTASRSession", FakeXfyunProvider)
    app = FastAPI()
    app.include_router(transcription.router)
    app.include_router(learning_assets.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000)) as client:
        with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as socket:
            socket.send_json({"type": "start", "role": "candidate", "sources": ["mic", "system"], "api_key": ""})
            assert socket.receive_json()["type"] == "ready"
            for source, pcm in (("mic", b"m\x00"), ("system", b"s\x00")):
                socket.send_json({"type": "audio", "source": source, "seq": 0, "audio": base64.b64encode(pcm).decode()})
            events = [socket.receive_json(), socket.receive_json()]
            assert {(event["source"], event["speaker"]) for event in events} == {("mic", "candidate"), ("system", "interviewer")}
            socket.send_json({"type": "stop"})
            while socket.receive_json()["type"] != "stopped":
                pass
    sessions = {item.source: item for item in FakeXfyunProvider.instances}
    assert sessions["mic"].sent == [b"m\x00"] and sessions["system"].sent == [b"s\x00"]
    assert all(item.finished for item in sessions.values())
    assert all(item.settings.aliyun_asr_api_key == item.settings.aliyun_nls_token == "" for item in sessions.values())
