import json
import sqlite3
import pytest

from libs.common.config import get_settings
from services.chat_service import knowledge


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'gateway.db'}")
    get_settings.cache_clear()
    path = tmp_path / "learning_assets.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE assets(kind TEXT, id TEXT, payload TEXT, deleted INTEGER DEFAULT 0, PRIMARY KEY(kind,id))")

    def put(item, *, kind="knowledge", deleted=0):
        with sqlite3.connect(path) as connection:
            connection.execute("INSERT OR REPLACE INTO assets(kind,id,payload,deleted) VALUES (?,?,?,?)", (kind, item["id"], json.dumps(item), deleted))

    return path, put


def item(record_id="redis", question="Redis 缓存雪崩怎么处理？", answer="缓存雪崩可用随机过期时间和限流降低影响。", **extra):
    return {"id": record_id, "question": question, "answer": answer, "tags": ["Redis", "缓存"], "sourceSessionId": "source-1", **extra}


def ids(hits):
    return [hit["id"] for hit in hits]


def characters(hits):
    return sum(len(hit["question"]) + len(hit["answer"]) + sum(map(len, hit["tags"])) for hit in hits)


def test_missing_database_does_not_create_database_or_parent_directory(tmp_path, monkeypatch):
    directory = tmp_path / "missing"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{directory / 'gateway.db'}")
    get_settings.cache_clear()
    assert knowledge.retrieve_knowledge("Redis 缓存") == []
    assert not directory.exists()


@pytest.mark.parametrize("content", [b"not sqlite", None])
def test_corrupt_or_schema_less_database_is_a_no_hit(tmp_path, monkeypatch, content):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'gateway.db'}")
    get_settings.cache_clear()
    path = tmp_path / "learning_assets.sqlite3"
    if content is None:
        sqlite3.connect(path).close()
    else:
        path.write_bytes(content)
    before = path.read_bytes()
    assert knowledge.retrieve_knowledge("Redis") == []
    assert path.read_bytes() == before


def test_retrieval_only_reads_live_knowledge_rows(store):
    path, put = store
    put(item())
    put(item("deleted"), deleted=1)
    put(item("other-kind"), kind="sessions")
    before = path.read_bytes()
    hits = knowledge.retrieve_knowledge("Redis 缓存雪崩")
    assert ids(hits) == ["redis"]
    assert path.read_bytes() == before
    assert set(hits[0]) == {"id", "question", "answer", "tags", "sourceSessionId"}


def test_chinese_and_english_technical_queries_retrieve_related_answers(store):
    _path, put = store
    put(item("cache", question="如何避免缓存雪崩？", tags=["缓存"], answer="随机过期时间可以避免大量缓存同时失效。"))
    put(item("postgres", question="PostgreSQL index scan", tags=["PostgreSQL"], answer="Use EXPLAIN ANALYZE to inspect the index scan."))
    put(item("frontend", question="浏览器布局", tags=["CSS"], answer="CSS 影响页面布局。"))
    assert ids(knowledge.retrieve_knowledge("请介绍一下缓存雪崩")) == ["cache"]
    assert ids(knowledge.retrieve_knowledge("How does a PostgreSQL index scan work?")) == ["postgres"]


@pytest.mark.parametrize("query", ["请介绍一下", "为什么", "how please explain", "…?! ", "", "可以说一下这个问题吗"])
def test_generic_queries_do_not_attach_unrelated_material(store, query):
    _path, put = store
    put(item(question="请介绍一下项目", answer="为什么要说明这个问题？"))
    assert knowledge.retrieve_knowledge(query) == []


def test_unrelated_chinese_queries_do_not_match_one_shared_bigram(store):
    _path, put = store
    put(item("redis", question="缓存穿透和空值缓存", answer="缓存未命中时读取数据库。", tags=[]))
    assert knowledge.retrieve_knowledge("缓存雪崩如何处理") == []


@pytest.mark.parametrize(("query", "wanted", "unwanted"), [
    ("Redis", "Redis", "Redisson"),
    ("SQL", "SQL", "NoSQL"),
    ("Java", "Java", "JavaScript"),
    ("C++", "C++", "C"),
    ("C#", "C#", "C++"),
])
def test_english_technical_tokens_match_exactly(store, query, wanted, unwanted):
    _path, put = store
    put(item("match", question=f"{wanted} design", answer=f"Use {wanted} safely.", tags=[]))
    put(item("other", question=f"{unwanted} design", answer=f"Use {unwanted} safely.", tags=[]))
    assert ids(knowledge.retrieve_knowledge(query)) == ["match"]


