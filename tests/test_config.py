from __future__ import annotations

import pytest
from pydantic import ValidationError

from libs.common.config import Settings


def test_settings_rejects_unknown_runtime_backends() -> None:
    with pytest.raises(ValidationError):
        Settings(offline_task_backend="redis-stream")

    with pytest.raises(ValidationError):
        Settings(rate_limit_backend="memory")

    with pytest.raises(ValidationError):
        Settings(asr_provider="cloud")


def test_settings_rejects_out_of_range_runtime_thresholds() -> None:
    with pytest.raises(ValidationError):
        Settings(aigc_ai_prob_threshold=1.1)

    with pytest.raises(ValidationError):
        Settings(llm_timeout_seconds=0)

    with pytest.raises(ValidationError):
        Settings(probe_min_interval_ms=-1)


def test_settings_validates_llm_output_budget_and_protocol() -> None:
    assert Settings().llm_max_tokens == 30000
    assert Settings(llm_max_tokens=0).llm_max_tokens == 0
    with pytest.raises(ValidationError):
        Settings(llm_max_tokens=-1)
    with pytest.raises(ValidationError):
        Settings(llm_protocol="grpc")


def test_settings_rejects_invalid_llm_extra_body_json() -> None:
    with pytest.raises(ValidationError, match="LLM_EXTRA_BODY_JSON must be valid JSON"):
        Settings(llm_extra_body_json="{bad-json")

    with pytest.raises(ValidationError, match="LLM_EXTRA_BODY_JSON must decode to an object"):
        Settings(llm_extra_body_json='["not", "an", "object"]')


def test_settings_rejects_invalid_llm_response_content_path() -> None:
    for path in ["", " ", "choices..message.content", ".choices.0.message.content"]:
        with pytest.raises(ValidationError, match="LLM_RESPONSE_CONTENT_PATH"):
            Settings(llm_response_content_path=path)


