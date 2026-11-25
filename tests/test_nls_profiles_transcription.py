import asyncio
import base64
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from libs.common.config import Settings
from libs.schemas import TranscriptSegment
from services.asr_service.nls_token import AliyunNLSToken, AliyunNLSTokenProvider
from services.gateway import asr_config, learning_assets, model_config, transcription

ORIGIN = {"Origin": "http://127.0.0.1:9958"}
SECRET_FIELDS = ["app_key", "nls_token", "access_key_id", "access_key_secret"]


def nls(**overrides):
    return asr_config.ProfileInput.model_validate({"name": "NLS 测试", "provider": "aliyun_nls_ws", "app_key": "test-project-key", "nls_token": "test-temporary-token", **overrides})


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, llm_provider="mock", database_url=f"sqlite:///{tmp_path}/test.db", aliyun_asr_api_key="old-bailian-key", aliyun_nls_token="global-token", aliyun_ak_id="global-id", aliyun_ak_secret="global-secret")
    monkeypatch.setattr(model_config, "profiles_path", lambda: tmp_path / "model_profiles.json")
    for module in (asr_config, transcription, learning_assets):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    asr_config._TOKEN_PROVIDERS.clear()
    app = FastAPI()
    app.include_router(transcription.router)
    app.include_router(learning_assets.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000)) as client:
        yield client, settings, tmp_path
    asr_config._TOKEN_PROVIDERS.clear()


def test_old_bailian_profiles_remain_readable_and_configured(runtime):
    _client, _settings, directory = runtime
    original = {"id": "legacy", "name": "旧百炼", "provider": "aliyun_ws", "endpoint": asr_config.DEFAULT_ENDPOINT, "model": "paraformer-realtime-v2", "api_key": "legacy-private-key"}
    (directory / "asr_profiles.json").write_text(json.dumps({"profiles": [original], "active_profile_id": "legacy"}))
    result = asr_config.list_response()
    assert result["profiles"][0]["configured"] is True
    assert result["profiles"][0]["api_key_configured"] is True
    assert "legacy-private-key" not in json.dumps(result)
    assert asr_config.snapshot()[1].aliyun_asr_api_key == "legacy-private-key"


def test_nls_default_endpoint_and_all_public_secret_flags(runtime):
    result = asr_config.save_profile(nls())
    profile = result["profiles"][0]
    assert profile["endpoint"] == asr_config.NLS_ENDPOINT
    assert profile["provider"] == "aliyun_nls_ws" and profile["model"] == ""
    assert profile["configured"] and profile["app_key_configured"] and profile["nls_token_configured"]
    assert profile["api_key_configured"] is False
    assert not any(field in profile for field in SECRET_FIELDS)
    assert "test-project-key" not in json.dumps(result) and "test-temporary-token" not in json.dumps(result)
    saved, settings = asr_config.snapshot()
    assert "test-project-key" not in repr(saved) and "test-temporary-token" not in repr(saved)
    assert settings.asr_provider == "aliyun_nls_ws"
    assert settings.aliyun_nls_app_key == "test-project-key" and settings.aliyun_nls_token == "test-temporary-token"
    assert settings.aliyun_nls_format == "pcm" and settings.aliyun_nls_sample_rate == 16000
    assert settings.aliyun_asr_api_key == settings.aliyun_ak_id == settings.aliyun_ak_secret == ""


def test_automatic_auth_snapshot_uses_only_its_saved_access_keys(runtime):
    asr_config.save_profile(nls(auth_mode="access_key", access_key_id="test-access-id", access_key_secret="test-access-secret"))
    original, settings = asr_config.snapshot()
    assert original.nls_token == "test-temporary-token"
    assert settings.aliyun_nls_token == settings.aliyun_asr_api_key == ""
    assert settings.aliyun_ak_id == "test-access-id" and settings.aliyun_ak_secret == "test-access-secret"
    assert settings.aliyun_nls_app_key == "test-project-key"


def test_names_provider_and_omitted_secrets_survive_edits_without_switching_provider(runtime):
    first = asr_config.save_profile(nls(auth_mode="access_key", access_key_id="test-access-id", access_key_secret="test-access-secret"))["active_profile_id"]
    asr_config.save_profile(asr_config.ProfileInput(id=first, name="只修改名称"))
    saved, settings = asr_config.snapshot()
    assert saved.name == "只修改名称" and saved.provider == "aliyun_nls_ws" and saved.auth_mode == "access_key"
    assert settings.aliyun_ak_secret == "test-access-secret"
    asr_config.save_profile(nls(id=first, name="改用 Token", api_key=None, app_key=None, nls_token=None, auth_mode="token"))
    saved, settings = asr_config.snapshot()
    assert saved.access_key_secret == "test-access-secret"
    assert settings.aliyun_nls_token == "test-temporary-token" and settings.aliyun_ak_secret == ""