def test_a_specific_technical_identifier_in_a_long_question_is_still_recalled(store):
    _path, put = store
    put(item())
    assert ids(knowledge.retrieve_knowledge("请结合实际项目介绍 Redis 的生产使用经验和排障方法")) == ["redis"]
    assert ids(knowledge.retrieve_knowledge("What is the difference between Redis and Redisson?")) == ["redis"]


def test_question_and_tags_rank_ahead_of_an_incidental_answer_match(store):
    _path, put = store
    put(item("question", question="Redis eviction policies", answer="Choose an eviction policy.", tags=[]))
    put(item("tags", question="Cache eviction policies", answer="Choose an eviction policy.", tags=["Redis"]))
    put(item("answer", question="General storage systems", answer="An example is Redis.", tags=[]))
    hits = knowledge.retrieve_knowledge("Redis")
    assert ids(hits)[-1] == "answer"
    assert set(ids(hits)[:2]) == {"question", "tags"}


def test_limit_is_hard_capped_and_equal_scores_have_stable_id_order(store):
    _path, put = store
    for record_id, word in reversed(list(zip(["a", "b", "c", "d"], ["alpha", "bravo", "charlie", "delta"], strict=True))):
        put(item(record_id, question=f"Redis {word}", answer=f"Redis reference {word}", tags=[]))
    assert ids(knowledge.retrieve_knowledge("Redis", limit=20)) == ["a", "b", "c"]
    assert ids(knowledge.retrieve_knowledge("Redis", limit=1)) == ["a"]
    assert knowledge.retrieve_knowledge("Redis", limit=0) == []


def test_duplicate_content_is_deduplicated_without_merging_sources(store):
    _path, put = store
    put(item("b", question="Redis eviction!", answer="Use LRU.", sourceSessionId="source-b"))
    put(item("a", question="REDIS EVICTION", answer="Use LRU", sourceSessionId="source-a"))
    hits = knowledge.retrieve_knowledge("Redis eviction")
    assert ids(hits) == ["a"]
    assert hits[0]["sourceSessionId"] == "source-a"


@pytest.mark.parametrize("budget", [2, 10, 60, 400, 6000, 100000])
def test_whole_snippet_budget_includes_questions_answers_and_tags(store, budget):
    _path, put = store
    for index in range(5):
        put(item(str(index), question=f"Redis cache {index} " * 100, answer=f"Redis cache answer {index} " * 300, tags=["Redis", "缓存", "缓存设计"] * 4))
    hits = knowledge.retrieve_knowledge("Redis cache", max_chars=budget, limit=20)
    assert hits
    assert len(hits) <= 3
    assert characters(hits) <= min(6000, budget)
    assert all(hit["question"] and hit["answer"] for hit in hits)


@pytest.mark.parametrize("budget", [0, 1, -100])
def test_empty_budgets_never_read_the_database(monkeypatch, budget):
    monkeypatch.setattr(knowledge, "_documents", lambda _exclude: pytest.fail("Database should not be read"))
    assert knowledge.retrieve_knowledge("Redis", max_chars=budget) == []


def test_excerpt_keeps_relevant_tail_instead_of_only_the_first_characters(store):
    _path, put = store
    put(item(question="Storage troubleshooting", answer="Unrelated introductory material. " * 1000 + "Redis eviction policy uses LRU. " + "More unrelated material. " * 100, tags=[]))
    hit = knowledge.retrieve_knowledge("Redis eviction policy", max_chars=500)[0]
    assert "Redis eviction policy uses LRU" in hit["answer"]
    assert hit["answer"].startswith("…")
    assert characters([hit]) <= 500


def test_chinese_excerpt_keeps_the_matching_section(store):
    _path, put = store
    put(item(question="服务排障总结", answer="历史记录。" * 2000 + "缓存雪崩需要避免集中失效。" + "补充资料。" * 500, tags=[]))
    hit = knowledge.retrieve_knowledge("缓存雪崩", max_chars=200)[0]
    assert "缓存雪崩需要避免集中失效" in hit["answer"]
    assert characters([hit]) <= 200


