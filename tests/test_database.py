from __future__ import annotations

import builtins
import sqlite3
from pathlib import Path

import pytest

from libs.common.config import get_settings
from libs.common.database import (
    _translate_postgres_query,
    connect,
    get_database_target,
    init_db,
    loads,
)


def test_database_target_detects_sqlite() -> None:
    target = get_database_target("sqlite:///data/demo.db")

    assert target.dialect == "sqlite"
    assert str(target.path) == "data/demo.db"


def test_database_target_detects_postgres() -> None:
    target = get_database_target("postgresql://user:pass@localhost:5432/app")

    assert target.dialect == "postgresql"
    assert target.path is None


def test_database_target_rejects_unknown_dialect() -> None:
    with pytest.raises(ValueError, match="unsupported DATABASE_URL dialect"):
        get_database_target("mysql://localhost/app")


def test_runtime_postgres_connection_requires_optional_dependency(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/app")
    get_settings.cache_clear()
    real_import = builtins.__import__

    def fake_import(name, globals_=None, locals_=None, fromlist=(), level=0):
        if name == "psycopg" or name.startswith("psycopg."):
            raise ImportError("blocked in test")
        return real_import(name, globals_, locals_, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(RuntimeError, match="optional postgres dependencies"):
        with connect():
            pass


def test_postgres_query_translation_handles_params_and_upserts() -> None:
    query = """
        INSERT OR REPLACE INTO scores
        (interview_id, dimensions, total_score, risk_notes, recommendation, payload)
        VALUES (?, ?, ?, ?, ?, ?)
    """

    translated = _translate_postgres_query(query)

    assert "INSERT INTO scores" in translated
    assert translated.count("%s") == 6
    assert "ON CONFLICT (interview_id) DO UPDATE SET" in translated
    assert "payload = EXCLUDED.payload" in translated


def test_postgres_query_translation_preserves_pgvector_cast() -> None:
    translated = _translate_postgres_query(
        "SELECT * FROM probe_patterns ORDER BY embedding_vector <=> ?::vector LIMIT ?"
    )

    assert "embedding_vector <=> %s::vector" in translated
    assert translated.endswith("LIMIT %s")


def test_consent_queries_use_parameterized_boolean_comparison() -> None:
    source = Path("services/interview_orchestrator/service.py").read_text(encoding="utf-8")

    assert "granted = 1" not in source
    assert "granted = ?" in source


def test_sqlite_interviews_enforce_status_timestamp_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'state-contract.db'}")
    get_settings.cache_clear()
    init_db()

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO interviews
            (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "interview-valid",
                "job-1",
                "candidate-1",
                "IN_PROGRESS",
                "{}",
                0,
                "2026-06-02T10:00:00+00:00",
                "2026-06-02T10:00:00+00:00",
                None,
            ),
        )
        invalid_rows = [
            ("interview-bad-status", "ARCHIVED", None, None),
            ("interview-created-started", "CREATED", "2026-06-02T10:00:00+00:00", None),
            ("interview-progress-ended", "IN_PROGRESS", "2026-06-02T10:00:00+00:00", "2026-06-02T10:30:00+00:00"),
            ("interview-finished-open", "FINISHED", "2026-06-02T10:00:00+00:00", None),
            ("interview-backwards", "FINISHED", "2026-06-02T10:30:00+00:00", "2026-06-02T10:00:00+00:00"),
        ]
        for interview_id, status, started_at, ended_at in invalid_rows:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO interviews
                    (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        interview_id,
                        "job-1",
                        "candidate-1",
                        status,
                        "{}",
                        0,
                        "2026-06-02T10:00:00+00:00",
                        started_at,
                        ended_at,
                    ),
                )
        for signal_enabled in (None, 2):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO interviews
                    (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"interview-bad-signal-{signal_enabled}",
                        "job-1",
                        "candidate-1",
                        "IN_PROGRESS",
                        "{}",
                        signal_enabled,
                        "2026-06-02T10:00:00+00:00",
                        "2026-06-02T10:00:00+00:00",
                        None,
                    ),
                )