def test_provider_change_is_rejected_before_existing_credentials_can_cross_services(runtime):
    selected = asr_config.save_profile(nls())["active_profile_id"]
    before = asr_config.profiles_path().read_bytes()
    with pytest.raises(ValueError, match="服务类型"):
        asr_config.save_profile(asr_config.ProfileInput(id=selected, name="不同服务", provider="aliyun_ws", api_key="new-bailian-key"))
    assert asr_config.profiles_path().read_bytes() == before
    bailian = asr_config.save_profile(asr_config.ProfileInput(name="百炼", api_key="bailian-secret"))["active_profile_id"]
    with pytest.raises(ValueError, match="服务类型"):
        asr_config.save_profile(nls(id=bailian))


@pytest.mark.parametrize("updates", [
    {"app_key": ""}, {"nls_token": ""}, {"app_key": "************"}, {"nls_token": "************"},
    {"auth_mode": "access_key"}, {"auth_mode": "access_key", "access_key_id": "id"},
    {"auth_mode": "access_key", "access_key_id": "id", "access_key_secret": "***"},
    {"access_key_secret": "x\r\nheader"},
])
def test_missing_or_masked_nls_credentials_are_not_saved(runtime, updates):
    with pytest.raises(ValueError):
        asr_config.save_profile(nls(**updates))
    assert asr_config.list_response()["profiles"] == []


@pytest.mark.parametrize("field", SECRET_FIELDS)
def test_nls_secret_reveal_is_explicit_local_and_no_store(runtime, field):
    client, _settings, _directory = runtime
    saved = client.post("/api/config/asr/profiles", headers=ORIGIN, json={"name": "本地 NLS", "provider": "aliyun_nls_ws", "auth_mode": "access_key", "app_key": "private-app", "nls_token": "private-token", "access_key_id": "private-id", "access_key_secret": "private-secret"})
    assert saved.status_code == 200
    identifier = saved.json()["active_profile_id"]
    path = f"/api/config/asr/profiles/{identifier}/secrets/{field}"
    response = client.post(path, headers=ORIGIN)
    assert response.status_code == 200 and set(response.json()) == {"value"}
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["value"].startswith("private-")
    for origin in ("null", "https://evil.test", "http://127.0.0.1:9960"):
        denied = client.post(path, headers={"Origin": origin})
        assert denied.status_code == 403 and "private-" not in denied.text
    assert client.post(f"/api/config/asr/profiles/{identifier}/key", headers=ORIGIN).status_code == 422
    assert client.post(f"/api/config/asr/profiles/{identifier}/secrets/api_key", headers=ORIGIN).status_code == 422
    assert "private-" not in client.get("/api/config/asr/profiles").text


def test_remote_clients_cannot_read_nls_secrets(runtime):
    _client, _settings, _directory = runtime
    identifier = asr_config.save_profile(nls())["active_profile_id"]
    app = FastAPI()
    app.include_router(transcription.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("192.0.2.1", 50000)) as client:
        assert client.post(f"/api/config/asr/profiles/{identifier}/secrets/app_key").status_code == 403


def test_token_provider_cache_is_shared_bounded_and_credential_changes_evict(runtime):
    asr_config.save_profile(nls(auth_mode="access_key", access_key_id="cache-id", access_key_secret="cache-secret"))
    selected, _settings = asr_config.snapshot()
    provider = asr_config.nls_token_provider(selected)
    assert provider is asr_config.nls_token_provider(selected)
    assert all("cache-secret" not in str(key) and "cache-id" not in str(key) for key in asr_config._TOKEN_PROVIDERS)
    for index in range(20):
        asr_config.nls_token_provider(selected.model_copy(update={"id": f"other-{index}"}))
    assert len(asr_config._TOKEN_PROVIDERS) == 16
    old = asr_config.nls_token_provider(selected)
    asr_config.save_profile(nls(id=selected.id, auth_mode="access_key", access_key_id="cache-id", access_key_secret="new-secret"))
    changed, _settings = asr_config.snapshot()
    assert asr_config.nls_token_provider(changed) is not old
    asr_config.delete_profile(changed.id)
    assert all(key[0] != changed.id for key in asr_config._TOKEN_PROVIDERS)
    assert asr_config.nls_token_provider(selected.model_copy(update={"auth_mode": "token"})) is None


class NlsSessions:
    def __init__(self):
        self.sessions = []
        self.fail_source = ""
        self.fail_reason = ""
        self.expired_once = False

    def create(self, session_id, *, settings, token_provider=None):
        session = FakeNls(session_id, settings, token_provider, self)
        self.sessions.append(session)
        return session


