from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.testclient import TestClient

from libs.common.config import get_settings
from services.gateway.learning_assets import router


def client_for_store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'gateway.db'}")
    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_assets_persist_across_clients_and_keep_independent_writes(tmp_path, monkeypatch):
    desktop = client_for_store(tmp_path, monkeypatch)
    browser = client_for_store(tmp_path, monkeypatch)
    for client, item in [(desktop, {"id": "desktop", "turns": []}),
                         (browser, {"id": "browser", "turns": []})]:
        assert client.post("/api/learning-assets/sessions/upsert", json={"item": item}).status_code == 200
    # A stale client deleting its own item must not replace the other client's collection.
    desktop.post("/api/learning-assets/sessions/delete", json={"id": "desktop"})
    restarted = client_for_store(tmp_path, monkeypatch)
    assert restarted.get("/api/learning-assets/sessions").json()["items"] == [
        {"id": "browser", "turns": []}
    ]
    assert (tmp_path / "learning_assets.sqlite3").is_file()


def test_migration_is_idempotent_preserves_shared_edits_and_deletions(tmp_path, monkeypatch):
    client = client_for_store(tmp_path, monkeypatch)
    url = "/api/learning-assets/knowledge"
    legacy = {"items": [{"id": "old", "answer": "legacy", "reviewCount": 0}]}
    assert client.post(url + "/migrate", json=legacy).status_code == 200
    current = {"id": "old", "answer": "shared edit", "reviewCount": 4}
    client.post(url + "/upsert", json={"item": current})
    client.post(url + "/migrate", json=legacy)
    assert client.get(url).json()["items"] == [current]
    client.post(url + "/delete", json={"id": "old"})
    client.post(url + "/migrate", json=legacy)
    assert client.get(url).json()["items"] == []


def test_migration_validation_is_atomic_and_review_is_atomic(tmp_path, monkeypatch):
    client = client_for_store(tmp_path, monkeypatch)
    url = "/api/learning-assets/knowledge"
    assert client.post(url + "/migrate", json={"items": [{"id": "ok"}, {}]}).status_code == 422
    assert client.get(url).json()["items"] == []
    client.post(url + "/upsert", json={"item": {"id": "review", "reviewCount": 0}})
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(url + "/review/review", json={}), range(8)))
    assert all(response.status_code == 200 for response in responses)
    assert client.get(url).json()["items"][0]["reviewCount"] == 8
    client.post(url + "/clear", json={})
    assert client.get(url).json()["items"] == []
    assert client.post(url + "/review/review", json={}).status_code == 404
