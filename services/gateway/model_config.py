from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from libs.common.config import get_settings
from libs.llm_client.client import resolve_protocol

PROTOCOLS = {"auto", "openai_chat", "openai_responses", "anthropic_messages"}
_MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,159}")
_MAX_PROFILES = 50
_MAX_BODY_CHARS = 20_000


class LlmProfile(BaseModel):
    id: str
    name: str = ""
    llm_model: str
    llm_base_url: str
    llm_protocol: str = "auto"
    llm_api_path: str = "/chat/completions"
    llm_auth_header: str = "Authorization"
    llm_auth_scheme: str = "Bearer"
    llm_response_content_path: str = "choices.0.message.content"
    llm_extra_body_json: str = ""
    llm_max_tokens: int = Field(default=30000, ge=0, le=1_000_000)
    vision_model: str = ""
    llm_api_key: str = ""


class ProfileInput(BaseModel):
    profile_id: str = ""
    name: str = ""
    llm_model: str
    llm_base_url: str
    llm_protocol: str = "auto"
    llm_api_path: str = ""
    llm_auth_header: str = ""
    llm_auth_scheme: str = ""
    llm_response_content_path: str = ""
    llm_extra_body_json: str = ""
    llm_max_tokens: int | None = Field(default=None, ge=0, le=1_000_000)
    vision_model: str = ""
    llm_api_key: str = ""
    llm_provider_mock: bool = False
    clear_api_key: bool = False


class ImportPayload(BaseModel):
    config: Any


def profiles_path() -> Path:
    configured = os.environ.get("LLM_PROFILES_PATH", "").strip()
    if configured:
        return Path(configured)
    raw = get_settings().database_url
    if raw.startswith("sqlite:///"):
        db_path = Path(raw.removeprefix("sqlite:///"))
        if str(db_path) not in {":memory:", ""}:
            return db_path.parent / "model_profiles.json"
    return Path("data") / "model_profiles.json"


def _public(profile: LlmProfile) -> dict[str, Any]:
    data = profile.model_dump()
    key = data.pop("llm_api_key", "")
    data["llm_api_key_configured"] = bool(key)
    return data


def _current_profile() -> LlmProfile:
    settings = get_settings()
    return LlmProfile(
        id="current",
        name="当前配置",
        llm_model=settings.llm_model,
        llm_base_url=settings.llm_base_url,
        llm_protocol=settings.llm_protocol,
        llm_api_path=settings.llm_api_path,
        llm_auth_header=settings.llm_auth_header,
        llm_auth_scheme=settings.llm_auth_scheme,
        llm_response_content_path=settings.llm_response_content_path,
        llm_extra_body_json=settings.llm_extra_body_json,
        llm_max_tokens=settings.llm_max_tokens,
        vision_model=settings.vision_model,
        llm_api_key=settings.llm_api_key,
    )


def load_store() -> tuple[list[LlmProfile], str]:
    path = profiles_path()
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            profiles = [LlmProfile.model_validate(item) for item in raw.get("profiles", [])]
            active = str(raw.get("active_profile_id", ""))
            if profiles:
                return profiles, active or profiles[0].id
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    profile = _current_profile()
    return [profile], profile.id


def _write_store(profiles: list[LlmProfile], active: str) -> None:
    path = profiles_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(
        {"profiles": [profile.model_dump() for profile in profiles], "active_profile_id": active},
        ensure_ascii=False,
        indent=2,
    )
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".profiles-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(raw)
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def profile_api_key(profile_id: str) -> str:
    profiles, _ = load_store()
    profile = next((item for item in profiles if item.id == profile_id), None)
    if profile is None:
        raise ValueError("配置不存在")
    return profile.llm_api_key


def _preset_catalog() -> list[dict[str, Any]]:
    path = profiles_path().with_name("model_presets.json")
    if not path.is_file():
        return []
    try:
        items = _import_items(json.loads(path.read_text(encoding="utf-8")))
        return [
            {**_public(_parse_import_item(item)), "models": [str(model) for model in item.get("models", [])]}
            for item in items
        ]
    except (ValueError, TypeError):
        return []


def list_response() -> dict[str, Any]:
    profiles, active = load_store()
    return {
        "profiles": [_public(profile) for profile in profiles],
        "active_profile_id": active,
        "presets": _preset_catalog(),
    }


def _fail(message: str) -> None:
    raise ValueError(message)


def _clean_text(value: str, label: str, limit: int = 300) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        _fail(f"{label}过长")
    return text