@pytest.mark.parametrize("patch", [
    {"question": None}, {"answer": 42}, {"question": ""}, {"answer": " "},
    {"tags": "Redis"}, {"tags": [42]}, {"tags": ["x" * 121]},
    {"sourceSessionId": {"id": "bad"}}, {"sourceSessionId": "x" * 201},
    {"question": "x" * 10001}, {"answer": "x" * 100001},
    {"partial": True}, {"answer_partial": True},
])
def test_malformed_oversized_or_partial_items_are_skipped(store, patch):
    _path, put = store
    put(item(**patch))
    assert knowledge.retrieve_knowledge("Redis") == []


def test_invalid_json_and_payload_id_mismatch_are_skipped(store):
    path, put = store
    with sqlite3.connect(path) as connection:
        connection.execute("INSERT INTO assets VALUES (?,?,?,0)", ("knowledge", "bad-json", "{"))
        connection.execute("INSERT INTO assets VALUES (?,?,?,0)", ("knowledge", "different-id", json.dumps(item())))
        connection.execute("INSERT INTO assets VALUES (?,?,?,0)", ("knowledge", "list", "[]"))
    assert knowledge.retrieve_knowledge("Redis") == []


def test_model_generated_answers_are_reference_candidates_not_assumed_verified(store):
    _path, put = store
    put(item(verified=False, answerOrigin="model"))
    assert ids(knowledge.retrieve_knowledge("Redis")) == ["redis"]


def test_current_source_session_can_be_excluded(store):
    _path, put = store
    put(item(sourceSessionId="this-session"))
    assert knowledge.retrieve_knowledge("Redis", exclude_session_id="this-session") == []
    assert ids(knowledge.retrieve_knowledge("Redis", exclude_session_id="another-session")) == ["redis"]


@pytest.mark.parametrize("marked", ["record", "question", "answer"])
def test_legacy_import_from_a_partial_source_session_is_not_retrieved(store, marked):
    _path, put = store
    record = {"id": "source-1", "turns": [{"role": "user", "text": "Redis 缓存雪崩怎么处理？"}, {"role": "assistant", "text": "缓存雪崩可用随机过期时间和限流降低影响。"}]}
    if marked == "record":
        record["partial"] = True
    else:
        record["turns"][0 if marked == "question" else 1]["partial"] = True
    put(record, kind="sessions")
    put(item())
    assert knowledge.retrieve_knowledge("Redis 缓存雪崩") == []


def test_a_different_partial_answer_in_the_same_session_does_not_suppress_a_complete_hit(store):
    _path, put = store
    put({"id": "source-1", "turns": [
        {"role": "user", "text": "Different question"}, {"role": "assistant", "text": "Different answer", "partial": True},
        {"role": "user", "text": "Redis 缓存雪崩怎么处理？"}, {"role": "assistant", "text": "缓存雪崩可用随机过期时间和限流降低影响。"},
    ]}, kind="sessions")
    put(item())
    assert ids(knowledge.retrieve_knowledge("Redis 缓存雪崩")) == ["redis"]


def test_returned_results_do_not_mutate_storage_or_reuse_shared_dicts(store):
    _path, put = store
    put(item())
    hit = knowledge.retrieve_knowledge("Redis")[0]
    hit["answer"] = "changed"
    hit["tags"].append("changed")
    again = knowledge.retrieve_knowledge("Redis")[0]
    assert again["answer"] != "changed"
    assert "changed" not in again["tags"]


def test_database_uri_handles_question_marks_and_hashes(tmp_path, monkeypatch):
    directory = tmp_path / "path?# with spaces"
    directory.mkdir()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{directory / 'gateway.db'}")
    get_settings.cache_clear()
    path = directory / "learning_assets.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE assets(kind TEXT,id TEXT,payload TEXT,deleted INTEGER)")
        connection.execute("INSERT INTO assets VALUES (?,?,?,0)", ("knowledge", "redis", json.dumps(item())))
    assert ids(knowledge.retrieve_knowledge("Redis")) == ["redis"]


def test_programming_errors_are_not_converted_to_empty_results(monkeypatch):
    def broken_path():
        raise RuntimeError("unexpected bug")
    monkeypatch.setattr(knowledge, "_database_path", broken_path)
    with pytest.raises(RuntimeError, match="unexpected bug"):
        knowledge.retrieve_knowledge("Redis")