class FakeNls:
    def __init__(self, session_id, settings, token_provider, owner):
        self.session_id, self.settings, self.provider, self.owner = session_id, settings, token_provider, owner
        self.source = session_id.rsplit(":", 1)[-1] if ":" in session_id else "check"
        self.result_queue = asyncio.Queue()
        self.error_reason = ""
        self.started = self.finished = self.closed = False
        self.ws = self._reader_task = None
        self.sent = []
        self.connects = 0

    async def connect(self):
        self.connects += 1
        token = self.settings.aliyun_nls_token if self.settings.aliyun_nls_token and not getattr(self, "_prefer_auto_token", False) else await asyncio.to_thread(self.provider.get_token)
        if self.owner.expired_once and self.connects == 1:
            self.error_reason = "aliyun_asr_task_failed:40000002:invalid token private-token"
            raise RuntimeError(self.error_reason)
        if self.owner.fail_source == self.source:
            self.error_reason = self.owner.fail_reason
            raise RuntimeError("provider detail included private-token")
        assert token
        self.started = True

    async def send_audio(self, pcm):
        self.sent.append(pcm)
        await self.result_queue.put(TranscriptSegment(session_id=self.session_id, speaker="unknown", text=f"{self.source} interim", start_ms=0, end_ms=100, is_final=False, confidence=.9))
        await self.result_queue.put(TranscriptSegment(session_id=self.session_id, speaker="unknown", text=f"{self.source} final", start_ms=0, end_ms=100, is_final=True, confidence=.9))

    async def close(self):
        if self.closed:
            return
        self.closed = self.finished = True
        if self.started and self.source != "check":
            await self.result_queue.put(TranscriptSegment(session_id=self.session_id, speaker="unknown", text=f"{self.source} tail", start_ms=200, end_ms=300, is_final=True, confidence=.9))
        await self.result_queue.put(None)


@pytest.fixture
def nls_runtime(runtime, monkeypatch):
    asr_config.save_profile(nls())
    owner = NlsSessions()
    monkeypatch.setattr(transcription, "AliyunNLSSession", owner.create)
    return *runtime, owner


@pytest.mark.parametrize("role", ["candidate", "interviewer"])
def test_nls_uses_independent_sources_and_drains_last_finals(nls_runtime, role):
    client, _settings, _directory, owner = nls_runtime
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as socket:
        socket.send_json({"type": "start", "role": role, "sources": ["mic", "system"], "api_key": ""})
        assert socket.receive_json()["type"] == "ready"
        for source, pcm in [("mic", b"\x01\x00"), ("system", b"\x02\x00")]:
            socket.send_json({"type": "audio", "source": source, "seq": 0, "audio": base64.b64encode(pcm).decode()})
        socket.send_json({"type": "stop"})
        events = []
        while not events or events[-1]["type"] != "stopped":
            events.append(socket.receive_json())
    final = events[-1]
    assert final["saved"] and final["record"]["turnCount"] == 4
    assert "private-token" not in json.dumps(events)
    expected = {"mic": role, "system": "interviewer" if role == "candidate" else "candidate"}
    for event in events:
        if event["type"] == "transcript":
            assert event["speaker"] == expected[event["source"]]
    sessions = {session.source: session for session in owner.sessions}
    assert sessions["mic"].sent == [b"\x01\x00"] and sessions["system"].sent == [b"\x02\x00"]
    assert all(session.closed for session in owner.sessions)
    assert all(session.settings.aliyun_asr_api_key == "" for session in owner.sessions)


def test_connection_check_sends_a_bounded_audio_probe_and_drains_transcripts(nls_runtime):
    client, _settings, _directory, owner = nls_runtime
    identifier = asr_config.list_response()["active_profile_id"]
    response = client.post(f"/api/config/asr/profiles/{identifier}/check", headers=ORIGIN).json()
    assert response["ok"] and "音频验证通过" in response["detail"]
    assert len(owner.sessions) == 1 and owner.sessions[0].closed
    assert len(owner.sessions[0].sent) == 1 and len(owner.sessions[0].sent[0]) == 1600


@pytest.mark.parametrize("reason,expected", [
    ("40000002:bad token private-token", "Token 无效或已过期"),
    ("40020503:No permission private-token", "CreateToken"),
    ("invalid appkey private-token", "AppKey 验证失败"),
    ("concurrent limit private-token", "并发连接额度不足"),
])
def test_nls_errors_are_actionable_without_exposing_provider_credentials(nls_runtime, reason, expected):
    client, _settings, _directory, owner = nls_runtime
    owner.fail_source = "check"
    owner.fail_reason = reason
    identifier = asr_config.list_response()["active_profile_id"]
    response = client.post(f"/api/config/asr/profiles/{identifier}/check", headers=ORIGIN).json()
    assert not response["ok"] and expected in response["detail"]
    assert "private-token" not in json.dumps(response)
    assert owner.sessions[0].closed


