from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_docker_compose_declares_required_infrastructure() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert compose.startswith("name: shuihuo-killer")
    for service in ["gateway:", "offline-worker:", "postgres:", "redis:", "minio:"]:
        assert service in compose
    assert "postgres:16-alpine" in compose
    assert "redis:7-alpine" in compose
    assert "minio/minio" in compose
    assert "GATEWAY_API_KEY: ${GATEWAY_API_KEY:-}" in compose
    assert "DATABASE_URL: postgresql://shuihuo:shuihuo_local@postgres:5432/shuihuo_killer" in compose
    assert "REDIS_URL: redis://redis:6379/0" in compose
    assert "OBJECT_STORAGE_ENDPOINT: http://minio:9000" in compose
    assert "OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}" in compose
    assert "OTEL_SERVICE_NAME: ${OTEL_SERVICE_NAME:-shuihuo-killer-gateway}" in compose
    assert "SPEAKER_DIARIZATION_PROVIDER: ${SPEAKER_DIARIZATION_PROVIDER:-local}" in compose
    assert "SPEAKER_DIARIZATION_BASE_URL: ${SPEAKER_DIARIZATION_BASE_URL:-}" in compose
    assert "SPEAKER_DIARIZATION_API_PATH: ${SPEAKER_DIARIZATION_API_PATH:-/diarize}" in compose
    assert "SPEAKER_DIARIZATION_API_KEY: ${SPEAKER_DIARIZATION_API_KEY:-}" in compose
    assert "SPEAKER_DIARIZATION_SPEAKER_PATH: ${SPEAKER_DIARIZATION_SPEAKER_PATH:-speaker}" in compose
    for key in [
        "LLM_TIMEOUT_SECONDS: ${LLM_TIMEOUT_SECONDS:-30}",
        "LLM_MAX_RETRIES: ${LLM_MAX_RETRIES:-1}",
        "LLM_RATE_LIMIT_ENABLED: ${LLM_RATE_LIMIT_ENABLED:-false}",
        "LLM_RATE_LIMIT_REQUESTS_PER_MINUTE: ${LLM_RATE_LIMIT_REQUESTS_PER_MINUTE:-60}",
        "AIGC_DETECTOR_PROVIDER: ${AIGC_DETECTOR_PROVIDER:-local}",
        "AIGC_DETECTOR_BASE_URL: ${AIGC_DETECTOR_BASE_URL:-}",
        "AIGC_DETECTOR_API_PATH: ${AIGC_DETECTOR_API_PATH:-/detect}",
        "AIGC_DETECTOR_API_KEY: ${AIGC_DETECTOR_API_KEY:-}",
        "AIGC_AI_PROB_THRESHOLD: ${AIGC_AI_PROB_THRESHOLD:-0.65}",
        "AIGC_TEMPLATE_SIMILARITY_THRESHOLD: ${AIGC_TEMPLATE_SIMILARITY_THRESHOLD:-0.45}",
        "REHEARSAL_THRESHOLD: ${REHEARSAL_THRESHOLD:-0.55}",
        "CHAIN_CRACK_PENALTY: ${CHAIN_CRACK_PENALTY:-8}",
        "CHAIN_HELD_UP_BONUS: ${CHAIN_HELD_UP_BONUS:-3}",
        "QUESTION_MATCH_THRESHOLD: ${QUESTION_MATCH_THRESHOLD:-0.30}",
        "QUESTION_BANK_MIN: ${QUESTION_BANK_MIN:-12}",
        "QUESTION_BANK_MAX: ${QUESTION_BANK_MAX:-18}",
        "DEBUG_TEXT_INPUT_ENABLED: ${DEBUG_TEXT_INPUT_ENABLED:-true}",
    ]:
        assert compose.count(key) == 2
    for key in [
        "ASR_TEXT_PATH: ${ASR_TEXT_PATH:-text}",
        "ASR_START_MS_PATH: ${ASR_START_MS_PATH:-start_ms}",
        "ASR_CONFIDENCE_PATH: ${ASR_CONFIDENCE_PATH:-confidence}",
        "PROBE_MIN_ANSWER_CHARS: ${PROBE_MIN_ANSWER_CHARS:-20}",
        "PROBE_REQUIRE_TOPIC_MATCH: ${PROBE_REQUIRE_TOPIC_MATCH:-true}",
        "SPEAKER_MODE: ${SPEAKER_MODE:-manual}",
        "DIALOGUE_SILENCE_CLOSE_MS: ${DIALOGUE_SILENCE_CLOSE_MS:-2500}",
        "RATE_LIMIT_BACKEND: ${RATE_LIMIT_BACKEND:-local}",
        "REDIS_RATE_LIMIT_PREFIX: ${REDIS_RATE_LIMIT_PREFIX:-shuihuo:rate_limit}",
        "ALIYUN_AK_ID: ${ALIYUN_AK_ID:-}",
        "ALIYUN_AK_SECRET: ${ALIYUN_AK_SECRET:-}",
        "ALIYUN_NLS_TOKEN_ENDPOINT: ${ALIYUN_NLS_TOKEN_ENDPOINT:-https://nls-meta.cn-shanghai.aliyuncs.com/}",
        "ALIYUN_NLS_TOKEN_REGION: ${ALIYUN_NLS_TOKEN_REGION:-cn-shanghai}",
    ]:
        assert key in compose
    assert 'profiles: ["worker"]' in compose
    assert "services.offline_worker.celery_tasks:celery_app" in compose
    assert "CELERY_BROKER_URL: redis://redis:6379/1" in compose
    assert "CELERY_RESULT_BACKEND: redis://redis:6379/2" in compose
    assert compose.count("CELERY_TASK_QUEUE: ${CELERY_TASK_QUEUE:-shuihuo-offline}") == 2
    assert (
        "./db/postgres/001_core_schema.sql:/docker-entrypoint-initdb.d/001_core_schema.sql:ro"
        in compose
    )
    assert "./db/postgres:/docker-entrypoint-initdb.d:ro" not in compose
    assert "002_pgvector_probe_patterns.sql:/docker-entrypoint-initdb.d" not in compose
    assert "healthcheck:" in compose


