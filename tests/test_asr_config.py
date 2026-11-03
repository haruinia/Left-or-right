from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from libs.common.config import Settings
from services.gateway import asr_config, model_config, transcription


@pytest.fixture
def config_files(tmp_path, monkeypatch):
    monkeypatch.setattr(model_config, "profiles_path", lambda: tmp_path / "model_profiles.json")
    settings = Settings(_env_file=None, llm_provider="mock", database_url=f"sqlite:///{tmp_path}/data.db")
    monkeypatch.setattr(asr_config, "get_settings", lambda: settings)
    monkeypatch.setattr(transcription, "get_settings", lambda: settings)
    return tmp_path


def profile(**overrides):
    return asr_config.ProfileInput.model_validate({"name": "语音测试", "api_key": "synthetic-asr-key", **overrides})


def test_profiles_are_private_named_and_independent(config_files):
    first = asr_config.save_profile(profile(name="工作账号"))
    first_id = first["active_profile_id"]
    second = asr_config.save_profile(profile(name="个人账号", api_key="other-synthetic-key"))
    second_id = second["active_profile_id"]
    assert first_id != second_id
    assert "synthetic-asr-key" not in json.dumps(second)
    assert "api_key" not in second["profiles"][0]
    assert second["profiles"][0]["api_key_configured"] is True
    edited = asr_config.save_profile(profile(id=first_id, name="工作账号更新", api_key=None))
    assert edited["active_profile_id"] == first_id
    assert len(edited["profiles"]) == 2
    assert asr_config.profile_api_key(first_id) == "synthetic-asr-key"
    assert asr_config.profile_api_key(second_id) == "other-synthetic-key"
    assert asr_config.profiles_path() == config_files / "asr_profiles.json"
    if os.name != "nt":
        assert asr_config.profiles_path().stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('model', ['qwen3-asr-flash-realtime','Qwen-ASR-Realtime'])
def test_realtime_protocol_is_not_switched_by_changing_only_the_model_name(config_files, model):
    with pytest.raises(ValueError,match='Paraformer'):
        asr_config.save_profile(profile(model=model))
    assert asr_config.list_response()['profiles']==[]


def test_snapshot_does_not_change_when_profile_is_edited(config_files):
    saved = asr_config.save_profile(profile())
    selected, settings = asr_config.snapshot()
    asr_config.save_profile(profile(id=saved["active_profile_id"], api_key="replacement-key", model="different-model"))
    assert selected.api_key == "synthetic-asr-key"
    assert settings.aliyun_asr_api_key == "synthetic-asr-key"
    assert settings.aliyun_asr_model == "paraformer-realtime-v2"
    assert settings.aliyun_asr_sample_rate == 16000
    assert settings.aliyun_asr_format == "pcm"
    assert "synthetic-asr-key" not in repr(selected)


def test_activation_and_deletion_do_not_choose_another_profile_implicitly(config_files):
    first = asr_config.save_profile(profile())["active_profile_id"]
    second = asr_config.save_profile(profile(name="第二套"))["active_profile_id"]
    assert asr_config.activate_profile(first)["active_profile_id"] == first
    remaining = asr_config.delete_profile(first)
    assert remaining["active_profile_id"] == ""
    assert remaining["profiles"][0]["id"] == second
    with pytest.raises(asr_config.ProfileNotFound):
        asr_config.snapshot()
    with pytest.raises(asr_config.ProfileNotFound):
        asr_config.save_profile(profile(id="missing", api_key=None))
    assert asr_config.activate_profile(second)["active_profile_id"] == second


@pytest.mark.parametrize("key", [None, "", "   ", "************", "key\r\nheader", "x" * 8193])
def test_missing_masked_or_invalid_keys_are_rejected(config_files, key):
    with pytest.raises(ValueError):
        asr_config.save_profile(profile(api_key=key))
    assert asr_config.list_response() == {"profiles": [], "active_profile_id": ""}


