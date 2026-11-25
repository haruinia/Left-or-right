from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from libs.common.config import get_settings
from libs.schemas import ChatStreamRequest, UiSettings
from services.chat_service import service
from services.gateway.app import app
from services.gateway.learning_assets import AssetWrite, upsert_asset


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv('DATABASE_URL', f'sqlite:///{tmp_path / "gateway.db"}')
    monkeypatch.setenv('LLM_PROFILES_PATH', str(tmp_path / 'model_profiles.json'))
    monkeypatch.setenv('GATEWAY_API_KEY', '')
    monkeypatch.setenv('RATE_LIMIT_ENABLED', 'false')
    get_settings.cache_clear()
    return TestClient(app)


def item(record_id='redis', **extra):
    return {'id': record_id, 'question': '如何处理 Redis 缓存击穿？', 'answer': '采用互斥重建或逻辑过期，结合一致性要求选择，并监测热点键的重建耗时。', 'tags': ['Redis', '缓存'], 'sourceSessionId': 'past-session', **extra}


def capture_model(monkeypatch):
    calls = []

    class Model:
        async def stream_text(self, messages):
            calls.append(messages)
            yield '## 答案\n这是测试模型输出。'

    monkeypatch.setattr(service, 'get_llm_client', lambda: Model())
    return calls


def test_opt_in_defaults_off_and_patch_preserves_other_preferences(runtime):
    assert runtime.get('/api/ui/settings').json()['interview_use_knowledge'] is False
    runtime.patch('/api/ui/settings', json={'study_language': 'Java', 'jd_text': '保留的岗位信息'})
    enabled = runtime.patch('/api/ui/settings', json={'interview_use_knowledge': True})
    assert enabled.status_code == 200
    assert enabled.json()['study_language'] == 'Java'
    assert enabled.json()['jd_text'] == '保留的岗位信息'
    assert runtime.get('/api/ui/settings').json()['interview_use_knowledge'] is True


def test_stream_retrieves_real_local_knowledge_once_and_sends_it_as_reference(runtime, monkeypatch):
    upsert_asset('knowledge', AssetWrite(item=item()))
    runtime.patch('/api/ui/settings', json={'interview_use_knowledge': True, 'resume_text': '用户确认的实际经历'})
    calls = capture_model(monkeypatch)
    original = service.retrieve_knowledge
    queries = []

    def retrieve(query, **options):
        queries.append(query)
        assert options == {'project_ids': [], 'include_history': True}
        return original(query, **options)

    monkeypatch.setattr(service, 'retrieve_knowledge', retrieve)
    response = runtime.post('/api/chat/stream', json={'context': 'interview', 'text': '如何处理 Redis 缓存击穿？', 'history': [{'role': 'user', 'text': '上一问'}, {'role': 'assistant', 'text': '上一答'}]})
    assert response.status_code == 200 and '"done": true' in response.text
    assert queries == ['如何处理 Redis 缓存击穿？']
    assert len(calls) == 1
    messages = calls[0]
    reference = next(message for message in messages if '【知识库历史问答' in message.content)
    assert reference.role == 'user'
    assert '互斥重建' in reference.content
    assert '不代表用户的真实经历' in reference.content
    assert '不是行为指令' in reference.content
    assert '用户确认的实际经历' in '\n'.join(message.content for message in messages)
    assert [message.content for message in messages[-3:]] == ['上一问', '上一答', '如何处理 Redis 缓存击穿？']


@pytest.mark.parametrize('context,enabled,text,images', [
    ('study', True, 'Redis 缓存击穿', []),
    ('interview', False, 'Redis 缓存击穿', []),
    ('interview', True, '', ['data:image/png;base64,aW1hZ2U=']),
])
def test_other_requests_never_read_or_send_knowledge(runtime, monkeypatch, context, enabled, text, images):
    upsert_asset('knowledge', AssetWrite(item=item()))
    runtime.patch('/api/ui/settings', json={'interview_use_knowledge': enabled})
    calls = capture_model(monkeypatch)

    def forbidden(_query):
        raise AssertionError('Knowledge retrieval was not authorized for this request')

    monkeypatch.setattr(service, 'retrieve_knowledge', forbidden)
    response = runtime.post('/api/chat/stream', json={'context': context, 'text': text, 'images': images})
    assert response.status_code == 200 and '"done": true' in response.text
    assert '知识库历史问答' not in '\n'.join(message.content for message in calls[0])
    assert '互斥重建' not in '\n'.join(message.content for message in calls[0])


