import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "local"
    gateway_api_key: str = ""
    database_url: str = "sqlite:///data/shuihuo_killer.db"
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "shuihuo-killer-gateway"
    llm_provider: Literal["mock", "openai_compatible"] = "mock"
    llm_model: str = "example-model"
    llm_base_url: str = "https://api.example.com/v1"
    llm_api_path: str = "/chat/completions"
    # auto: infer from the endpoint path; explicit values override it.
    llm_protocol: Literal[
        "auto", "openai_chat", "openai_responses", "anthropic_messages"
    ] = "auto"
    # 0 means "do not send an output budget"; providers then apply their own default.
    llm_max_tokens: int = Field(default=30000, ge=0, le=1_000_000)
    llm_api_key: str = ""
    llm_auth_header: str = "api-key"
    llm_auth_scheme: str = ""
    llm_response_content_path: str = "choices.0.message.content"
    llm_extra_body_json: str = ""
    llm_timeout_seconds: int = Field(default=30, gt=0)
    llm_max_retries: int = Field(default=1, ge=0)
    llm_rate_limit_enabled: bool = False
    llm_rate_limit_requests_per_minute: int = Field(default=60, ge=0)
    vision_enabled: bool = False
    vision_model: str = ""
    vision_max_image_bytes: int = Field(default=4 * 1024 * 1024, gt=0)
    memory_enabled: bool = False
    memory_repo_roots: str = ""
    memory_repo_max_commits: int = Field(default=200, ge=1)
    memory_repo_max_repos: int = Field(default=20, ge=1)
    memory_recall_limit: int = Field(default=3, ge=1, le=20)
    memory_recall_min_score: float = Field(default=0.12, ge=0.0, le=1.0)
    asr_provider: Literal["stub", "http", "aliyun_ws", "aliyun_nls_ws", "sherpa_onnx"] = "stub"
    asr_base_url: str = ""
    asr_api_path: str = "/transcribe"
    asr_api_key: str = ""
    asr_auth_header: str = "Authorization"
    asr_auth_scheme: str = "Bearer"
    asr_text_path: str = "text"
    asr_speaker_path: str = "speaker"
    asr_start_ms_path: str = "start_ms"
    asr_end_ms_path: str = "end_ms"
    asr_is_final_path: str = "is_final"
    asr_confidence_path: str = "confidence"
    asr_timeout_seconds: int = Field(default=30, gt=0)
    asr_interviewer_channels: str = "0,left,interviewer"
    asr_candidate_channels: str = "1,right,candidate"
    aliyun_asr_api_key: str = ""
    aliyun_asr_model: str = "paraformer-realtime-v2"
    aliyun_asr_sample_rate: int = Field(default=16000, gt=0)
    aliyun_asr_format: str = "pcm"
    aliyun_asr_language_hints: str = "zh,en"
    # DashScope Paraformer 热词表 ID：预先创建的热词表，提高专业术语/人名识别率。
    aliyun_asr_vocabulary_id: str = ""
    aliyun_asr_endpoint: str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    aliyun_nls_app_key: str = ""
    aliyun_nls_token: str = ""
    aliyun_nls_endpoint: str = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"
    aliyun_nls_sample_rate: int = Field(default=16000, gt=0)
    aliyun_nls_format: str = "pcm"
    # NLS 热词表 ID / 定制模型 ID：提高专业术语、人名等的识别率。
    # 热词表需先创建（智能语音交互控制台「热词」，或用 scripts/create_nls_vocabulary.py），填入返回的 ID。
    aliyun_nls_vocabulary_id: str = ""
    aliyun_nls_customization_id: str = ""
    aliyun_ak_id: str = ""
    aliyun_ak_secret: str = ""
    aliyun_nls_token_endpoint: str = "https://nls-meta.cn-shanghai.aliyuncs.com/"
    aliyun_nls_token_region: str = "cn-shanghai"
    # Local streaming ASR via sherpa-onnx (optional extra: pip install -e ".[sherpa]").
    sherpa_asr_model_dir: str = "models/sherpa-onnx-streaming-paraformer-bilingual-zh-en"
    sherpa_asr_sample_rate: int = Field(default=16000, gt=0)
    sherpa_asr_num_threads: int = Field(default=2, ge=1, le=16)
    sherpa_asr_provider: str = "cpu"
    sherpa_asr_use_int8: bool = True
    # Endpoint rule2 is the practical sentence end when speech has been heard.
    # 0.8s is snappier than the sherpa default 1.2s for interview turn-taking.
    sherpa_asr_rule1_min_trailing_silence: float = Field(default=2.4, ge=0.0)
    sherpa_asr_rule2_min_trailing_silence: float = Field(default=0.8, ge=0.0)
    sherpa_asr_rule3_min_utterance_length: float = Field(default=20.0, ge=0.0)
    speaker_mode: Literal["manual", "dual_channel", "http_diarization"] = "manual"
    dialogue_silence_close_ms: int = Field(default=2500, ge=0)
    probe_min_answer_chars: int = Field(default=20, ge=0)
    probe_min_interval_ms: int = Field(default=1000, ge=0)
    probe_require_topic_match: bool = Field(
        default=True,
        description="Deprecated compatibility option; v2 probing does not read it.",
    )
    probe_topic_keywords: str = Field(
        default=(
            "项目,技术,架构,方案,决策,优化,性能,指标,数据,负责,实现,"
            "上线,故障,异常,成本,延迟,吞吐,FastAPI,LLM,Python"
        ),
        description="Deprecated compatibility option; v2 probing does not read it.",
    )
    chain_crack_penalty: float = Field(default=8.0, ge=0.0)
    chain_held_up_bonus: float = Field(default=3.0, ge=0.0)
    question_match_threshold: float = Field(default=0.30, ge=0.0, le=1.0)
    question_bank_min: int = Field(default=12, ge=1)
    question_bank_max: int = Field(default=18, ge=1)
    debug_text_input_enabled: bool = True
    speaker_diarization_provider: Literal["local", "http"] = "local"
    speaker_diarization_base_url: str = ""
    speaker_diarization_api_path: str = "/diarize"
    speaker_diarization_api_key: str = ""
    speaker_diarization_auth_header: str = "Authorization"
    speaker_diarization_auth_scheme: str = "Bearer"
    speaker_diarization_speaker_path: str = "speaker"
    speaker_diarization_timeout_seconds: int = Field(default=10, gt=0)
    aigc_detector_provider: Literal["local", "http"] = "local"
    aigc_detector_base_url: str = ""
    aigc_detector_api_path: str = "/detect"
    aigc_detector_api_key: str = ""
    aigc_detector_auth_header: str = "Authorization"
    aigc_detector_auth_scheme: str = "Bearer"
    aigc_detector_probability_path: str = "ai_generated_prob"
    aigc_detector_flagged_path: str = "flagged"
    aigc_detector_timeout_seconds: int = Field(default=10, gt=0)
    aigc_ai_prob_threshold: float = Field(default=0.65, ge=0.0, le=1.0)
    aigc_template_similarity_threshold: float = Field(default=0.45, ge=0.0, le=1.0)
    rehearsal_threshold: float = Field(default=0.55, ge=0.0, le=1.0)
    signal_enabled: bool = False
    rate_limit_enabled: bool = False
    rate_limit_backend: Literal["local", "redis"] = "local"
    rate_limit_requests_per_minute: int = Field(default=120, ge=0)
    redis_rate_limit_prefix: str = "shuihuo:rate_limit"
    offline_task_backend: Literal["local", "redis_stream", "celery"] = "local"
    offline_task_execution: Literal["sync", "async"] = "sync"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"
    celery_task_queue: str = "shuihuo-offline"
    redis_url: str = "redis://localhost:6379/0"
    redis_stream_prefix: str = "shuihuo"
    jd_vector_backend: Literal["local", "pgvector"] = "local"
    object_storage_endpoint: str = ""
    object_storage_bucket: str = "shuihuo-killer"
    object_storage_access_key: str = ""
    object_storage_secret_key: str = ""
    object_storage_region: str = "us-east-1"
    report_dir: Path = Field(default=Path("data/reports"))

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode="after")
    def runtime_dependencies_are_configured(self) -> "Settings":
        if self.question_bank_max < self.question_bank_min:
            raise ValueError("QUESTION_BANK_MAX must be greater than or equal to QUESTION_BANK_MIN")
        if self.vision_enabled and self.llm_provider != "openai_compatible":
            raise ValueError("VISION_ENABLED=true requires LLM_PROVIDER=openai_compatible")
        if self.asr_provider == "http" and not self.asr_base_url.strip():
            raise ValueError("ASR_PROVIDER=http requires ASR_BASE_URL")
        if (
            self.llm_provider == "openai_compatible"
            and self.llm_api_key.strip()
            and not self.llm_auth_header.strip()
        ):
            raise ValueError("LLM_AUTH_HEADER is required when LLM_API_KEY is configured")
        if (
            self.asr_provider == "http"
            and self.asr_api_key.strip()
            and not self.asr_auth_header.strip()
        ):
            raise ValueError("ASR_AUTH_HEADER is required when ASR_API_KEY is configured")
        if self.asr_provider == "aliyun_ws" and not self.aliyun_asr_api_key.strip():
            raise ValueError("ASR_PROVIDER=aliyun_ws requires ALIYUN_ASR_API_KEY")
        if self.asr_provider == "sherpa_onnx" and not self.sherpa_asr_model_dir.strip():
            raise ValueError("ASR_PROVIDER=sherpa_onnx requires SHERPA_ASR_MODEL_DIR")
        if self.asr_provider == "aliyun_nls_ws":
            if not self.aliyun_nls_app_key.strip():
                raise ValueError("ASR_PROVIDER=aliyun_nls_ws requires ALIYUN_NLS_APP_KEY")
            if not self.aliyun_nls_token.strip() and not (
                self.aliyun_ak_id.strip() and self.aliyun_ak_secret.strip()
            ):
                raise ValueError(
                    "ASR_PROVIDER=aliyun_nls_ws requires ALIYUN_NLS_TOKEN, "
                    "or ALIYUN_AK_ID and ALIYUN_AK_SECRET"
                )
        if (
            self.speaker_diarization_provider == "http"
            and not self.speaker_diarization_base_url.strip()
        ):
            raise ValueError(
                "SPEAKER_DIARIZATION_PROVIDER=http requires SPEAKER_DIARIZATION_BASE_URL"
            )
        if (
            self.speaker_diarization_provider == "http"
            and self.speaker_diarization_api_key.strip()
            and not self.speaker_diarization_auth_header.strip()
        ):
            raise ValueError(
                "SPEAKER_DIARIZATION_AUTH_HEADER is required when "
                "SPEAKER_DIARIZATION_API_KEY is configured"
            )
        if self.aigc_detector_provider == "http" and not self.aigc_detector_base_url.strip():
            raise ValueError("AIGC_DETECTOR_PROVIDER=http requires AIGC_DETECTOR_BASE_URL")
        if (
            self.aigc_detector_provider == "http"
            and self.aigc_detector_api_key.strip()
            and not self.aigc_detector_auth_header.strip()
        ):
            raise ValueError(
                "AIGC_DETECTOR_AUTH_HEADER is required when AIGC_DETECTOR_API_KEY is configured"
            )
        if self.rate_limit_backend == "redis" and not self.redis_url.strip():
            raise ValueError("RATE_LIMIT_BACKEND=redis requires REDIS_URL")
        if self.offline_task_backend == "redis_stream" and not self.redis_url.strip():
            raise ValueError("OFFLINE_TASK_BACKEND=redis_stream requires REDIS_URL")
        if self.offline_task_backend == "celery":
            if not self.celery_broker_url.strip():
                raise ValueError("OFFLINE_TASK_BACKEND=celery requires CELERY_BROKER_URL")
            if not self.celery_result_backend.strip():
                raise ValueError("OFFLINE_TASK_BACKEND=celery requires CELERY_RESULT_BACKEND")
        if self.object_storage_endpoint and bool(self.object_storage_access_key) != bool(
            self.object_storage_secret_key
        ):
            raise ValueError(
                "OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY must be configured together"
            )
        if self.llm_extra_body_json.strip():
            try:
                extra_body = json.loads(self.llm_extra_body_json)
            except json.JSONDecodeError as exc:
                raise ValueError("LLM_EXTRA_BODY_JSON must be valid JSON") from exc
            if not isinstance(extra_body, dict):
                raise ValueError("LLM_EXTRA_BODY_JSON must decode to an object")
        for env_name, value in {
            "LLM_RESPONSE_CONTENT_PATH": self.llm_response_content_path,
            "ASR_TEXT_PATH": self.asr_text_path,
            "ASR_SPEAKER_PATH": self.asr_speaker_path,
            "ASR_START_MS_PATH": self.asr_start_ms_path,
            "ASR_END_MS_PATH": self.asr_end_ms_path,
            "ASR_IS_FINAL_PATH": self.asr_is_final_path,
            "ASR_CONFIDENCE_PATH": self.asr_confidence_path,
            "SPEAKER_DIARIZATION_SPEAKER_PATH": self.speaker_diarization_speaker_path,
            "AIGC_DETECTOR_PROBABILITY_PATH": self.aigc_detector_probability_path,
            "AIGC_DETECTOR_FLAGGED_PATH": self.aigc_detector_flagged_path,
        }.items():
            if _invalid_dot_path(value):
                raise ValueError(f"{env_name} must be a non-empty dot path")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


def _invalid_dot_path(value: str) -> bool:
    return not value.strip() or any(not part.strip() for part in value.split("."))