def test_dockerfile_packages_gateway_app() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert "FROM python:3.11-slim" in dockerfile
    assert 'pip install --no-cache-dir -e ".[postgres,redis,celery,otel]"' in dockerfile
    assert "uvicorn" in dockerfile
    assert "services.gateway.app:app" in dockerfile


def test_pyproject_declares_optional_worker_dependencies() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert 'redis = ["redis>=5.0.0"]' in pyproject
    assert 'celery = ["celery[redis]>=5.3.0"]' in pyproject
    assert "opentelemetry-sdk>=1.26.0" in pyproject
    assert "opentelemetry-exporter-otlp-proto-http>=1.26.0" in pyproject
    assert "opentelemetry-instrumentation-fastapi>=0.47b0" in pyproject


def test_readme_documents_current_default_llm_model() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "mimo-v2.5-pro" in readme
    assert "mimo2.5pro" not in readme


def test_readme_documents_local_ocr_and_nls_asr_setup() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # 精简版 README 以 provider 表的形式覆盖 ASR；OCR 在文档解析说明里提及。
    assert "OCR" in readme
    assert "ASR_PROVIDER=aliyun_nls_ws" in readme
    assert "NLS" in readme


def test_readme_distinguishes_real_llm_smoke_from_mock_mode() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # check_llm.py 的两种输出区分真实模型与本地 mock。
    assert "check_llm.py" in readme
    assert "LLM smoke test ok." in readme
    assert "LLM mock mode ok." in readme
    assert "mock" in readme


def test_readme_explains_demo_gateway_key_input() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # 部署鉴权：GATEWAY_API_KEY + 请求头，网页端 key 只存于浏览器会话。
    assert "GATEWAY_API_KEY" in readme
    assert "X-API-Key" in readme
    assert "浏览器会话" in readme


def test_readme_explains_document_upload_formats() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # 文档上传支持的关键格式与大小上限。
    assert "PDF" in readme
    assert "Word" in readme
    assert "OCR" in readme
    assert "25MB" in readme


def test_readme_explains_asr_smoke_scripts() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # 精简版 README 列出三种 ASR provider 与对应冒烟脚本。
    assert "ASR_PROVIDER=aliyun_ws" in readme
    assert "check_aliyun_asr.py" in readme
    assert "check_aliyun_nls_asr.py" in readme


def test_readme_explains_aliyun_nls_auto_token_mode() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # NLS 既支持 AppKey + Token，也支持 AccessKey 自动签发 Token。
    assert "aliyun_nls_ws" in readme
    assert "Token" in readme
    assert "AccessKey" in readme