def test_sqlite_text_tables_enforce_nonblank_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'text-contract.db'}")
    get_settings.cache_clear()
    init_db()

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, title, jd_text, competency_model, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("job-valid", "Backend", None, "{}", "2026-06-02T10:00:00+00:00"),
        )
        conn.execute(
            """
            INSERT INTO candidates (id, name, resume_text, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("candidate-valid", None, "", "2026-06-02T10:00:00+00:00"),
        )
        conn.execute(
            """
            INSERT INTO probe_patterns (id, job_id, competency, pattern, embedding, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "pattern-valid",
                "job-valid",
                "项目真实性",
                "请追问本人负责部分。",
                "[]",
                "2026-06-02T10:00:00+00:00",
            ),
        )
        invalid_statements = [
            (
                "INSERT INTO jobs (id, title, jd_text, competency_model, created_at) VALUES (?, ?, ?, ?, ?)",
                ("job-blank-title", " ", "Python", "{}", "2026-06-02T10:00:00+00:00"),
            ),
            (
                "INSERT INTO jobs (id, title, jd_text, competency_model, created_at) VALUES (?, ?, ?, ?, ?)",
                ("job-blank-jd", "Backend", " ", "{}", "2026-06-02T10:00:00+00:00"),
            ),
            (
                "INSERT INTO candidates (id, name, resume_text, created_at) VALUES (?, ?, ?, ?)",
                ("candidate-blank-name", " ", "", "2026-06-02T10:00:00+00:00"),
            ),
            (
                "INSERT INTO probe_patterns (id, job_id, competency, pattern, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("pattern-blank-competency", "job-valid", " ", "请追问。", "[]", "2026-06-02T10:00:00+00:00"),
            ),
            (
                "INSERT INTO probe_patterns (id, job_id, competency, pattern, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("pattern-blank-text", "job-valid", "项目真实性", " ", "[]", "2026-06-02T10:00:00+00:00"),
            ),
        ]
        for statement, params in invalid_statements:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(statement, params)


def test_sqlite_json_columns_enforce_valid_json(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'json-contract.db'}")
    get_settings.cache_clear()
    init_db()

    invalid_statements = [
        (
            "INSERT INTO jobs (id, title, jd_text, competency_model, created_at) VALUES (?, ?, ?, ?, ?)",
            ("job-invalid-json", "Backend", "Python", "not-json", "2026-06-02T10:00:00+00:00"),
        ),
        (
            "INSERT INTO jobs (id, title, jd_text, competency_model, created_at) VALUES (?, ?, ?, ?, ?)",
            ("job-array-model", "Backend", "Python", "[]", "2026-06-02T10:00:00+00:00"),
        ),
        (
            """
            INSERT INTO interviews
            (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "interview-invalid-json",
                "job-1",
                "candidate-1",
                "CREATED",
                "not-json",
                0,
                "2026-06-02T10:00:00+00:00",
                None,
                None,
            ),
        ),
        (
            """
            INSERT INTO interviews
            (id, job_id, candidate_id, status, context, signal_enabled, created_at, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "interview-array-context",
                "job-1",
                "candidate-1",
                "CREATED",
                "[]",
                0,
                "2026-06-02T10:00:00+00:00",
                None,
                None,
            ),
        ),
        (
            """
            INSERT INTO qa_turns
            (id, interview_id, turn_index, question, question_source, answer,
             answer_start_ms, answer_end_ms, probe_target, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "turn-invalid-json",
                "interview-1",
                0,
                "q",
                "interviewer",
                "a",
                0,
                10,
                None,
                "not-json",
            ),
        ),
        (
            """
            INSERT INTO qa_turns
            (id, interview_id, turn_index, question, question_source, answer,
             answer_start_ms, answer_end_ms, probe_target, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "turn-array-payload",
                "interview-1",
                0,
                "q",
                "interviewer",
                "a",
                0,
                10,
                None,
                "[]",
            ),
        ),
        (
            "INSERT INTO probe_patterns (id, job_id, competency, pattern, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                "pattern-invalid-json",
                "job-1",
                "项目真实性",
                "请追问本人负责部分。",
                "not-json",
                "2026-06-02T10:00:00+00:00",
            ),
        ),
        (
            "INSERT INTO probe_patterns (id, job_id, competency, pattern, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                "pattern-object-embedding",
                "job-1",
                "项目真实性",
                "请追问本人负责部分。",
                "{}",
                "2026-06-02T10:00:00+00:00",
            ),
        ),
        (
            """
            INSERT INTO scores
            (interview_id, dimensions, total_score, risk_notes, recommendation, payload)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "score-invalid-payload",
                '[{"dimension":"项目真实性"}]',
                80.0,
                "[]",
                "yes",
                "not-json",
            ),
        ),
        (
            """
            INSERT INTO scores
            (interview_id, dimensions, total_score, risk_notes, recommendation, payload)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "score-array-payload",
                '[{"dimension":"项目真实性"}]',
                80.0,
                "[]",
                "yes",
                "[]",
            ),
        ),
        (
            """
            INSERT INTO aigc_results
            (id, interview_id, turn_id, ai_generated_prob, template_similarity,
             matched_template, flagged, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "aigc-invalid-payload",
                "interview-1",
                "turn-1",
                0.2,
                0.4,
                None,
                0,
                "not-json",
            ),
        ),
        (
            """
            INSERT INTO aigc_results
            (id, interview_id, turn_id, ai_generated_prob, template_similarity,
             matched_template, flagged, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "aigc-array-payload",
                "interview-1",
                "turn-1",
                0.2,
                0.4,
                None,
                0,
                "[]",
            ),
        ),
        (
            "INSERT INTO reports (interview_id, payload, html) VALUES (?, ?, ?)",
            ("report-invalid-json", "not-json", "<html>报告</html>"),
        ),
        (
            "INSERT INTO reports (interview_id, payload, html) VALUES (?, ?, ?)",
            ("report-array-payload", "[]", "<html>报告</html>"),
        ),
    ]
    with connect() as conn:
        for statement, params in invalid_statements:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(statement, params)