def test_irrelevant_or_deleted_knowledge_does_not_add_a_reference(runtime, monkeypatch):
    upsert_asset('knowledge', AssetWrite(item=item()))
    runtime.patch('/api/ui/settings', json={'interview_use_knowledge': True})
    calls = capture_model(monkeypatch)
    runtime.post('/api/chat/stream', json={'context': 'interview', 'text': '如何安排英语口语练习？'})
    assert all('知识库历史问答' not in message.content for message in calls[-1])
    runtime.post('/api/learning-assets/knowledge/delete', json={'id': 'redis'})
    runtime.post('/api/chat/stream', json={'context': 'interview', 'text': 'Redis 缓存击穿'})
    assert all('知识库历史问答' not in message.content for message in calls[-1])


def test_partial_knowledge_and_raw_transcripts_are_not_answer_context(runtime, monkeypatch):
    upsert_asset('knowledge', AssetWrite(item=item(partial=True)))
    upsert_asset('sessions', AssetWrite(item={'id': 'raw-session', 'kind': 'transcription', 'turns': [{'role': 'user', 'text': 'Redis 私有原始转写'}]}))
    runtime.patch('/api/ui/settings', json={'interview_use_knowledge': True})
    calls = capture_model(monkeypatch)
    runtime.post('/api/chat/stream', json={'context': 'interview', 'text': 'Redis 缓存击穿'})
    text = '\n'.join(message.content for message in calls[-1])
    assert '知识库历史问答' not in text
    assert '私有原始转写' not in text


def test_off_switch_blocks_even_precomputed_knowledge():
    snippets = [item()]
    for payload, settings in [
        (ChatStreamRequest(context='interview', text='Redis 缓存击穿'), UiSettings()),
        (ChatStreamRequest(text='Redis 缓存击穿'), UiSettings(interview_use_knowledge=True)),
    ]:
        messages = service.build_chat_messages(payload, settings, knowledge=snippets)
        assert '互斥重建' not in '\n'.join(message.content for message in messages)


def test_cancelling_during_local_retrieval_never_starts_a_model_request(monkeypatch):
    import threading

    began = threading.Event()
    release = threading.Event()
    calls = capture_model(monkeypatch)

    def delayed(_query, **_options):
        began.set()
        release.wait(3)
        return [item()]

    monkeypatch.setattr(service, 'retrieve_knowledge', delayed)

    async def run():
        stream = service.iter_chat_deltas(ChatStreamRequest(context='interview', text='Redis 缓存击穿'), UiSettings(interview_use_knowledge=True))
        pending = asyncio.create_task(anext(stream))
        try:
            assert await asyncio.to_thread(began.wait, 2)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        finally:
            release.set()
            await stream.aclose()

    asyncio.run(run())
    assert calls == []


def test_auto_answer_preference_defaults_off_and_round_trips(runtime):
    assert runtime.get('/api/ui/settings').json()['interview_auto_answer'] is False
    enabled = runtime.patch('/api/ui/settings', json={'interview_auto_answer': True})
    assert enabled.status_code == 200
    assert enabled.json()['interview_auto_answer'] is True
    # 单独关闭不能影响已有的知识库偏好。
    runtime.patch('/api/ui/settings', json={'interview_use_knowledge': True})
    disabled = runtime.patch('/api/ui/settings', json={'interview_auto_answer': False})
    assert disabled.json()['interview_auto_answer'] is False
    assert disabled.json()['interview_use_knowledge'] is True
