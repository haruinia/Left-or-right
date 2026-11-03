from __future__ import annotations

import json
from pathlib import Path

import pytest

from libs.common.config import get_settings
from services.gateway import model_config


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LLM_PROFILES_PATH", str(tmp_path / "model_profiles.json"))
    get_settings.cache_clear()
    yield tmp_path / "model_profiles.json"
    get_settings.cache_clear()


def _save(**overrides):
    base = {
        "name": "测试接入",
        "llm_model": "model-a",
        "llm_base_url": "https://api.example.test/v1",
        "llm_protocol": "openai_chat",
        "llm_api_key": "secret-key",
    }
    base.update(overrides)
    return model_config.save_profile(model_config.ProfileInput(**base))


def test_saved_profile_drives_runtime_settings_and_hides_key(tmp_path) -> None:
    data = _save()
    active = next(item for item in data["profiles"] if item["id"] == data["active_profile_id"])
    assert active["llm_model"] == "model-a"
    assert active["llm_api_key_configured"] is True
    assert "llm_api_key" not in active
    assert "secret-key" not in json.dumps(data)

    settings = get_settings()
    assert settings.llm_base_url == "https://api.example.test/v1"
    assert settings.llm_protocol == "openai_chat"
    assert settings.llm_max_tokens == 30000

    stored = json.loads((tmp_path / "model_profiles.json").read_text(encoding="utf-8"))
    assert stored["profiles"][0]["llm_api_key"] == "secret-key"


def test_new_connection_does_not_inherit_the_old_key() -> None:
    _save()
    data = _save(
        name="另一家",
        llm_base_url="https://other.example.test/v1",
        llm_model="model-b",
        llm_api_key="",
        profile_id="",
    )
    active = next(item for item in data["profiles"] if item["id"] == data["active_profile_id"])
    assert active["llm_api_key_configured"] is False
    assert get_settings().llm_api_key == ""


def test_empty_key_on_same_connection_keeps_the_saved_key() -> None:
    _save()
    data = _save(llm_model="model-c", llm_api_key="")
    active = next(item for item in data["profiles"] if item["id"] == data["active_profile_id"])
    assert active["llm_api_key_configured"] is True
    assert get_settings().llm_api_key == "secret-key"


def test_editing_a_saved_profile_updates_it_in_place_and_keeps_its_key() -> None:
    first = _save()
    second = _save(
        name="备用",
        llm_base_url="https://other.example.test/v1",
        llm_model="model-b",
        llm_api_key="other-key",
        profile_id="backup",
    )
    backup = next(item for item in second["profiles"] if item["llm_model"] == "model-b")
    assert backup["id"] == "backup"
    model_config.activate_profile(first["active_profile_id"])

    edited = _save(
        name="备用改名",
        llm_base_url="https://other.example.test/v1",
        llm_model="model-b",
        llm_api_key="",
        profile_id="backup",
    )
    assert len(edited["profiles"]) == len(first["profiles"]) + 1
    assert [item["id"] for item in edited["profiles"]].count("backup") == 1
    saved = next(item for item in edited["profiles"] if item["id"] == "backup")
    assert saved["name"] == "备用改名"
    assert saved["llm_api_key_configured"] is True


def test_same_model_from_two_named_sources_keeps_independent_connections() -> None:
    first = _save(name="个人接口", profile_id="personal")
    second = _save(name="公司网关", profile_id="company", llm_base_url="https://company.example.test/v1", llm_api_key="company-test-key")
    matching = [p for p in second["profiles"] if p["llm_model"] == "model-a" and p["id"] in {"personal", "company"}]
    assert len(matching) == 2
    assert {p["name"] for p in matching} == {"个人接口", "公司网关"}
    model_config.activate_profile("personal")
    assert get_settings().llm_base_url == "https://api.example.test/v1"
    assert get_settings().llm_api_key == "secret-key"
    model_config.activate_profile("company")
    assert get_settings().llm_base_url == "https://company.example.test/v1"
    assert get_settings().llm_api_key == "company-test-key"
    assert first["active_profile_id"] == "personal"


def test_saving_without_an_id_edits_the_active_profile() -> None:
    first = _save()
    second = _save(llm_model="model-d", llm_api_key="")
    assert len(second["profiles"]) == len(first["profiles"])
    assert second["active_profile_id"] == first["active_profile_id"]
    assert get_settings().llm_model == "model-d"


def test_import_accepts_common_aliases_without_activating(tmp_path) -> None:
    before = get_settings().llm_base_url
    data = model_config.import_profiles(
        [
            {"base_url": "https://imported.example.test/v1", "model": "model-x", "api_key": "k"},
            {"llm_base_url": "https://two.example.test", "llm_model": "model-y", "max_tokens": 4096},
        ]
    )
    assert data["imported"] == 2
    assert len(data["profiles"]) == 3
    assert get_settings().llm_base_url == before
    assert '"api_key":"k"' not in json.dumps(data)
    assert not any(item.get("llm_api_key") for item in data["profiles"])
    imported = next(item for item in data["profiles"] if item["llm_model"] == "model-y")
    assert imported["llm_max_tokens"] == 4096


def test_import_rejects_bad_input_without_writing(tmp_path) -> None:
    with pytest.raises(ValueError):
        model_config.import_profiles({"model": "only-model"})
    with pytest.raises(ValueError):
        model_config.import_profiles("not json data")
    with pytest.raises(ValueError):
        model_config.import_profiles({"base_url": "https://user:pass@host/v1", "model": "m"})
    assert not (tmp_path / "model_profiles.json").exists()


def test_invalid_extra_body_and_protocol_are_rejected() -> None:
    with pytest.raises(ValueError):
        _save(llm_extra_body_json="{bad")
    with pytest.raises(ValueError):
        _save(llm_protocol="grpc")


def test_presets_are_local_only_and_never_return_credentials(tmp_path) -> None:
    assert model_config.list_response()["presets"] == []
    (tmp_path / "model_presets.json").write_text(json.dumps([
        {"id": "local", "base_url": "https://preset.test/v1", "model": "test-model", "api_key": "private-fixture", "models": ["test-model"]},
    ]), encoding="utf-8")
    response = model_config.list_response()
    assert response["presets"][0]["id"] == "local"
    assert response["presets"][0]["llm_model"] == "test-model"
    assert "private-fixture" not in json.dumps(response)
    assert "llm_api_key" not in response["presets"][0]


def test_delete_keeps_at_least_one_profile() -> None:
    data = _save()
    with pytest.raises(ValueError):
        model_config.delete_profile(data["active_profile_id"])
