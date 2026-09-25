import pytest

from libs.common.config import get_settings


@pytest.fixture(autouse=True)
def _isolated_runtime(monkeypatch):
    """测试不得依赖开发者本机 .env：强制 mock LLM 与 stub ASR，避免真实网络调用。"""
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("LLM_API_KEY", "")
    monkeypatch.setenv("LLM_BASE_URL", "")
    monkeypatch.setenv("ASR_PROVIDER", "stub")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
