from __future__ import annotations

import json
import logging
import re
from collections import defaultdict, deque
from dataclasses import dataclass, field
from secrets import token_hex
from threading import Lock
from time import monotonic
from uuid import uuid4

from libs.common.config import Settings

try:
    import structlog
except ImportError:  # pragma: no cover - dependency fallback for partially synced envs
    structlog = None  # type: ignore[assignment]

LOGGER_NAME = "shuihuo"
logger = logging.getLogger(LOGGER_NAME)
if not logger.handlers:
    logger.addHandler(logging.StreamHandler())
logger.setLevel(logging.INFO)
TRACEPARENT_RE = re.compile(
    r"^(?P<version>[0-9a-f]{2})-"
    r"(?P<trace_id>[0-9a-f]{32})-"
    r"(?P<span_id>[0-9a-f]{16})-"
    r"(?P<flags>[0-9a-f]{2})$"
)
_otel_lock = Lock()
_otel_configured = False
_structlog_configured = False


def _json_dumps(payload: object, **kwargs: object) -> str:
    kwargs.setdefault("ensure_ascii", False)
    kwargs.setdefault("sort_keys", True)
    kwargs.setdefault("default", str)
    return json.dumps(payload, **kwargs)


def configure_structlog() -> None:
    global _structlog_configured

    if structlog is None or _structlog_configured:
        return

    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.JSONRenderer(serializer=_json_dumps),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    _structlog_configured = True


configure_structlog()


def _label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def request_id_from_header(value: str | None) -> str:
    return value.strip() if value and value.strip() else str(uuid4())


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    sampled: bool = True

    @property
    def traceparent(self) -> str:
        flags = "01" if self.sampled else "00"
        return f"00-{self.trace_id}-{self.span_id}-{flags}"


def trace_context_from_header(value: str | None) -> TraceContext:
    if value:
        match = TRACEPARENT_RE.match(value.strip().lower())
        if match and match.group("trace_id") != "0" * 32 and match.group("span_id") != "0" * 16:
            return TraceContext(
                trace_id=match.group("trace_id"),
                span_id=token_hex(8),
                sampled=match.group("flags") == "01",
            )
    return TraceContext(trace_id=token_hex(16), span_id=token_hex(8))


def log_event(event: str, **fields: object) -> None:
    if structlog is not None:
        structlog.get_logger(LOGGER_NAME).info(event, **fields)
        return

    payload = {"event": event, **fields}
    logger.info(_json_dumps(payload))


@dataclass(frozen=True)
class OpenTelemetryConfigResult:
    enabled: bool
    reason: str


def configure_opentelemetry(app: object, settings: Settings) -> OpenTelemetryConfigResult:
    global _otel_configured

    if not settings.otel_exporter_otlp_endpoint:
        return OpenTelemetryConfigResult(enabled=False, reason="endpoint_not_configured")

    with _otel_lock:
        if _otel_configured:
            return OpenTelemetryConfigResult(enabled=True, reason="already_configured")

        try:
            from opentelemetry import trace
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor
        except ImportError as exc:
            log_event(
                "otel.configure.skipped",
                reason="missing_optional_dependencies",
                error=str(exc),
                endpoint_configured=True,
            )
            return OpenTelemetryConfigResult(
                enabled=False,
                reason="missing_optional_dependencies",
            )

        resource = Resource.create(
            {
                "service.name": settings.otel_service_name,
                "deployment.environment": settings.app_env,
            }
        )
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
        _otel_configured = True
        log_event(
            "otel.configure.enabled",
            service_name=settings.otel_service_name,
            endpoint_configured=True,
        )
        return OpenTelemetryConfigResult(enabled=True, reason="configured")


@dataclass
class RequestStats:
    count: int = 0
    duration_sum: float = 0.0


