import io
import json
import os
import sqlite3
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from libs.common.config import get_settings
from services.document_service import service as documents
from services.gateway import knowledge as api
from services.knowledge_service import store


@pytest.fixture

def database(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'gateway.db'}")
    get_settings.cache_clear()
    yield tmp_path / "learning_assets.sqlite3"
    get_settings.cache_clear()


@pytest.fixture

def client(database, monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    monkeypatch.setattr(api, "on_project_deleted", None)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 25000)) as test_client:
        yield test_client


def publish(project, files, *, replace=False):
    task = store.begin_import(project["id"])
    for path, text in files.items():
        store.stage_file(project["id"], task, path, text.encode() if isinstance(text, str) else text)
    return store.finish_import(project["id"], task, replace=replace)


def docx(text, *, prefix=""):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", prefix + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
    return buffer.getvalue()


def text_pdf():
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 10 700 Td (Redis cache architecture) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def test_schema_migration_preserves_legacy_assets_and_is_idempotent(database):
    legacy = {"id": "legacy", "question": "Redis", "answer": "cache"}
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE assets(kind TEXT,id TEXT,payload TEXT,deleted INTEGER DEFAULT 0,PRIMARY KEY(kind,id))")
        connection.execute("INSERT INTO assets VALUES ('knowledge','legacy',?,0)", (json.dumps(legacy),))
    assert store.capabilities()["fts5"] is True
    assert store.capabilities()["local_only"] is True
    store.create_project("文档")
    with sqlite3.connect(database) as connection:
        assert json.loads(connection.execute("SELECT payload FROM assets").fetchone()[0]) == legacy
        assert connection.execute("SELECT count(*) FROM knowledge_projects").fetchone()[0] == 1
    if os.name != "nt":
        assert database.stat().st_mode & 0o777 == 0o600


def test_staging_is_not_visible_until_atomic_finish_and_cancel_preserves_old(database):
    project = store.create_project("Redis 项目")
    publish(project, {"cache.md": "# Redis\nRedis 使用随机 TTL"})
    task = store.begin_import(project["id"])
    store.stage_file(project["id"], task, "cache.md", b"# Kafka\nKafka consumer offset")
    assert store.search("Redis", [project["id"]])
    assert not store.search("Kafka", [project["id"]])
    store.cancel_import(project["id"], task)
    assert store.search("Redis", [project["id"]])
    assert not store.search("Kafka", [project["id"]])
    assert store.project_detail(project["id"])["project"]["document_count"] == 1


def test_project_scoped_bm25_retrieval_has_source_and_chinese_metadata(database):
    first, second = store.create_project("缓存服务"), store.create_project("另一项目")
    publish(first, {"docs/cache.md": "# 系统设计\n\n## 缓存雪崩\n缓存雪崩使用随机过期时间和流量限流。\n\n## 持久化\nRedis AOF 保存日志。"})
    publish(second, {"cache.md": "# 缓存雪崩\n另一项目的缓存雪崩处理。"})
    assert store.search("缓存雪崩如何处理", []) == []
    hits = store.search("缓存雪崩如何处理", [first["id"]])
    assert hits
    assert all(hit["project_id"] == first["id"] for hit in hits)
    hit = hits[0]
    assert hit["kind"] == "document"
    assert hit["project_name"] == "缓存服务"
    assert hit["relative_path"] == "docs/cache.md"
    assert hit["heading"] == "系统设计 / 缓存雪崩"
    assert hit["start_line"] == 3
    assert hit["end_line"] >= 4
    assert "随机过期" in hit["text"]
    assert store.search("毫不相关的职业发展计划", [first["id"]]) == []
    assert store.search("请介绍一下", [first["id"]]) == []


