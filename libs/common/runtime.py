from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel

from libs.common.config import get_settings


def _sherpa_model_ready(settings) -> bool:
    try:
        from services.asr_service.sherpa_engine import sherpa_model_ready

        return sherpa_model_ready(settings)
    except Exception:
        return False


class RuntimeStatus(BaseModel):
    app_env: str
    gateway_auth_enabled: bool
    database_url: str
    otel_exporter_otlp_configured: bool
    otel_service_name: str
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_base_url_configured: bool
    llm_api_path: str
    llm_protocol: str
    llm_max_tokens: int
    llm_api_key_configured: bool
    llm_auth_header: str
    llm_auth_scheme_configured: bool
    llm_response_content_path: str
    llm_extra_body_configured: bool
    llm_max_retries: int
    llm_rate_limit_enabled: bool
    llm_rate_limit_requests_per_minute: int
    asr_provider: str
    asr_base_url_configured: bool
    asr_api_path: str
    asr_api_key_configured: bool
    asr_text_path: str
    asr_speaker_path: str
    asr_is_final_path: str
    asr_confidence_path: str
    asr_timeout_seconds: int
    asr_channel_diarization_configured: bool
    aliyun_asr_api_key_configured: bool
    aliyun_asr_model: str
    aliyun_asr_endpoint_configured: bool
    aliyun_asr_sample_rate: int
    aliyun_asr_format: str
    aliyun_asr_language_hints_configured: bool
    aliyun_nls_app_key_configured: bool
    aliyun_nls_token_configured: bool
    aliyun_nls_token_auto_configured: bool
    aliyun_nls_endpoint_configured: bool
    aliyun_nls_sample_rate: int
    aliyun_nls_format: str
    sherpa_asr_model_dir: str
    sherpa_asr_model_ready: bool
    sherpa_asr_sample_rate: int
    sherpa_asr_provider: str
    probe_min_answer_chars: int
    probe_min_interval_ms: int
    probe_require_topic_match: bool
    probe_topic_keywords_configured: bool
    speaker_diarization_provider: str
    speaker_diarization_base_url_configured: bool
    speaker_diarization_api_key_configured: bool
    speaker_diarization_speaker_path: str
    speaker_diarization_timeout_seconds: int
    aigc_detector_provider: str
    aigc_detector_base_url_configured: bool
    aigc_detector_api_path: str
    aigc_detector_api_key_configured: bool
    aigc_detector_probability_path: str
    aigc_detector_flagged_path: str
    aigc_detector_timeout_seconds: int
    aigc_ai_prob_threshold: float
    aigc_template_similarity_threshold: float
    signal_enabled: bool
    debug_text_input_enabled: bool
    rate_limit_enabled: bool
    rate_limit_backend: str
    rate_limit_requests_per_minute: int
    redis_rate_limit_prefix: str
    offline_task_backend: str
    offline_task_execution: str
    celery_broker_configured: bool
    celery_result_backend_configured: bool
    celery_task_queue: str
    redis_url_configured: bool
    redis_stream_prefix: str
    jd_vector_backend: str
    object_storage_endpoint_configured: bool
    object_storage_credentials_configured: bool
    object_storage_bucket: str
    report_dir: str