def test_sqlite_consents_enforce_core_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'consent-contract.db'}")
    get_settings.cache_clear()
    init_db()

    def insert_consent(
        consent_id: str,
        candidate_id: str,
        consent_type: str,
        granted: int,
        granted_at: str,
        revoked_at: str | None,
    ) -> None:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO consents
                (id, candidate_id, consent_type, granted, granted_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    consent_id,
                    candidate_id,
                    consent_type,
                    granted,
                    granted_at,
                    revoked_at,
                ),
            )

    insert_consent(
        "consent-valid",
        "candidate-1",
        "behavior_signal",
        1,
        "2026-06-02T10:00:00+00:00",
        None,
    )

    invalid_rows = [
        ("consent-blank-candidate", " ", "behavior_signal", 1, "2026-06-02T10:00:00+00:00", None),
        ("consent-bad-type", "candidate-1", "face_scan", 1, "2026-06-02T10:00:00+00:00", None),
        ("consent-bad-granted", "candidate-1", "behavior_signal", 2, "2026-06-02T10:00:00+00:00", None),
        (
            "consent-backwards-revoke",
            "candidate-1",
            "behavior_signal",
            0,
            "2026-06-02T10:00:00+00:00",
            "2026-06-02T09:59:59+00:00",
        ),
    ]
    for row in invalid_rows:
        with pytest.raises(sqlite3.IntegrityError):
            insert_consent(*row)


def test_sqlite_qa_turns_enforce_core_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'turn-contract.db'}")
    get_settings.cache_clear()
    init_db()

    def insert_turn(
        turn_id: str,
        turn_index: int,
        question: str,
        question_source: str,
        answer: str,
        answer_start_ms: int,
        answer_end_ms: int,
        probe_target: str | None = None,
        asked_option_id: str | None = None,
        question_origin: str | None = None,
    ) -> None:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO qa_turns
                (id, interview_id, turn_index, question, question_source, answer,
                 answer_start_ms, answer_end_ms, probe_target, asked_option_id,
                 question_origin, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    turn_id,
                    "interview-1",
                    turn_index,
                    question,
                    question_source,
                    answer,
                    answer_start_ms,
                    answer_end_ms,
                    probe_target,
                    asked_option_id,
                    question_origin,
                    "{}",
                ),
            )

    insert_turn("turn-valid", 0, "q", "interviewer", "a", 10, 20)
    insert_turn(
        "turn-valid-origin",
        1,
        "q",
        "interviewer",
        "a",
        10,
        20,
        None,
        "option-1",
        "system_suggested",
    )

    invalid_rows = [
        ("turn-negative-index", -1, "q", "interviewer", "a", 10, 20, None, None, None),
        ("turn-blank-question", 2, " ", "interviewer", "a", 10, 20, None, None, None),
        ("turn-bad-source", 2, "q", "candidate", "a", 10, 20, None, None, None),
        ("turn-blank-answer", 2, "q", "interviewer", " ", 10, 20, None, None, None),
        ("turn-negative-start", 2, "q", "interviewer", "a", -1, 20, None, None, None),
        ("turn-backwards", 2, "q", "interviewer", "a", 20, 10, None, None, None),
        ("turn-blank-target", 2, "q", "ai_probe", "a", 10, 20, " ", None, None),
        ("turn-blank-option", 2, "q", "interviewer", "a", 10, 20, None, " ", None),
        ("turn-bad-origin", 2, "q", "interviewer", "a", 10, 20, None, None, "manual"),
        ("turn-duplicate-index", 0, "q", "interviewer", "a", 10, 20, None, None, None),
    ]
    for row in invalid_rows:
        with pytest.raises(sqlite3.IntegrityError):
            insert_turn(*row)