def test_exact_english_tokens_and_fts_operators_are_not_interpreted(database):
    project = store.create_project("语言")
    publish(project, {"one.md": "# Java\nJava virtual machine", "two.md": "# JavaScript\nJavaScript browser", "three.md": "# C++\nC++ memory ownership"})
    assert [hit["relative_path"] for hit in store.search("Java", [project["id"]])] == ["one.md"]
    assert [hit["relative_path"] for hit in store.search("C++", [project["id"]])] == ["three.md"]
    assert store.search('" OR * NEAR(-) :', [project["id"]]) == []


def test_total_search_budget_includes_metadata(database):
    project = store.create_project("项目" * 50)
    publish(project, {f"docs/file-{index}.md": "# Redis\n" + "Redis 缓存随机过期。" * 100 for index in range(5)})
    for budget in (250, 500, 1000, 6000, 9000):
        hits = store.search("Redis 缓存", [project["id"]], limit=100, max_chars=budget)
        assert len(hits) <= 3
        assert sum(len(json.dumps(hit, ensure_ascii=False)) for hit in hits) <= min(budget, 6000)


def test_search_small_budget_keeps_the_matching_window(database):
    project = store.create_project("excerpt")
    publish(project, {"notes.md": "filler " * 160 + "Redis cache jitter prevents avalanche"})
    hits = store.search("Redis", [project["id"]], max_chars=400)
    assert hits and "Redis" in hits[0]["text"]
    assert len(json.dumps(hits[0], ensure_ascii=False)) <= 400


def test_hash_skip_stable_id_and_parser_version_increment(database, monkeypatch):
    project = store.create_project("版本")
    publish(project, {"readme.md": "# Redis\nTTL"})
    first = store.project_detail(project["id"])["documents"][0]
    skipped = publish(project, {"readme.md": "# Redis\nTTL"})
    assert skipped["unchanged"] == 1 and skipped["imported"] == 0
    assert store.project_detail(project["id"])["documents"][0]["version"] == 1
    publish(project, {"readme.md": "# Redis\nTTL changed"})
    changed = store.project_detail(project["id"])["documents"][0]
    assert changed["id"] == first["id"] and changed["version"] == 2
    monkeypatch.setattr(store, "PARSER_VERSION", 2)
    reparsed = publish(project, {"readme.md": "# Redis\nTTL changed"})
    assert reparsed["imported"] == 1
    assert store.project_detail(project["id"])["documents"][0]["version"] == 3


def test_failed_refresh_preserves_ready_version_and_reports_survive_restart(database):
    project = store.create_project("更新")
    publish(project, {"keep.md": "# Redis\nRedis stable", "removed.md": "Kafka offset"})
    finished = publish(project, {"keep.md": b"\x00binary"}, replace=True)
    assert finished["failed"] == 1
    assert store.search("Redis", [project["id"]])
    assert store.search("Kafka", [project["id"]]) == []
    detail = store.project_detail(project["id"])
    assert detail["project"]["document_count"] == 1
    assert detail["last_import"][0]["status"] == "failed"
    assert detail["last_import"][0]["path"] == "keep.md"
    assert detail["last_import"][0]["reason"]


def test_refresh_keeps_skipped_old_files_and_supports_explicit_empty_directory(database):
    project = store.create_project("刷新")
    publish(project, {"keep.md": "Redis stable", "removed.md": "Kafka old"})
    task = store.begin_import(project["id"])
    result = store.finish_import(project["id"], task, replace=True, preserve_paths=["keep.md", "unknown.md"])
    assert result["project"]["document_count"] == 1
    assert store.search("Redis", [project["id"]])
    assert not store.search("Kafka", [project["id"]])
    task = store.begin_import(project["id"])
    result = store.finish_import(project["id"], task, replace=True)
    assert result["project"]["document_count"] == 0
    task = store.begin_import(project["id"])
    with pytest.raises(store.KnowledgeError):
        store.finish_import(project["id"], task, replace=False)
    with pytest.raises(store.KnowledgeError):
        store.finish_import(project["id"], task, replace=True, preserve_paths=["../unsafe"])