@pytest.mark.parametrize("endpoint", ["ws://localhost/asr", "https://example.test/asr", "wss://user:secret@example.test/asr", "wss://example.test/asr?key=secret", "wss://example.test/asr#secret", "wss://", "wss://example.test:99999", "wss://bad host/asr"])
def test_endpoint_rejects_insecure_or_credential_bearing_urls(config_files, endpoint):
    with pytest.raises(ValueError):
        asr_config.save_profile(profile(endpoint=endpoint))


def test_concurrent_saves_and_failed_atomic_replace_preserve_store(config_files, monkeypatch):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda number: asr_config.save_profile(profile(name=f"配置 {number}")), range(12)))
    assert len(asr_config.list_response()["profiles"]) == 12
    before = asr_config.profiles_path().read_bytes()
    def fail(*_args):
        raise OSError("write failed")
    monkeypatch.setattr(asr_config.os, "replace", fail)
    with pytest.raises(OSError):
        asr_config.save_profile(profile(name="不能写入"))
    assert asr_config.profiles_path().read_bytes() == before
    assert not list(config_files.glob(".asr-profiles-*"))


def test_corrupted_store_is_not_overwritten_as_empty(config_files):
    asr_config.profiles_path().write_text('{"broken":true}')
    with pytest.raises(OSError):
        asr_config.save_profile(profile())
    assert asr_config.profiles_path().read_text() == '{"broken":true}'


@pytest.fixture
def client(config_files):
    app = FastAPI()
    app.include_router(transcription.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 50000)) as client:
        yield client


def test_http_profiles_and_local_key_reveal(client):
    response = client.post("/api/config/asr/profiles", json={"name": "接入", "api_key": "private-test-key"})
    assert response.status_code == 200
    profile_id = response.json()["active_profile_id"]
    assert "private-test-key" not in response.text
    assert "private-test-key" not in client.get("/api/config/asr/profiles").text
    key = client.post(f"/api/config/asr/profiles/{profile_id}/key", headers={"Origin": "http://127.0.0.1:9958"})
    assert key.json() == {"api_key": "private-test-key"}
    assert key.headers["cache-control"] == "no-store"
    for origin in ["null", "http://evil.test", "https://127.0.0.1:9958", "http://127.0.0.1:9959"]:
        assert client.post(f"/api/config/asr/profiles/{profile_id}/key", headers={"Origin": origin}).status_code == 403
    assert client.post(f"/api/config/asr/profiles/{profile_id}/key", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.delete(f"/api/config/asr/profiles/{profile_id}").json()["profiles"] == []


def test_cross_site_cannot_retarget_or_test_a_saved_key(client):
    saved = client.post("/api/config/asr/profiles", json={"name": "接入", "api_key": "private-test-key"}).json()
    profile_id = saved["active_profile_id"]
    for origin in ["null", "https://evil.test"]:
        headers = {"Origin": origin}
        assert client.post("/api/config/asr/profiles", headers=headers, json={"id": profile_id, "name": "接入", "endpoint": "wss://evil.test/asr"}).status_code == 403
        assert client.post("/api/config/asr/activate", headers=headers, json={"profile_id": profile_id}).status_code == 403
        assert client.post(f"/api/config/asr/profiles/{profile_id}/check", headers=headers).status_code == 403
        assert client.delete(f"/api/config/asr/profiles/{profile_id}", headers=headers).status_code == 403
    assert client.get("/api/config/asr/profiles").json() == saved


def test_remote_client_cannot_reveal_keys(config_files):
    profile_id = asr_config.save_profile(profile())["active_profile_id"]
    app = FastAPI()
    app.include_router(transcription.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("192.0.2.1", 50000)) as remote:
        assert remote.post(f"/api/config/asr/profiles/{profile_id}/key").status_code == 403


def test_validation_does_not_echo_credentials(client):
    result = client.post("/api/config/asr/profiles", json={"name": "接入", "api_key": "sensitive-value", "unknown_secret": "sensitive-value"})
    assert result.status_code == 422
    assert "sensitive-value" not in result.text
    result = client.post("/api/config/asr/profiles", json={"name": "接入", "api_key": "sensitive-value", "endpoint": "wss://sensitive-value@example.test"})
    assert result.status_code == 422
    assert "sensitive-value" not in result.text