def _normalize(profile: LlmProfile) -> LlmProfile:
    data = profile.model_dump()
    data["name"] = _clean_text(data["name"], "配置名称", 60) or data["llm_model"]
    data["llm_model"] = _clean_text(data["llm_model"], "模型名", 160)
    data["vision_model"] = _clean_text(data["vision_model"], "截图模型", 160)
    for field, label in (("llm_model", "模型名"), ("vision_model", "截图模型")):
        value = data[field]
        if value and not _MODEL_NAME.fullmatch(value):
            _fail(f"{label}格式无效")
    url = data["llm_base_url"].strip().rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username:
        _fail("接口地址必须是 http:// 或 https:// 地址，且不能内嵌账号")
    data["llm_base_url"] = url
    if data["llm_protocol"] not in PROTOCOLS:
        _fail("协议只能是 auto、openai_chat、openai_responses 或 anthropic_messages")
    data["llm_api_path"] = _clean_text(data["llm_api_path"], "接口路径", 200)
    data["llm_auth_header"] = _clean_text(data["llm_auth_header"], "鉴权头", 60)
    data["llm_auth_scheme"] = _clean_text(data["llm_auth_scheme"], "鉴权前缀", 60)
    data["llm_response_content_path"] = _clean_text(
        data["llm_response_content_path"], "响应字段路径", 200
    )
    extra = data["llm_extra_body_json"].strip()
    if extra:
        if len(extra) > _MAX_BODY_CHARS:
            _fail("附加请求体过长")
        try:
            value = json.loads(extra)
        except json.JSONDecodeError as exc:
            raise ValueError("附加请求体必须是合法 JSON") from exc
        if not isinstance(value, dict):
            _fail("附加请求体必须是 JSON 对象")
        data["llm_extra_body_json"] = json.dumps(value, ensure_ascii=False)
    else:
        data["llm_extra_body_json"] = ""
    data["llm_api_key"] = str(data["llm_api_key"] or "").strip()
    if any(character in data["llm_api_key"] for character in "\r\n"):
        _fail("密钥格式无效")
    return LlmProfile.model_validate(data)


def _new_id(existing: list[LlmProfile], wanted: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "-", wanted or "profile").strip("-") or "profile"
    candidate = base[:40]
    suffix = 2
    used = {profile.id for profile in existing}
    while candidate in used:
        candidate = f"{base[:36]}-{suffix}"
        suffix += 1
    return candidate


def save_profile(payload: ProfileInput) -> dict[str, Any]:
    profiles, active = load_store()
    editing = next((profile for profile in profiles if profile.id == payload.profile_id), None)
    # 没带 id 时按"修改当前接入"处理；带了本机不存在的 id 才是新建。
    base = editing or next((profile for profile in profiles if profile.id == active), None)
    if base is None:
        base = _current_profile()

    same_connection = (
        payload.llm_base_url.strip().rstrip("/") == base.llm_base_url.rstrip("/")
        and payload.llm_protocol == base.llm_protocol
    )
    api_key = payload.llm_api_key.strip()
    if payload.clear_api_key:
        api_key = ""
    elif not api_key and same_connection:
        api_key = base.llm_api_key

    profile = LlmProfile(
        id=payload.profile_id or base.id,
        name=payload.name,
        llm_model=payload.llm_model,
        llm_base_url=payload.llm_base_url,
        llm_protocol=payload.llm_protocol,
        llm_api_path=payload.llm_api_path or base.llm_api_path,
        llm_auth_header=payload.llm_auth_header or base.llm_auth_header,
        llm_auth_scheme=(
            payload.llm_auth_scheme
            if payload.llm_auth_scheme
            else base.llm_auth_scheme
        ),
        llm_response_content_path=(
            payload.llm_response_content_path or base.llm_response_content_path
        ),
        llm_extra_body_json=payload.llm_extra_body_json,
        llm_max_tokens=(
            payload.llm_max_tokens
            if payload.llm_max_tokens is not None
            else base.llm_max_tokens
        ),
        vision_model=payload.vision_model,
        llm_api_key=api_key,
    )
    profile = _normalize(profile)
    if editing is None and not payload.profile_id:
        profile.id = active
    index = next((i for i, item in enumerate(profiles) if item.id == profile.id), None)
    if index is None:
        profile.id = _new_id(profiles, profile.id)
        if len(profiles) >= _MAX_PROFILES:
            _fail("配置数量已达上限，请先删除不用的配置")
        profiles.append(profile)
    else:
        profile.id = profiles[index].id
        profiles[index] = profile
    _write_store(profiles, profile.id)
    apply_profile(profile)
    return list_response()


def apply_profile(profile: LlmProfile) -> None:
    settings = get_settings()
    settings.llm_provider = "openai_compatible"
    settings.llm_model = profile.llm_model
    settings.llm_base_url = profile.llm_base_url
    settings.llm_protocol = profile.llm_protocol
    settings.llm_api_path = profile.llm_api_path or "/chat/completions"
    settings.llm_auth_header = profile.llm_auth_header or "Authorization"
    settings.llm_auth_scheme = profile.llm_auth_scheme
    settings.llm_response_content_path = (
        profile.llm_response_content_path or "choices.0.message.content"
    )
    settings.llm_extra_body_json = profile.llm_extra_body_json
    settings.llm_max_tokens = profile.llm_max_tokens
    settings.vision_model = profile.vision_model
    settings.llm_api_key = profile.llm_api_key