def test_cancel_while_parser_is_running_never_publishes_partial_document(database, monkeypatch):
    project = store.create_project("取消")
    publish(project, {"keep.md": "Redis original"})
    task = store.begin_import(project["id"])
    def cancel_parser(_name, _data):
        with pytest.raises(store.KnowledgeError) as pending:
            store.finish_import(project["id"], task)
        assert pending.value.status == 409
        store.cancel_import(project["id"], task)
        return "Kafka replacement"
    monkeypatch.setattr(store, "extract_local_document", cancel_parser)
    with pytest.raises(store.KnowledgeError) as canceled:
        store.stage_file(project["id"], task, "keep.md", b"new")
    assert canceled.value.status == 404
    assert store.search("Redis", [project["id"]])
    assert not store.search("Kafka", [project["id"]])


def test_failed_publication_rolls_back_all_document_and_index_changes(database, monkeypatch):
    project = store.create_project("事务")
    publish(project, {"keep.md": "Redis original"})
    task = store.begin_import(project["id"])
    store.stage_file(project["id"], task, "keep.md", b"Kafka new")
    def fail_index(_text):
        raise RuntimeError("test index failure")
    monkeypatch.setattr(store, "index_tokens", fail_index)
    with pytest.raises(RuntimeError):
        store.finish_import(project["id"], task)
    assert store.search("Redis", [project["id"]])
    assert not store.search("Kafka", [project["id"]])


def test_delete_cleans_index_and_project_copies_only(database, tmp_path):
    project = store.create_project("删除")
    source = tmp_path / "source.md"
    source.write_text("Redis original")
    publish(project, {"source.md": source.read_bytes(), "keep.md": "Kafka original"})
    document = next(item for item in store.project_detail(project["id"])["documents"] if item["relative_path"] == "source.md")
    store.delete_document(project["id"], document["id"])
    assert not store.search("Redis", [project["id"]])
    assert source.read_text() == "Redis original"
    store.delete_project(project["id"])
    assert store.list_projects() == []
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM knowledge_chunks").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM knowledge_fts").fetchone()[0] == 0
    assert source.exists()


@pytest.mark.parametrize("path", ["../escape.md", "/etc/config.md", "C:/Users/a.md", "docs\\file.md", "a//b.md", "a/./b.md", "a/../b.md", "docs/evil\x00.md", ".env", ".env.local", "docs/.env.md", ".git/config.md", "node_modules/x.md", "dist/x.md", "credentials.json", "secrets.yaml", "service-account.json", "private_key.json", "id_rsa", "image.png", "resume.doc"])
def test_import_rejects_unsafe_paths_and_types(database, path):
    project = store.create_project("安全")
    task = store.begin_import(project["id"])
    with pytest.raises(store.KnowledgeError):
        store.stage_file(project["id"], task, path, b"text")
    store.cancel_import(project["id"], task)
    assert store.project_detail(project["id"])["project"]["document_count"] == 0


def test_limits_reject_oversize_count_bytes_text_and_leave_ready_copy(database, monkeypatch):
    project = store.create_project("限制")
    task = store.begin_import(project["id"])
    with pytest.raises(store.KnowledgeError) as oversized:
        store.stage_file(project["id"], task, "large.md", b"x" * (documents.KNOWLEDGE_MAX_BYTES + 1))
    assert oversized.value.status == 413
    monkeypatch.setattr(store, "MAX_TOTAL_BYTES", 20)
    store.stage_file(project["id"], task, "first.md", b"Redis original")
    with pytest.raises(store.KnowledgeError) as total:
        store.stage_file(project["id"], task, "second.md", b"Redis next")
    assert total.value.status == 413
    monkeypatch.setattr(store, "MAX_TOTAL_BYTES", 100000)
    monkeypatch.setattr(store, "MAX_FILES", 1)
    with pytest.raises(store.KnowledgeError):
        store.stage_file(project["id"], task, "second.md", b"x")
    store.cancel_import(project["id"], task)
    monkeypatch.setattr(store, "MAX_FILES", 1000)
    monkeypatch.setattr(store, "MAX_TOTAL_CHARS", 5)
    task = store.begin_import(project["id"])
    status = store.stage_file(project["id"], task, "too-long.md", b"Redis longer")
    assert status["status"] == "failed"
    store.finish_import(project["id"], task)
    assert not store.project_detail(project["id"])["documents"]


