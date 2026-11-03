from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import OrderedDict
from pathlib import Path
from threading import RLock
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from libs.common.config import Settings, get_settings
from services.asr_service.nls_token import AliyunNLSTokenProvider
from services.gateway import model_config

DEFAULT_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
NLS_ENDPOINT = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"
_SECRET_FIELDS = frozenset({"api_key", "app_key", "nls_token", "access_key_id", "access_key_secret"})
_LOCK = RLock()
_TOKEN_PROVIDERS: OrderedDict[tuple[str, str], AliyunNLSTokenProvider] = OrderedDict()


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = None
    name: str = Field(min_length=1, max_length=60)
    provider: Literal["aliyun_ws", "aliyun_nls_ws"] = "aliyun_ws"
    auth_mode: Literal["token", "access_key"] = "token"
    endpoint: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, max_length=160)
    language_hints: str = Field(default="zh,en", max_length=120)
    vocabulary_id: str = Field(default="", max_length=200)
    api_key: str | None = Field(default=None, repr=False)
    app_key: str | None = Field(default=None, repr=False)
    nls_token: str | None = Field(default=None, repr=False)
    access_key_id: str | None = Field(default=None, repr=False)
    access_key_secret: str | None = Field(default=None, repr=False)


class AsrProfile(BaseModel):
    id: str
    name: str
    provider: Literal["aliyun_ws", "aliyun_nls_ws"] = "aliyun_ws"
    auth_mode: Literal["token", "access_key"] = "token"
    endpoint: str
    model: str = ""
    language_hints: str = "zh,en"
    vocabulary_id: str = ""
    api_key: str = Field(default="", repr=False)
    app_key: str = Field(default="", repr=False)
    nls_token: str = Field(default="", repr=False)
    access_key_id: str = Field(default="", repr=False)
    access_key_secret: str = Field(default="", repr=False)

    def configured(self) -> bool:
        if self.provider == "aliyun_ws":
            return bool(self.api_key)
        return bool(self.app_key and (self.nls_token if self.auth_mode == "token" else self.access_key_id and self.access_key_secret))

    def public(self) -> dict:
        result = self.model_dump(exclude=_SECRET_FIELDS)
        result.update({f"{field}_configured": bool(getattr(self, field)) for field in _SECRET_FIELDS})
        result["api_key_configured"] = self.provider == "aliyun_ws" and bool(self.api_key)
        result["configured"] = self.configured()
        return result


class ProfileNotFound(ValueError):
    pass


def profiles_path() -> Path:
    return model_config.profiles_path().with_name("asr_profiles.json")