def test_sqlite_aigc_results_enforce_core_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'aigc-contract.db'}")
    get_settings.cache_clear()
    init_db()

    def insert_aigc(
        result_id: str,
        ai_generated_prob: float,
        template_similarity: float,
        matched_template: str | None,
        flagged: int | None = 0,
    ) -> None:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO aigc_results
                (id, interview_id, turn_id, ai_generated_prob, template_similarity,
                 matched_template, flagged, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result_id,
                    "interview-1",
                    "turn-1",
                    ai_generated_prob,
                    template_similarity,
                    matched_template,
                    flagged,
                    "{}",
                ),
            )

    insert_aigc("aigc-valid", 0.2, 0.4, None)

    invalid_rows = [
        ("aigc-negative-prob", -0.1, 0.4, None, 0),
        ("aigc-high-prob", 1.1, 0.4, None, 0),
        ("aigc-negative-template", 0.2, -0.1, None, 0),
        ("aigc-high-template", 0.2, 1.1, None, 0),
        ("aigc-blank-template", 0.2, 0.4, " ", 0),
        ("aigc-bad-flag", 0.2, 0.4, None, 2),
        ("aigc-null-flag", 0.2, 0.4, None, None),
    ]
    for row in invalid_rows:
        with pytest.raises(sqlite3.IntegrityError):
            insert_aigc(*row)


def test_sqlite_scores_enforce_core_contract(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'score-contract.db'}")
    get_settings.cache_clear()
    init_db()

    def insert_score(
        interview_id: str,
        dimensions: str,
        total_score: float,
        risk_notes: str,
        recommendation: str,
    ) -> None:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO scores
                (interview_id, dimensions, total_score, risk_notes, recommendation, payload)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    interview_id,
                    dimensions,
                    total_score,
                    risk_notes,
                    recommendation,
                    "{}",
                ),
            )

    insert_score("interview-valid", '[{"dimension":"项目真实性"}]', 80.0, "[]", "yes")

    invalid_rows = [
        ("score-empty-dimensions", "[]", 80.0, "[]", "yes"),
        ("score-object-dimensions", "{}", 80.0, "[]", "yes"),
        ("score-invalid-dimensions", "not-json", 80.0, "[]", "yes"),
        ("score-negative-total", '[{"dimension":"项目真实性"}]', -0.1, "[]", "yes"),
        ("score-high-total", '[{"dimension":"项目真实性"}]', 100.1, "[]", "yes"),
        ("score-object-risk", '[{"dimension":"项目真实性"}]', 80.0, "{}", "yes"),
        ("score-invalid-risk", '[{"dimension":"项目真实性"}]', 80.0, "not-json", "yes"),
        ("score-invalid-recommendation", '[{"dimension":"项目真实性"}]', 80.0, "[]", "maybe"),
    ]
    for row in invalid_rows:
        with pytest.raises(sqlite3.IntegrityError):
            insert_score(*row)