def test_env_example_lists_runtime_integration_knobs() -> None:
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")

    for key in [
        "ASR_PROVIDER=",
        "ASR_BASE_URL=",
        "GATEWAY_API_KEY=",
        "LLM_MAX_RETRIES=",
        "LLM_RATE_LIMIT_ENABLED=",
        "LLM_RATE_LIMIT_REQUESTS_PER_MINUTE=",
        "OTEL_EXPORTER_OTLP_ENDPOINT=",
        "OTEL_SERVICE_NAME=",
        "SPEAKER_DIARIZATION_PROVIDER=",
        "SPEAKER_DIARIZATION_BASE_URL=",
        "OFFLINE_TASK_EXECUTION=",
        "CELERY_BROKER_URL=",
        "CELERY_RESULT_BACKEND=",
        "CELERY_TASK_QUEUE=",
        "REDIS_STREAM_PREFIX=",
        "JD_VECTOR_BACKEND=",
        "OBJECT_STORAGE_ACCESS_KEY=",
        "REPORT_DIR=",
        "RATE_LIMIT_BACKEND=",
        "REDIS_RATE_LIMIT_PREFIX=",
        "PROBE_MIN_ANSWER_CHARS=",
        "PROBE_MIN_INTERVAL_MS=",
        "PROBE_REQUIRE_TOPIC_MATCH=",
        "PROBE_TOPIC_KEYWORDS=",
        "SPEAKER_MODE=",
        "DIALOGUE_SILENCE_CLOSE_MS=",
        "CHAIN_CRACK_PENALTY=",
        "CHAIN_HELD_UP_BONUS=",
        "QUESTION_MATCH_THRESHOLD=",
        "QUESTION_BANK_MIN=",
        "QUESTION_BANK_MAX=",
        "DEBUG_TEXT_INPUT_ENABLED=",
        "AIGC_DETECTOR_PROVIDER=",
        "AIGC_DETECTOR_BASE_URL=",
        "AIGC_AI_PROB_THRESHOLD=",
        "AIGC_TEMPLATE_SIMILARITY_THRESHOLD=",
        "REHEARSAL_THRESHOLD=",
        "ALIYUN_AK_ID=",
        "ALIYUN_AK_SECRET=",
        "ALIYUN_NLS_TOKEN_ENDPOINT=",
        "ALIYUN_NLS_TOKEN_REGION=",
    ]:
        assert key in env_example


def test_env_example_includes_complete_deepseek_configuration_block() -> None:
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")

    for line in [
        "# LLM_PROVIDER=openai_compatible",
        "# LLM_MODEL=deepseek-v4-pro",
        "# LLM_BASE_URL=https://api.deepseek.com",
        "# LLM_API_PATH=/chat/completions",
        "# LLM_API_KEY=your-deepseek-key",
        "# LLM_AUTH_HEADER=Authorization",
        "# LLM_AUTH_SCHEME=Bearer",
        "# LLM_RESPONSE_CONTENT_PATH=choices.0.message.content",
    ]:
        assert line in env_example


def test_postgres_schema_matches_core_spec_tables() -> None:
    schema = (ROOT / "db" / "postgres" / "001_core_schema.sql").read_text(encoding="utf-8")

    required_tables = [
        "jobs",
        "candidates",
        "interviews",
        "qa_turns",
        "utterances",
        "probe_chains",
        "question_banks",
        "scores",
        "aigc_results",
        "reports",
        "consents",
    ]
    for table in required_tables:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in schema
    for column in [
        "competency_model JSONB NOT NULL",
        "context JSONB NOT NULL",
        "dimensions JSONB NOT NULL",
        "ai_generated_prob REAL NOT NULL",
        "template_similarity REAL NOT NULL",
        "signal_enabled BOOLEAN NOT NULL DEFAULT false",
        "question_utterance_id UUID REFERENCES utterances(id)",
        "answer_utterance_id UUID REFERENCES utterances(id)",
        "probe_chain_id UUID REFERENCES probe_chains(id)",
        "asked_option_id TEXT CHECK",
        "question_origin TEXT CHECK",
    ]:
        assert column in schema
    assert "REFERENCES jobs(id)" in schema
    assert "REFERENCES candidates(id)" in schema
    assert "REFERENCES interviews(id)" in schema


def test_postgres_schema_enforces_core_contract_invariants() -> None:
    schema = (ROOT / "db" / "postgres" / "001_core_schema.sql").read_text(encoding="utf-8")

    for constraint in [
        "status IN ('CREATED', 'IN_PROGRESS', 'FINISHED', 'SCORING', 'REPORTED')",
        "ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at",
        "turn_index >= 0",
        "question_source IN ('interviewer', 'ai_probe')",
        "question_origin IN ('system_suggested', 'interviewer_custom')",
        "answer_start_ms >= 0",
        "answer_end_ms >= answer_start_ms",
        "jsonb_typeof(dimensions) = 'array' AND jsonb_array_length(dimensions) > 0",
        "total_score >= 0 AND total_score <= 100",
        "jsonb_typeof(risk_notes) = 'array'",
        "recommendation IN ('strong_yes', 'yes', 'hold', 'no')",
        "ai_generated_prob >= 0 AND ai_generated_prob <= 1",
        "template_similarity >= 0 AND template_similarity <= 1",
        "consent_type IN ('behavior_signal')",
        "revoked_at IS NULL OR revoked_at >= granted_at",
        "status = 'CREATED' AND started_at IS NULL AND ended_at IS NULL",
        "status = 'IN_PROGRESS' AND started_at IS NOT NULL AND ended_at IS NULL",
        "status IN ('FINISHED', 'SCORING', 'REPORTED')",
    ]:
        assert constraint in schema