class MetricsRegistry:
    def __init__(self) -> None:
        self._lock = Lock()
        self._requests: dict[tuple[str, str, int], RequestStats] = defaultdict(RequestStats)
        self._events: dict[str, int] = defaultdict(int)

    def record_request(self, method: str, path: str, status_code: int, duration_seconds: float) -> None:
        key = (method.upper(), path, status_code)
        with self._lock:
            stats = self._requests[key]
            stats.count += 1
            stats.duration_sum += duration_seconds

    def record_event(self, topic: str) -> None:
        with self._lock:
            self._events[topic] += 1

    def render_prometheus(self) -> str:
        lines = [
            "# HELP shuihuo_http_requests_total Total HTTP requests.",
            "# TYPE shuihuo_http_requests_total counter",
        ]
        with self._lock:
            snapshot = sorted(self._requests.items())
            event_snapshot = sorted(self._events.items())
        for (method, path, status), stats in snapshot:
            labels = (
                f'method="{_label_value(method)}",'
                f'path="{_label_value(path)}",'
                f'status="{status}"'
            )
            lines.append(f"shuihuo_http_requests_total{{{labels}}} {stats.count}")

        lines.extend(
            [
                "# HELP shuihuo_http_request_duration_seconds_sum Total HTTP request duration.",
                "# TYPE shuihuo_http_request_duration_seconds_sum counter",
            ]
        )
        for (method, path, status), stats in snapshot:
            labels = (
                f'method="{_label_value(method)}",'
                f'path="{_label_value(path)}",'
                f'status="{status}"'
            )
            lines.append(
                f"shuihuo_http_request_duration_seconds_sum{{{labels}}} "
                f"{stats.duration_sum:.6f}"
            )

        lines.extend(
            [
                "# HELP shuihuo_http_request_duration_seconds_count Counted HTTP request durations.",
                "# TYPE shuihuo_http_request_duration_seconds_count counter",
            ]
        )
        for (method, path, status), stats in snapshot:
            labels = (
                f'method="{_label_value(method)}",'
                f'path="{_label_value(path)}",'
                f'status="{status}"'
            )
            lines.append(f"shuihuo_http_request_duration_seconds_count{{{labels}}} {stats.count}")

        lines.extend(
            [
                "# HELP shuihuo_events_total Total domain and task events published.",
                "# TYPE shuihuo_events_total counter",
            ]
        )
        for topic, count in event_snapshot:
            labels = f'topic="{_label_value(topic)}"'
            lines.append(f"shuihuo_events_total{{{labels}}} {count}")
        return "\n".join(lines) + "\n"

    def reset(self) -> None:
        with self._lock:
            self._requests.clear()
            self._events.clear()


@dataclass
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int = 0


@dataclass
class SlidingWindowRateLimiter:
    requests_per_minute: int
    window_seconds: int = 60
    _events: dict[str, deque[float]] = field(default_factory=lambda: defaultdict(deque))
    _lock: Lock = field(default_factory=Lock)

    def check(self, key: str, now: float | None = None) -> RateLimitDecision:
        if self.requests_per_minute <= 0:
            return RateLimitDecision(allowed=True)

        current = monotonic() if now is None else now
        cutoff = current - self.window_seconds
        with self._lock:
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= self.requests_per_minute:
                retry_after = max(1, int(self.window_seconds - (current - events[0])))
                return RateLimitDecision(allowed=False, retry_after_seconds=retry_after)
            events.append(current)
        return RateLimitDecision(allowed=True)

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


class RedisFixedWindowRateLimiter:
    def __init__(
        self,
        redis_url: str,
        *,
        prefix: str = "shuihuo:rate_limit",
        requests_per_minute: int = 120,
        window_seconds: int = 60,
        client: object | None = None,
    ) -> None:
        self.redis_url = redis_url
        self.prefix = prefix.strip(":")
        self.requests_per_minute = requests_per_minute
        self.window_seconds = window_seconds
        self.client = client or self._connect(redis_url)

    @staticmethod
    def _connect(redis_url: str) -> object:
        try:
            from redis import Redis
        except ImportError as exc:
            raise RuntimeError(
                "Redis rate limit backend requires optional redis dependencies. "
                "Install with `pip install -e .[redis]`."
            ) from exc
        return Redis.from_url(redis_url, decode_responses=True)

    def check(self, key: str, now: float | None = None) -> RateLimitDecision:
        if self.requests_per_minute <= 0:
            return RateLimitDecision(allowed=True)

        current = monotonic() if now is None else now
        bucket = int(current // self.window_seconds)
        redis_key = f"{self.prefix}:{key}:{bucket}"
        count = int(self.client.incr(redis_key))  # type: ignore[attr-defined]
        if count == 1:
            self.client.expire(redis_key, self.window_seconds)  # type: ignore[attr-defined]
        if count > self.requests_per_minute:
            ttl = int(self.client.ttl(redis_key))  # type: ignore[attr-defined]
            return RateLimitDecision(allowed=False, retry_after_seconds=max(1, ttl))
        return RateLimitDecision(allowed=True)


metrics_registry = MetricsRegistry()
rate_limiter = SlidingWindowRateLimiter(requests_per_minute=120)
_redis_rate_limiters: dict[tuple[str, str, int], RedisFixedWindowRateLimiter] = {}


def get_rate_limiter(settings: Settings):
    if settings.rate_limit_backend == "redis":
        key = (
            settings.redis_url,
            settings.redis_rate_limit_prefix,
            settings.rate_limit_requests_per_minute,
        )
        limiter = _redis_rate_limiters.get(key)
        if limiter is None:
            limiter = RedisFixedWindowRateLimiter(
                redis_url=settings.redis_url,
                prefix=settings.redis_rate_limit_prefix,
                requests_per_minute=settings.rate_limit_requests_per_minute,
            )
            _redis_rate_limiters[key] = limiter
        return limiter

    rate_limiter.requests_per_minute = settings.rate_limit_requests_per_minute
    return rate_limiter


def reset_rate_limiters() -> None:
    rate_limiter.reset()
    _redis_rate_limiters.clear()