def activate_profile(profile_id: str) -> dict[str, Any]:
    profiles, _ = load_store()
    profile = next((item for item in profiles if item.id == profile_id), None)
    if profile is None:
        _fail("配置不存在")
    _write_store(profiles, profile.id)
    apply_profile(profile)
    return list_response()


def delete_profile(profile_id: str) -> dict[str, Any]:
    profiles, active = load_store()
    remaining = [profile for profile in profiles if profile.id != profile_id]
    if len(remaining) == len(profiles):
        _fail("配置不存在")
    if not remaining:
        _fail("至少保留一个配置")
    if active == profile_id:
        active = remaining[0].id
        apply_profile(remaining[0])
    _write_store(remaining, active)
    return list_response()


def _alias(item: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in item and item[name] not in (None, ""):
            return item[name]
    return None


def _parse_import_item(item: dict[str, Any]) -> LlmProfile:
    base_url = _alias(item, "llm_base_url", "base_url", "baseUrl", "api_base", "url", "endpoint")
    model = _alias(item, "llm_model", "model", "model_name", "modelName")
    if not base_url or not model:
        _fail("导入内容缺少接口地址或模型名")
    return _normalize(
        LlmProfile(
            id=str(_alias(item, "profile_id", "id") or "imported"),
            name=str(_alias(item, "name", "label", "title") or ""),
            llm_model=str(model),
            llm_base_url=str(base_url),
            llm_protocol=str(_alias(item, "llm_protocol", "protocol", "api_format") or "auto"),
            llm_api_path=str(_alias(item, "llm_api_path", "api_path", "path") or "/chat/completions"),
            llm_auth_header=str(_alias(item, "llm_auth_header", "auth_header") or "Authorization"),
            llm_auth_scheme=str(_alias(item, "llm_auth_scheme", "auth_scheme") or "Bearer"),
            llm_response_content_path=str(
                _alias(item, "llm_response_content_path", "response_content_path")
                or "choices.0.message.content"
            ),
            llm_extra_body_json=str(_alias(item, "llm_extra_body_json", "extra_body") or ""),
            llm_max_tokens=int(_alias(item, "llm_max_tokens", "max_tokens") or 30000),
            vision_model=str(_alias(item, "vision_model", "screenshot_model") or ""),
            llm_api_key=str(_alias(item, "llm_api_key", "api_key", "key", "apiKey") or ""),
        )
    )


def _import_items(config: Any) -> list[dict[str, Any]]:
    if isinstance(config, dict):
        if isinstance(config.get("profiles"), list):
            return [item for item in config["profiles"] if isinstance(item, dict)]
        if isinstance(config.get("config"), dict):
            return [config["config"]]
        return [config]
    if isinstance(config, list):
        return [item for item in config if isinstance(item, dict)]
    _fail("导入内容必须是 JSON 对象或数组")


def import_profiles(config: Any) -> dict[str, Any]:
    items = _import_items(config)
    if not items:
        _fail("没有可导入的配置")
    if len(items) > _MAX_PROFILES:
        _fail("一次导入的配置过多")
    candidates = [_parse_import_item(item) for item in items]

    profiles, active = load_store()
    for candidate in candidates:
        same = next(
            (
                index
                for index, profile in enumerate(profiles)
                if profile.llm_base_url.rstrip("/") == candidate.llm_base_url.rstrip("/")
                and profile.llm_model == candidate.llm_model
            ),
            None,
        )
        if same is not None:
            candidate.id = profiles[same].id
            if not candidate.llm_api_key:
                candidate.llm_api_key = profiles[same].llm_api_key
            profiles[same] = candidate
            continue
        candidate.id = _new_id(profiles, candidate.id)
        if len(profiles) >= _MAX_PROFILES:
            _fail("配置数量已达上限")
        profiles.append(candidate)
    _write_store(profiles, active)
    response = list_response()
    response["imported"] = len(candidates)
    return response


def update_models(screenshot_model: str, interview_model: str) -> dict[str, Any]:
    profiles, active = load_store()
    profile = next((item for item in profiles if item.id == active), None)
    if profile is None:
        profile = _current_profile()
        active = profile.id
        profiles = [profile]
    try:
        profile.vision_model = screenshot_model
        profile.llm_model = interview_model
        configured = _normalize(profile)
    except ValueError:
        # 尚未配置接入地址时只切换模型名，等保存接入配置时再写入模型档案。
        settings = get_settings()
        settings.vision_model = screenshot_model
        settings.llm_model = interview_model
        return list_response()
    index = next(i for i, item in enumerate(profiles) if item.id == configured.id)
    profiles[index] = configured
    _write_store(profiles, configured.id)
    apply_profile(configured)
    return list_response()


def protocol_hint(base_url: str, configured: str) -> str:
    class _Probe:
        llm_base_url = base_url
        llm_api_path = "/chat/completions"
        llm_protocol = configured

    return resolve_protocol(_Probe())