def test_only_one_import_per_project_and_expired_staging_is_never_published(database, monkeypatch):
    project = store.create_project("任务")
    task = store.begin_import(project["id"])
    store.stage_file(project["id"], task, "draft.md", b"Redis draft")
    with pytest.raises(store.KnowledgeError) as busy:
        store.begin_import(project["id"])
    assert busy.value.status == 409
    monkeypatch.setattr(store.time, "time", lambda: 999999999999)
    assert store.search("Redis", [project["id"]]) == []
    replacement = store.begin_import(project["id"])
    assert replacement != task
    assert not store.project_detail(project["id"])["documents"]
    with pytest.raises(store.KnowledgeError):
        store.finish_import(project["id"], task)


def test_chunks_ignore_fenced_headings_and_keep_real_line_ranges():
    text = "\n# Real\nparagraph\n```md\n## Not a heading\n```\n## Next\nText"
    parts = store.chunks(text)
    real = next(item for item in parts if item["heading"] == "Real")
    assert real["start_line"] == 2 and real["end_line"] == 6
    assert "Not a heading" in real["text"]
    assert not any("Not a heading" in part["heading"] for part in parts)
    assert parts[-1]["heading"] == "Real / Next"
    assert parts[-1]["start_line"] == 7
    long = store.chunks("# Redis\n" + "x" * 10000)
    assert all(len(part["text"]) <= store.CHUNK_CHARS for part in long)


def test_local_extractors_never_call_cloud_cleanup_and_preserve_text_lines(monkeypatch):
    monkeypatch.setattr(documents, "_clean_with_llm", lambda *_args, **_kwargs: pytest.fail("local import called cloud cleanup"))
    assert documents.extract_local_document("README.md", b"\n# Redis\nText\n") == "\n# Redis\nText\n"
    assert documents.extract_local_document("cache.py", b"print('Redis')") == "print('Redis')"
    assert documents.extract_local_document("utf16.txt", "缓存架构".encode("utf-16")) == "缓存架构"
    assert documents.extract_local_document("utf8.txt", "缓存架构".encode()) == "缓存架构"
    assert documents.extract_local_document("gbk.txt", "缓存架构".encode("gb18030")) == "缓存架构"
    assert documents.extract_local_document("cache.docx", docx("Redis 缓存")) == "Redis 缓存"
    assert "Redis cache architecture" in documents.extract_local_document("cache.pdf", text_pdf())
    for filename, content in (("binary.txt", b"\x00\x01"), ("old.doc", b"text"), ("image.png", b"text"), ("huge.md", b"x" * (documents.KNOWLEDGE_MAX_CHARS + 1))):
        with pytest.raises(ValueError):
            documents.extract_local_document(filename, content)


def test_pdf_local_extraction_checks_elapsed_budget(monkeypatch):
    values = iter([0, 11])
    monkeypatch.setattr(documents, "monotonic", lambda: next(values))
    with pytest.raises(ValueError):
        documents.extract_local_document("slow.pdf", text_pdf())


def test_docx_bomb_and_entity_declarations_are_rejected():
    with pytest.raises(ValueError):
        documents.extract_local_document("bad.docx", docx("x" * 500000))
    with pytest.raises(ValueError):
        documents.extract_local_document("bad.docx", docx("text", prefix='<!DOCTYPE root [<!ENTITY sample "sample">]>'))
    with pytest.raises(ValueError):
        documents.extract_local_document("bad.docx", b"invalid zip")