def get_runtime_status() -> RuntimeStatus:
    settings = get_settings()
    return RuntimeStatus(
        app_env=settings.app_env,
        gateway_auth_enabled=bool(settings.gateway_api_key),
        database_url=_redact_database_url(settings.database_url),
        otel_exporter_otlp_configured=bool(settings.otel_exporter_otlp_endpoint),
        otel_service_name=settings.otel_service_name,
        llm_provider=settings.llm_provider,
        llm_model=settings.llm_model,
        llm_base_url=settings.llm_base_url,
        llm_base_url_configured=bool(settings.llm_base_url),
        llm_api_path=settings.llm_api_path,
        llm_protocol=settings.llm_protocol,
        llm_max_tokens=settings.llm_max_tokens,
        llm_api_key_configured=bool(settings.llm_api_key),
        llm_auth_header=settings.llm_auth_header,
        llm_auth_scheme_configured=bool(settings.llm_auth_scheme),
        llm_response_content_path=settings.llm_response_content_path,
        llm_extra_body_configured=bool(settings.llm_extra_body_json),
        llm_max_retries=settings.llm_max_retries,
        llm_rate_limit_enabled=settings.llm_rate_limit_enabled,
        llm_rate_limit_requests_per_minute=settings.llm_rate_limit_requests_per_minute,
        asr_provider=settings.asr_provider,
        asr_base_url_configured=bool(settings.asr_base_url),
        asr_api_path=settings.asr_api_path,
        asr_api_key_configured=bool(settings.asr_api_key),
        asr_text_path=settings.asr_text_path,
        asr_speaker_path=settings.asr_speaker_path,
        asr_is_final_path=settings.asr_is_final_path,
        asr_confidence_path=settings.asr_confidence_path,
        asr_timeout_seconds=settings.asr_timeout_seconds,
        asr_channel_diarization_configured=bool(
            settings.asr_interviewer_channels and settings.asr_candidate_channels
        ),
        aliyun_asr_api_key_configured=bool(settings.aliyun_asr_api_key),
        aliyun_asr_model=settings.aliyun_asr_model,
        aliyun_asr_endpoint_configured=bool(settings.aliyun_asr_endpoint),
        aliyun_asr_sample_rate=settings.aliyun_asr_sample_rate,
        aliyun_asr_format=settings.aliyun_asr_format,
        aliyun_asr_language_hints_configured=bool(settings.aliyun_asr_language_hints.strip()),
        aliyun_nls_app_key_configured=bool(settings.aliyun_nls_app_key),
        aliyun_nls_token_configured=bool(settings.aliyun_nls_token),
        aliyun_nls_token_auto_configured=bool(settings.aliyun_ak_id and settings.aliyun_ak_secret),
        aliyun_nls_endpoint_configured=bool(settings.aliyun_nls_endpoint),
        aliyun_nls_sample_rate=settings.aliyun_nls_sample_rate,
        aliyun_nls_format=settings.aliyun_nls_format,
        sherpa_asr_model_dir=settings.sherpa_asr_model_dir,
        sherpa_asr_model_ready=_sherpa_model_ready(settings),
        sherpa_asr_sample_rate=settings.sherpa_asr_sample_rate,
        sherpa_asr_provider=settings.sherpa_asr_provider,
        probe_min_answer_chars=settings.probe_min_answer_chars,
        probe_min_interval_ms=settings.probe_min_interval_ms,
        probe_require_topic_match=settings.probe_require_topic_match,
        probe_topic_keywords_configured=bool(settings.probe_topic_keywords.strip()),
        speaker_diarization_provider=settings.speaker_diarization_provider,
        speaker_diarization_base_url_configured=bool(settings.speaker_diarization_base_url),
        speaker_diarization_api_key_configured=bool(settings.speaker_diarization_api_key),
        speaker_diarization_speaker_path=settings.speaker_diarization_speaker_path,
        speaker_diarization_timeout_seconds=settings.speaker_diarization_timeout_seconds,
        aigc_detector_provider=settings.aigc_detector_provider,
        aigc_detector_base_url_configured=bool(settings.aigc_detector_base_url),
        aigc_detector_api_path=settings.aigc_detector_api_path,
        aigc_detector_api_key_configured=bool(settings.aigc_detector_api_key),
        aigc_detector_probability_path=settings.aigc_detector_probability_path,
        aigc_detector_flagged_path=settings.aigc_detector_flagged_path,
        aigc_detector_timeout_seconds=settings.aigc_detector_timeout_seconds,
        aigc_ai_prob_threshold=settings.aigc_ai_prob_threshold,
        aigc_template_similarity_threshold=settings.aigc_template_similarity_threshold,
        signal_enabled=settings.signal_enabled,
        debug_text_input_enabled=settings.debug_text_input_enabled,
        rate_limit_enabled=settings.rate_limit_enabled,
        rate_limit_backend=settings.rate_limit_backend,
        rate_limit_requests_per_minute=settings.rate_limit_requests_per_minute,
        redis_rate_limit_prefix=settings.redis_rate_limit_prefix,
        offline_task_backend=settings.offline_task_backend,
        offline_task_execution=settings.offline_task_execution,
        celery_broker_configured=bool(settings.celery_broker_url),
        celery_result_backend_configured=bool(settings.celery_result_backend),
        celery_task_queue=settings.celery_task_queue,
        redis_url_configured=bool(settings.redis_url),
        redis_stream_prefix=settings.redis_stream_prefix,
        jd_vector_backend=settings.jd_vector_backend,
        object_storage_endpoint_configured=bool(settings.object_storage_endpoint),
        object_storage_credentials_configured=bool(
            settings.object_storage_access_key and settings.object_storage_secret_key
        ),
        object_storage_bucket=settings.object_storage_bucket,
        report_dir=str(settings.report_dir),
    )


def _redact_database_url(value: str) -> str:
    parsed = urlsplit(value)
    if not parsed.password:
        return value
    username = parsed.username or ""
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    netloc = f"{username}:***@{host}" if username else host
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