def test_sqlite_reports_enforce_nonblank_html(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'report-contract.db'}")
    get_settings.cache_clear()
    init_db()

    with connect() as conn:
        conn.execute(
            "INSERT INTO reports (interview_id, payload, html) VALUES (?, ?, ?)",
            ("interview-valid", "{}", "<html>报告</html>"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO reports (interview_id, payload, html) VALUES (?, ?, ?)",
                ("interview-blank", "{}", " "),
            )


def test_loads_accepts_postgres_json_values() -> None:
    payload = {"score": 88}

    assert loads(payload) == payload


def test_sqlite_init_migrates_existing_score_columns(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'old.db'}")
    get_settings.cache_clear()
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE scores (
                interview_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE aigc_results (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            """
        )

    init_db()

    with connect() as conn:
        score_columns = {row["name"] for row in conn.execute("PRAGMA table_info(scores)").fetchall()}
        aigc_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(aigc_results)").fetchall()
        }
        probe_pattern_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(probe_patterns)").fetchall()
        }

    assert {"dimensions", "total_score", "risk_notes", "recommendation"} <= score_columns
    assert {"ai_generated_prob", "template_similarity", "matched_template", "flagged"} <= aigc_columns
    assert {"job_id", "competency", "pattern", "embedding"} <= probe_pattern_columns


def test_sqlite_init_migrates_realtime_columns_and_legacy_turns(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'old-realtime.db'}")
    get_settings.cache_clear()
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE interviews (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                candidate_id TEXT NOT NULL,
                status TEXT NOT NULL,
                context TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT
            );
            INSERT INTO interviews
            (id, job_id, candidate_id, status, context, created_at, started_at, ended_at)
            VALUES
            ('interview-legacy', 'job-1', 'candidate-1', 'CREATED', '{}',
             '2026-06-02T10:00:00+00:00', NULL, NULL);
            CREATE TABLE qa_turns (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                turn_index INTEGER NOT NULL,
                question TEXT NOT NULL,
                question_source TEXT NOT NULL,
                answer TEXT NOT NULL,
                answer_start_ms INTEGER NOT NULL,
                answer_end_ms INTEGER NOT NULL,
                probe_target TEXT
            );
            INSERT INTO qa_turns
            (id, interview_id, turn_index, question, question_source, answer,
             answer_start_ms, answer_end_ms, probe_target)
            VALUES
            ('turn-1', 'interview-1', 0, 'q', 'interviewer', 'a', 10, 20, NULL);
            """
        )

    init_db()

    from services.interview_orchestrator.service import list_turns

    with connect() as conn:
        interview_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(interviews)").fetchall()
        }
        interview_row = conn.execute(
            "SELECT signal_enabled FROM interviews WHERE id = ?",
            ("interview-legacy",),
        ).fetchone()
        turn_columns = {row["name"] for row in conn.execute("PRAGMA table_info(qa_turns)").fetchall()}
    turns = list_turns("interview-1")

    assert "signal_enabled" in interview_columns
    assert interview_row["signal_enabled"] == 0
    assert "payload" in turn_columns
    assert "asked_option_id" in turn_columns
    assert "question_origin" in turn_columns
    assert turns[0].turn_id == "turn-1"
    assert turns[0].answer_start_ms == 10


def test_sqlite_memory_tables_enforce_their_contracts(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'memory-contract.db'}")
    get_settings.cache_clear()
    init_db()

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO project_memories
            (id, repo_path, repo_name, topic, fact, evidence, embedding, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("p1", "/repo/a", "a", "技术栈", "Python 为主", "git ls-files", "[0.1]", "2026-06-02"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO project_memories
                (id, repo_path, repo_name, topic, fact, evidence, embedding, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("p2", "/repo/a", "a", "技术栈", "重复主题", "", "[0.1]", "2026-06-02"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO project_memories
                (id, repo_path, repo_name, topic, fact, evidence, embedding, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("p3", "/repo/b", "b", "  ", "空主题", "", "[0.1]", "2026-06-02"),
            )

        conn.execute(
            """
            INSERT INTO interview_memories
            (id, kind, subject_key, candidate_id, job_id, summary, detail,
             embedding, source_interview_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("m1", "candidate_profile", "c1", "c1", None, "画像", "", "[0.1]", "i1", "2026-06-02"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO interview_memories
                (id, kind, subject_key, candidate_id, job_id, summary, detail,
                 embedding, source_interview_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("m2", "gossip", "c1", "c1", None, "画像", "", "[0.1]", "i2", "2026-06-02"),
            )


def test_sqlite_consents_accept_long_term_memory(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'consent-memory.db'}")
    get_settings.cache_clear()
    init_db()

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO consents (id, candidate_id, consent_type, granted, granted_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("c1", "candidate-1", "long_term_memory", 1, "2026-06-02T10:00:00+00:00"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                INSERT INTO consents (id, candidate_id, consent_type, granted, granted_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                ("c2", "candidate-1", "marketing", 1, "2026-06-02T10:00:00+00:00"),
            )