def _load() -> tuple[list[AsrProfile], str]:
    try:
        raw = json.loads(profiles_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [], ""
    except (ValueError, OSError) as exc:
        raise OSError("语音配置无法读取，请检查本机配置文件") from exc
    try:
        profiles = [AsrProfile.model_validate(item) for item in raw["profiles"]]
        active = str(raw.get("active_profile_id", ""))
        if len(profiles) > 50 or len({profile.id for profile in profiles}) != len(profiles):
            raise ValueError
        if active and not any(profile.id == active for profile in profiles):
            raise ValueError
        return profiles, active
    except (ValueError, TypeError, KeyError) as exc:
        raise OSError("语音配置无法读取，请检查本机配置文件") from exc


def _write(profiles: list[AsrProfile], active: str) -> None:
    path = profiles_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".asr-profiles-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump({"profiles": [profile.model_dump() for profile in profiles], "active_profile_id": active}, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _response(profiles: list[AsrProfile], active: str) -> dict:
    return {"profiles": [profile.public() for profile in profiles], "active_profile_id": active}


def list_response() -> dict:
    with _LOCK:
        return _response(*_load())


def _find(profiles: list[AsrProfile], profile_id: str) -> AsrProfile:
    profile = next((item for item in profiles if item.id == profile_id), None)
    if profile is None:
        raise ProfileNotFound("语音配置不存在")
    return profile


def _endpoint(value: str) -> str:
    endpoint = value.strip()
    try:
        url = urlsplit(endpoint)
        valid = url.scheme == "wss" and bool(url.hostname) and not (url.username or url.password or url.query or url.fragment)
        if url.port is not None and not 1 <= url.port <= 65535:
            valid = False
    except ValueError:
        valid = False
    if not valid or any(character.isspace() for character in endpoint):
        raise ValueError("接口地址必须是无凭据、查询参数和片段的 wss 地址")
    return endpoint


def _secret(payload: ProfileInput, existing: AsrProfile | None, field: str) -> str:
    value = getattr(payload, field)
    value = value.strip() if value is not None else getattr(existing, field) if existing else ""
    if len(value) > 8192 or (value and not value.strip("*")) or "\n" in value or "\r" in value:
        raise ValueError("请输入有效的凭据，不能保存遮罩字符或换行")
    return value


def _clear_token_providers(profile_id: str) -> None:
    for key in list(_TOKEN_PROVIDERS):
        if key[0] == profile_id:
            del _TOKEN_PROVIDERS[key]


def save_profile(payload: ProfileInput) -> dict:
    with _LOCK:
        profiles, _active = _load()
        existing = _find(profiles, payload.id) if payload.id else None
        if existing is None and len(profiles) >= 50:
            raise ValueError("最多保存 50 个语音配置")
        provider = payload.provider if not existing or "provider" in payload.model_fields_set else existing.provider
        auth_mode = payload.auth_mode if not existing or "auth_mode" in payload.model_fields_set else existing.auth_mode
        if existing and provider != existing.provider:
            raise ValueError("不能更换已有接入的服务类型，请添加新的语音接入")
        name = payload.name.strip()
        if not name:
            raise ValueError("名称不能为空")
        secrets = {field: _secret(payload, existing, field) for field in _SECRET_FIELDS}
        if provider == "aliyun_ws":
            if not secrets["api_key"]:
                raise ValueError("请输入有效的语音服务 API Key，不能保存遮罩字符")
            model = (payload.model if payload.model is not None else existing.model if existing else "paraformer-realtime-v2").strip()
            if not model:
                raise ValueError("语音模型不能为空")
            if model.lower().startswith("qwen"):
                raise ValueError("当前语音接入使用 Paraformer 实时识别协议，不能直接填写 Qwen 模型；请使用 paraformer-realtime-v2。")
            secrets.update({field: "" for field in _SECRET_FIELDS - {"api_key"}})
            default_endpoint = DEFAULT_ENDPOINT
        else:
            model = ""
            secrets["api_key"] = ""
            if not secrets["app_key"]:
                raise ValueError("请输入 NLS 项目 AppKey")
            if auth_mode == "token" and not secrets["nls_token"]:
                raise ValueError("请输入 NLS Token")
            if auth_mode == "access_key" and not (secrets["access_key_id"] and secrets["access_key_secret"]):
                raise ValueError("请输入 AccessKey ID 和 AccessKey Secret")
            default_endpoint = NLS_ENDPOINT
        endpoint = payload.endpoint if payload.endpoint is not None else existing.endpoint if existing else default_endpoint
        profile = AsrProfile(
            id=existing.id if existing else uuid4().hex,
            name=name,
            provider=provider,
            auth_mode=auth_mode,
            endpoint=_endpoint(endpoint),
            model=model,
            language_hints=payload.language_hints.strip(),
            vocabulary_id=payload.vocabulary_id.strip(),
            **secrets,
        )
        profiles = [profile if item.id == profile.id else item for item in profiles] if existing else [*profiles, profile]
        _write(profiles, profile.id)
        if existing and any(getattr(existing, field) != getattr(profile, field) for field in _SECRET_FIELDS):
            _clear_token_providers(profile.id)
        return _response(profiles, profile.id)


def activate_profile(profile_id: str) -> dict:
    with _LOCK:
        profiles, _active = _load()
        selected = _find(profiles, profile_id)
        if not selected.configured():
            raise ValueError("该语音配置缺少必要凭据")
        _write(profiles, selected.id)
        return _response(profiles, selected.id)


def delete_profile(profile_id: str) -> dict:
    with _LOCK:
        profiles, active = _load()
        _find(profiles, profile_id)
        remaining = [profile for profile in profiles if profile.id != profile_id]
        active = "" if active == profile_id else active
        _write(remaining, active)
        _clear_token_providers(profile_id)
        return _response(remaining, active)


def snapshot(profile_id: str | None = None) -> tuple[AsrProfile, Settings]:
    with _LOCK:
        profiles, active = _load()
        selected = _find(profiles, profile_id if profile_id is not None else active).model_copy(deep=True)
    if not selected.configured():
        raise ValueError("该语音配置缺少必要凭据")
    updates = {
        "asr_provider": selected.provider,
        "aliyun_asr_api_key": "", "aliyun_nls_app_key": "", "aliyun_nls_token": "", "aliyun_ak_id": "", "aliyun_ak_secret": "",
    }
    if selected.provider == "aliyun_ws":
        updates.update({
            "aliyun_asr_api_key": selected.api_key,
            "aliyun_asr_endpoint": selected.endpoint,
            "aliyun_asr_model": selected.model,
            "aliyun_asr_language_hints": selected.language_hints,
            "aliyun_asr_vocabulary_id": selected.vocabulary_id,
            "aliyun_asr_sample_rate": 16000,
            "aliyun_asr_format": "pcm",
        })
    else:
        updates.update({
            "aliyun_nls_app_key": selected.app_key,
            "aliyun_nls_endpoint": selected.endpoint,
            "aliyun_nls_vocabulary_id": selected.vocabulary_id,
            "aliyun_nls_sample_rate": 16000,
            "aliyun_nls_format": "pcm",
            "aliyun_nls_token": selected.nls_token if selected.auth_mode == "token" else "",
            "aliyun_ak_id": selected.access_key_id if selected.auth_mode == "access_key" else "",
            "aliyun_ak_secret": selected.access_key_secret if selected.auth_mode == "access_key" else "",
        })
    return selected, get_settings().model_copy(update=updates)


def nls_token_provider(profile: AsrProfile) -> AliyunNLSTokenProvider | None:
    if profile.provider != "aliyun_nls_ws" or profile.auth_mode != "access_key":
        return None
    settings = get_settings()
    digest = hashlib.sha256(json.dumps([profile.access_key_id, profile.access_key_secret, settings.aliyun_nls_token_endpoint, settings.aliyun_nls_token_region], separators=(",", ":")).encode()).hexdigest()
    key = (profile.id, digest)
    with _LOCK:
        provider = _TOKEN_PROVIDERS.get(key)
        if provider is None:
            provider = AliyunNLSTokenProvider(access_key_id=profile.access_key_id, access_key_secret=profile.access_key_secret, endpoint=settings.aliyun_nls_token_endpoint, region_id=settings.aliyun_nls_token_region)
            _TOKEN_PROVIDERS[key] = provider
            while len(_TOKEN_PROVIDERS) > 16:
                _TOKEN_PROVIDERS.popitem(last=False)
        _TOKEN_PROVIDERS.move_to_end(key)
        return provider


def profile_api_key(profile_id: str) -> str:
    with _LOCK:
        profile = _find(_load()[0], profile_id)
        if profile.provider != "aliyun_ws":
            raise ValueError("该服务不使用百炼 API Key")
        return profile.api_key


def profile_secret(profile_id: str, field: str) -> str:
    if field not in _SECRET_FIELDS - {"api_key"}:
        raise ValueError("不支持查看该凭据")
    with _LOCK:
        profile = _find(_load()[0], profile_id)
        if profile.provider != "aliyun_nls_ws":
            raise ValueError("该服务不使用 NLS 凭据")
        return getattr(profile, field)