def test_nls_http_token_rejection_maps_to_actionable_error_without_raw_credentials(nls_runtime):
    import asyncio
    from types import SimpleNamespace

    profile, _settings = asr_config.snapshot()

    async def reject():
        raise RuntimeError('server rejected WebSocket connection: HTTP 403 private-token')

    session = SimpleNamespace(error_reason='', started=False, connect=reject)
    with pytest.raises(RuntimeError):
        asyncio.run(transcription._connect_provider(session, profile))
    assert session.error_reason == 'invalid token'
    detail = transcription._provider_failure_detail(session.error_reason, profile.provider)
    assert 'Token 无效或已过期' in detail
    assert 'private-token' not in detail


def test_nls_connection_failure_closes_both_sources(nls_runtime):
    client, _settings, _directory, owner = nls_runtime
    owner.fail_source = "system"
    owner.fail_reason = "40000002:bad token private-token"
    with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as socket:
        socket.send_json({"type": "start", "role": "candidate", "sources": ["mic", "system"], "api_key": ""})
        error = socket.receive_json()
        assert error["type"] == "error" and "Token" in error["detail"]
        assert socket.receive_json()["type"] == "stopped"
    assert len(owner.sessions) == 2 and all(session.closed for session in owner.sessions)


def test_nls_automatic_mode_reuses_and_refreshes_a_shared_expiring_token(nls_runtime, monkeypatch):
    client, _settings, _directory, owner = nls_runtime
    calls, now = [], [0]
    original = AliyunNLSTokenProvider

    def issuer(*args, **kwargs):
        calls.append((args, kwargs))
        return AliyunNLSToken(id=f"issued-{len(calls)}", expire_time=now[0] + 600)

    monkeypatch.setattr(asr_config, "AliyunNLSTokenProvider", lambda **kwargs: original(**kwargs, create_token_func=issuer, now_func=lambda: now[0]))
    identifier = asr_config.save_profile(nls(auth_mode="access_key", access_key_id="test-id", access_key_secret="test-secret"))["active_profile_id"]
    for _ in range(2):
        with client.websocket_connect("ws://127.0.0.1:9958/ws/transcription", headers=ORIGIN) as socket:
            socket.send_json({"type": "start", "role": "candidate", "sources": ["mic", "system"], "api_key": ""})
            assert socket.receive_json()["type"] == "ready"
            socket.send_json({"type": "stop"})
            while socket.receive_json()["type"] != "stopped":
                pass
    assert len(calls) == 1
    assert len({id(session.provider) for session in owner.sessions}) == 1
    now[0] = 400
    assert client.post(f"/api/config/asr/profiles/{identifier}/check", headers=ORIGIN).json()["ok"]
    assert len(calls) == 2


def test_a_started_provider_is_never_reconnected_by_token_retry(runtime):
    invalidations = []

    class Provider:
        def invalidate(self):
            invalidations.append(True)

    class StartedSession:
        started = True
        error_reason = '40000002:invalid token'
        _configured_token_provider = Provider()
        calls = 0

        async def connect(self):
            self.calls += 1
            raise RuntimeError(self.error_reason)

    asr_config.save_profile(nls(auth_mode='access_key', access_key_id='test-id', access_key_secret='test-secret'))
    profile, _settings = asr_config.snapshot()
    session = StartedSession()
    with pytest.raises(RuntimeError):
        asyncio.run(transcription._connect_provider(session, profile))
    assert session.calls == 1 and not invalidations


def test_invalid_cached_auto_token_is_retried_once_before_any_audio(nls_runtime, monkeypatch):
    client, _settings, _directory, owner = nls_runtime
    calls = []

    def issuer(*_args, **_kwargs):
        calls.append(True)
        return AliyunNLSToken(id=f"issued-{len(calls)}", expire_time=1000)

    monkeypatch.setattr(asr_config, "AliyunNLSTokenProvider", lambda **kwargs: AliyunNLSTokenProvider(**kwargs, create_token_func=issuer, now_func=lambda: 0))
    identifier = asr_config.save_profile(nls(auth_mode="access_key", access_key_id="test-id", access_key_secret="test-secret"))["active_profile_id"]
    owner.expired_once = True
    result = client.post(f"/api/config/asr/profiles/{identifier}/check", headers=ORIGIN).json()
    assert result["ok"]
    assert calls == [True, True]
    assert owner.sessions[0].connects == 2 and len(owner.sessions[0].sent) == 1