def test_api_project_import_preview_refresh_and_no_store(client):
    response = client.get("/api/knowledge/capabilities")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert ".docx" in response.json()["suffixes"]
    project = client.post("/api/knowledge/projects", json={"name": "API 项目"}).json()["project"]
    base = f"/api/knowledge/projects/{project['id']}"
    assert client.patch(base, json={"name": "重命名"}).json()["project"]["name"] == "重命名"
    task = client.post(base + "/imports", json={}).json()["import_id"]
    upload = client.post(base + f"/imports/{task}/files", data={"relative_path": "docs/cache.md"}, files={"file": ("cache.md", b"# Redis\nRedis cache")})
    assert upload.status_code == 200, upload.text
    assert upload.json()["status"] == "ready"
    assert client.get(base).json()["documents"] == []
    result = client.post(base + f"/imports/{task}/finish", json={"replace": False})
    assert result.status_code == 200, result.text
    document = client.get(base).json()["documents"][0]
    preview = client.get(base + f"/documents/{document['id']}").json()["document"]
    assert preview["text"] == "# Redis\nRedis cache"
    assert preview["chunks"][0]["heading"] == "Redis"
    assert client.get(base).json()["last_import"][0]["path"] == "docs/cache.md"
    assert client.delete(base + f"/documents/{document['id']}").status_code == 200
    assert client.delete(base).status_code == 200
    assert client.get("/api/knowledge/projects").json()["projects"] == []


@pytest.mark.parametrize("headers", [{"Origin": "https://evil.invalid"}, {"Origin": "null"}, {"Origin": "http://localhost:9958"}, {"Origin": "http://127.0.0.1:9958/evil"}, {"Sec-Fetch-Site": "cross-site"}])
def test_api_denies_cross_origin_and_untrusted_settings_sources(client, headers):
    assert client.get("/api/knowledge/projects", headers=headers).status_code == 403
    assert client.post("/api/knowledge/projects", json={"name": "bad"}, headers=headers).status_code == 403


def test_api_accepts_exact_same_origin_and_rejects_nonloopback(database):
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("127.0.0.1", 25000)) as local:
        assert local.get("/api/knowledge/projects", headers={"Origin": "http://127.0.0.1:9958"}).status_code == 200
    with TestClient(app, base_url="http://127.0.0.1:9958", client=("192.0.2.1", 25000)) as remote:
        assert remote.get("/api/knowledge/projects").status_code == 403
    with TestClient(app, base_url="http://evil.invalid", client=("127.0.0.1", 25000)) as spoofed_host:
        assert spoofed_host.get("/api/knowledge/projects").status_code == 403


def test_api_oversize_upload_rejected_before_parsing(client):
    project = client.post("/api/knowledge/projects", json={"name": "API"}).json()["project"]
    base = f"/api/knowledge/projects/{project['id']}"
    task = client.post(base + "/imports").json()["import_id"]
    response = client.post(base + f"/imports/{task}/files", headers={"Content-Type": "multipart/form-data; boundary=x", "Content-Length": str(documents.KNOWLEDGE_MAX_BYTES * 2)}, content=b"tiny")
    assert response.status_code == 413
    assert client.delete(base + f"/imports/{task}").status_code == 200
    assert client.get(base).json()["documents"] == []


def test_delete_callback_clears_selected_project_before_removal_and_failure_preserves_it(client, monkeypatch):
    project = client.post("/api/knowledge/projects", json={"name": "selection"}).json()["project"]
    called = []
    def clear(project_id):
        called.append(project_id)
        assert store.project_detail(project_id)["project"]["id"] == project_id
    monkeypatch.setattr(api, "on_project_deleted", clear)
    assert client.delete(f"/api/knowledge/projects/{project['id']}").status_code == 200
    assert called == [project["id"]]
    project = client.post("/api/knowledge/projects", json={"name": "failure"}).json()["project"]
    def fail(_project_id):
        raise OSError("/Users/private/path should not leak")
    monkeypatch.setattr(api, "on_project_deleted", fail)
    response = client.delete(f"/api/knowledge/projects/{project['id']}")
    assert response.status_code == 503 and "/Users" not in response.text
    assert store.project_detail(project["id"])