@pytest.mark.parametrize(
    ("field", "env_name"),
    [
        ("asr_text_path", "ASR_TEXT_PATH"),
        ("asr_speaker_path", "ASR_SPEAKER_PATH"),
        ("asr_start_ms_path", "ASR_START_MS_PATH"),
        ("asr_end_ms_path", "ASR_END_MS_PATH"),
        ("asr_is_final_path", "ASR_IS_FINAL_PATH"),
        ("asr_confidence_path", "ASR_CONFIDENCE_PATH"),
        ("speaker_diarization_speaker_path", "SPEAKER_DIARIZATION_SPEAKER_PATH"),
        ("aigc_detector_probability_path", "AIGC_DETECTOR_PROBABILITY_PATH"),
        ("aigc_detector_flagged_path", "AIGC_DETECTOR_FLAGGED_PATH"),
    ],
)
def test_settings_rejects_invalid_integration_response_paths(
    field: str, env_name: str
) -> None:
    with pytest.raises(ValidationError, match=env_name):
        Settings(**{field: "payload..value"})


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        (
            {
                "llm_provider": "openai_compatible",
                "llm_api_key": "key",
                "llm_auth_header": "",
            },
            "LLM_AUTH_HEADER",
        ),
        (
            {
                "asr_provider": "http",
                "asr_base_url": "https://asr.example.com",
                "asr_api_key": "key",
                "asr_auth_header": "",
            },
            "ASR_AUTH_HEADER",
        ),
        (
            {
                "speaker_diarization_provider": "http",
                "speaker_diarization_base_url": "https://diarize.example.com",
                "speaker_diarization_api_key": "key",
                "speaker_diarization_auth_header": "",
            },
            "SPEAKER_DIARIZATION_AUTH_HEADER",
        ),
        (
            {
                "aigc_detector_provider": "http",
                "aigc_detector_base_url": "https://aigc.example.com",
                "aigc_detector_api_key": "key",
                "aigc_detector_auth_header": "",
            },
            "AIGC_DETECTOR_AUTH_HEADER",
        ),
    ],
)
def test_settings_rejects_blank_auth_header_when_api_key_is_configured(
    kwargs: dict[str, str], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        Settings(**kwargs)


def test_settings_accepts_declared_production_backends() -> None:
    settings = Settings(
        llm_provider="openai_compatible",
        asr_provider="http",
        asr_base_url="https://asr.example.com",
        speaker_diarization_provider="http",
        speaker_diarization_base_url="https://diarize.example.com",
        aigc_detector_provider="http",
        aigc_detector_base_url="https://aigc.example.com",
        rate_limit_backend="redis",
        offline_task_backend="celery",
        offline_task_execution="async",
        jd_vector_backend="pgvector",
    )

    assert settings.llm_provider == "openai_compatible"
    assert settings.asr_provider == "http"
    assert settings.speaker_diarization_provider == "http"
    assert settings.aigc_detector_provider == "http"
    assert settings.rate_limit_backend == "redis"
    assert settings.offline_task_backend == "celery"
    assert settings.offline_task_execution == "async"
    assert settings.jd_vector_backend == "pgvector"


def test_settings_accepts_aliyun_ws_asr_provider() -> None:
    settings = Settings(asr_provider="aliyun_ws", aliyun_asr_api_key="dashscope-secret")

    assert settings.asr_provider == "aliyun_ws"
    assert settings.aliyun_asr_model == "paraformer-realtime-v2"
    assert settings.aliyun_asr_sample_rate == 16000
    assert settings.aliyun_asr_format == "pcm"


def test_settings_accepts_sherpa_onnx_asr_provider_defaults() -> None:
    settings = Settings(asr_provider="sherpa_onnx")
    assert settings.asr_provider == "sherpa_onnx"
    assert "paraformer" in settings.sherpa_asr_model_dir
    assert settings.sherpa_asr_provider == "cpu"


def test_settings_accepts_aliyun_nls_ws_asr_provider() -> None:
    settings = Settings(
        asr_provider="aliyun_nls_ws",
        aliyun_nls_app_key="nls-app-key",
        aliyun_nls_token="nls-token",
    )

    assert settings.asr_provider == "aliyun_nls_ws"
    assert settings.aliyun_nls_endpoint == "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"
    assert settings.aliyun_nls_sample_rate == 16000
    assert settings.aliyun_nls_format == "pcm"


def test_settings_accepts_aliyun_nls_ws_with_auto_token_credentials() -> None:
    settings = Settings(
        asr_provider="aliyun_nls_ws",
        aliyun_nls_app_key="nls-app-key",
        aliyun_nls_token="",
        aliyun_ak_id="ak-id",
        aliyun_ak_secret="ak-secret",
    )

    assert settings.asr_provider == "aliyun_nls_ws"
    assert settings.aliyun_ak_id == "ak-id"
    assert settings.aliyun_nls_token_endpoint == "https://nls-meta.cn-shanghai.aliyuncs.com/"
    assert settings.aliyun_nls_token_region == "cn-shanghai"


def test_settings_rejects_missing_provider_dependencies() -> None:
    cases = [
        {"asr_provider": "http", "asr_base_url": ""},
        {"asr_provider": "aliyun_ws", "aliyun_asr_api_key": ""},
        {"asr_provider": "aliyun_nls_ws", "aliyun_nls_app_key": "", "aliyun_nls_token": "t"},
        {
            "asr_provider": "aliyun_nls_ws",
            "aliyun_nls_app_key": "a",
            "aliyun_nls_token": "",
            "aliyun_ak_id": "",
            "aliyun_ak_secret": "",
        },
        {
            "asr_provider": "aliyun_nls_ws",
            "aliyun_nls_app_key": "a",
            "aliyun_nls_token": "",
            "aliyun_ak_id": "ak-id",
            "aliyun_ak_secret": "",
        },
        {
            "speaker_diarization_provider": "http",
            "speaker_diarization_base_url": "",
        },
        {"aigc_detector_provider": "http", "aigc_detector_base_url": ""},
        {"rate_limit_backend": "redis", "redis_url": ""},
        {"offline_task_backend": "redis_stream", "redis_url": ""},
        {"offline_task_backend": "celery", "celery_broker_url": ""},
        {"offline_task_backend": "celery", "celery_result_backend": ""},
        {
            "object_storage_endpoint": "http://minio:9000",
            "object_storage_access_key": "access",
            "object_storage_secret_key": "",
        },
    ]

    for kwargs in cases:
        with pytest.raises(ValidationError):
            Settings(**kwargs)


def test_vision_enabled_requires_openai_compatible_provider() -> None:
    with pytest.raises(ValidationError, match="VISION_ENABLED=true requires"):
        Settings(vision_enabled=True, llm_provider="mock")

    assert Settings(vision_enabled=True, llm_provider="openai_compatible").vision_enabled is True


def test_memory_settings_have_safe_defaults() -> None:
    settings = Settings(memory_enabled=False, memory_repo_roots="")

    assert settings.memory_enabled is False
    assert settings.memory_repo_roots == ""
    assert settings.memory_recall_limit == 3
    assert settings.memory_repo_max_commits == 200


def test_memory_recall_limit_is_bounded() -> None:
    with pytest.raises(ValidationError):
        Settings(memory_recall_limit=99)

    with pytest.raises(ValidationError):
        Settings(memory_recall_min_score=1.5)
