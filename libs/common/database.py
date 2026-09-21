from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence

from libs.common.config import get_settings


@dataclass(frozen=True)
class DatabaseTarget:
    dialect: str
    url: str
    path: Path | None = None


def get_database_target(url: str | None = None) -> DatabaseTarget:
    resolved = get_settings().database_url if url is None else url
    if resolved.startswith("sqlite:///"):
        return DatabaseTarget(
            dialect="sqlite",
            url=resolved,
            path=Path(resolved.replace("sqlite:///", "", 1)),
        )
    if resolved.startswith(("postgresql://", "postgres://")):
        return DatabaseTarget(dialect="postgresql", url=resolved)
    raise ValueError(f"unsupported DATABASE_URL dialect: {resolved}")


def _sqlite_path() -> Path:
    target = get_database_target()
    if target.dialect != "sqlite" or target.path is None:
        raise ValueError("runtime persistence currently supports sqlite:/// DATABASE_URL values")
    path = target.path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


_POSTGRES_UPSERT_KEYS = {
    "utterances": "id",
    "probe_chains": "id",
    "qa_turns": "id",
    "scores": "interview_id",
    "aigc_results": "id",
    "reports": "interview_id",
}

_POSTGRES_JSON_COLUMNS = {
    ("jobs", "competency_model"),
    ("interviews", "context"),
    ("utterances", "payload"),
    ("probe_chains", "payload"),
    ("qa_turns", "payload"),
    ("scores", "dimensions"),
    ("scores", "risk_notes"),
    ("scores", "payload"),
    ("aigc_results", "payload"),
    ("probe_patterns", "embedding"),
    ("reports", "payload"),
}


def _translate_postgres_query(query: str) -> str:
    query = _translate_sqlite_upsert(query)
    return query.replace("?", "%s")


def _translate_sqlite_upsert(query: str) -> str:
    match = re.search(
        r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
        query,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return query
    table = match.group(1)
    conflict_column = _POSTGRES_UPSERT_KEYS.get(table)
    if not conflict_column:
        return query
    columns = [column.strip() for column in match.group(2).split(",")]
    assignments = [
        f"{column} = EXCLUDED.{column}" for column in columns if column != conflict_column
    ]
    if not assignments:
        conflict = f"ON CONFLICT ({conflict_column}) DO NOTHING"
    else:
        conflict = f"ON CONFLICT ({conflict_column}) DO UPDATE SET {', '.join(assignments)}"
    return f"INSERT INTO {table} ({match.group(2)}) VALUES ({match.group(3)}) {conflict}"


def _json_columns_for_insert(query: str) -> list[tuple[int, str]]:
    match = re.search(
        r"INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+(\w+)\s*\(([^)]+)\)",
        query,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return []
    table = match.group(1)
    columns = [column.strip() for column in match.group(2).split(",")]
    return [
        (index, column)
        for index, column in enumerate(columns)
        if (table, column) in _POSTGRES_JSON_COLUMNS
    ]


def _json_param_indexes_for_update(query: str) -> list[int]:
    match = re.search(r"UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+", query, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return []
    table = match.group(1)
    assignments = [assignment.strip() for assignment in match.group(2).split(",")]
    indexes: list[int] = []
    param_index = 0
    for assignment in assignments:
        column = assignment.split("=", 1)[0].strip()
        if "?" in assignment or "%s" in assignment:
            if (table, column) in _POSTGRES_JSON_COLUMNS:
                indexes.append(param_index)
            param_index += assignment.count("?") + assignment.count("%s")
    return indexes


def _adapt_postgres_params(query: str, params: Sequence[Any] | None) -> Sequence[Any] | None:
    if params is None:
        return None
    indexes = {index for index, _ in _json_columns_for_insert(query)}
    indexes.update(_json_param_indexes_for_update(query))
    if not indexes:
        return params
    from psycopg.types.json import Jsonb

    adapted: list[Any] = list(params)
    for index in indexes:
        if index >= len(adapted):
            continue
        value = adapted[index]
        if isinstance(value, str):
            value = loads(value)
        adapted[index] = Jsonb(value)
    return tuple(adapted)


class PostgresConnection:
    def __init__(self, raw: Any) -> None:
        self.raw = raw

    def execute(self, query: str, params: Sequence[Any] | None = None) -> Any:
        translated = _translate_postgres_query(query)
        adapted = _adapt_postgres_params(query, params)
        return self.raw.execute(translated, adapted)

    def executescript(self, script: str) -> None:
        for statement in script.split(";"):
            if statement.strip():
                self.raw.execute(statement)

    def commit(self) -> None:
        self.raw.commit()

    def close(self) -> None:
        self.raw.close()


@contextmanager
def connect() -> Iterator[Any]:
    target = get_database_target()
    if target.dialect == "postgresql":
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError(
                "PostgreSQL DATABASE_URL requires the optional postgres dependencies. "
                "Install with `pip install -e .[postgres]`."
            ) from exc
        conn = PostgresConnection(psycopg.connect(target.url, row_factory=dict_row))
    else:
        conn = sqlite3.connect(_sqlite_path())
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    target = get_database_target()
    with connect() as conn:
        if target.dialect == "postgresql":
            schema = Path("db/postgres/001_core_schema.sql").read_text(encoding="utf-8")
            conn.executescript(schema)
            memory_schema = Path("db/postgres/003_memory.sql").read_text(encoding="utf-8")
            conn.executescript(memory_schema)
            if get_settings().jd_vector_backend == "pgvector":
                vector_schema = Path("db/postgres/002_pgvector_probe_patterns.sql").read_text(
                    encoding="utf-8"
                )
                conn.executescript(vector_schema)
            return
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL CHECK (trim(title) <> ''),
                jd_text TEXT CHECK (jd_text IS NULL OR trim(jd_text) <> ''),
                competency_model TEXT NOT NULL CHECK (
                    json_valid(competency_model) AND json_type(competency_model) = 'object'
                ),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY,
                name TEXT CHECK (name IS NULL OR trim(name) <> ''),
                resume_text TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interviews (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                candidate_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('CREATED', 'IN_PROGRESS', 'FINISHED', 'SCORING', 'REPORTED')
                ),
                context TEXT NOT NULL CHECK (
                    json_valid(context) AND json_type(context) = 'object'
                ),
                signal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (signal_enabled IN (0, 1)),
                created_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
                CHECK (
                    (status = 'CREATED' AND started_at IS NULL AND ended_at IS NULL)
                    OR (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND ended_at IS NULL)
                    OR (
                        status IN ('FINISHED', 'SCORING', 'REPORTED')
                        AND started_at IS NOT NULL
                        AND ended_at IS NOT NULL
                    )
                )
            );
            CREATE TABLE IF NOT EXISTS qa_turns (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
                question TEXT NOT NULL CHECK (trim(question) <> ''),
                question_source TEXT NOT NULL CHECK (question_source IN ('interviewer', 'ai_probe')),
                answer TEXT NOT NULL CHECK (trim(answer) <> ''),
                answer_start_ms INTEGER NOT NULL CHECK (answer_start_ms >= 0),
                answer_end_ms INTEGER NOT NULL CHECK (answer_end_ms >= answer_start_ms),
                probe_target TEXT CHECK (probe_target IS NULL OR trim(probe_target) <> ''),
                question_utterance_id TEXT CHECK (
                    question_utterance_id IS NULL OR trim(question_utterance_id) <> ''
                ),
                answer_utterance_id TEXT CHECK (
                    answer_utterance_id IS NULL OR trim(answer_utterance_id) <> ''
                ),
                probe_chain_id TEXT CHECK (
                    probe_chain_id IS NULL OR trim(probe_chain_id) <> ''
                ),
                asked_option_id TEXT CHECK (
                    asked_option_id IS NULL OR trim(asked_option_id) <> ''
                ),
                question_origin TEXT CHECK (
                    question_origin IS NULL
                    OR question_origin IN ('system_suggested', 'interviewer_custom')
                ),
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                UNIQUE (interview_id, turn_index)
            );
            CREATE TABLE IF NOT EXISTS utterances (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                utterance_index INTEGER NOT NULL CHECK (utterance_index >= 0),
                speaker TEXT NOT NULL CHECK (speaker IN ('interviewer', 'candidate', 'unknown')),
                text TEXT NOT NULL CHECK (trim(text) <> ''),
                start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
                end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
                sentence_count INTEGER NOT NULL CHECK (sentence_count >= 1),
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                UNIQUE (interview_id, utterance_index)
            );
            CREATE TABLE IF NOT EXISTS probe_chains (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                chain_index INTEGER NOT NULL CHECK (chain_index >= 0),
                topic TEXT NOT NULL CHECK (trim(topic) <> ''),
                origin TEXT NOT NULL CHECK (
                    origin IN ('resume_claim', 'answer_claim', 'competency_gap')
                ),
                verdict TEXT NOT NULL CHECK (verdict IN ('held_up', 'cracked', 'unresolved')),
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                UNIQUE (interview_id, chain_index)
            );
            CREATE TABLE IF NOT EXISTS question_banks (
                interview_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS probe_patterns (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                competency TEXT NOT NULL CHECK (trim(competency) <> ''),
                pattern TEXT NOT NULL CHECK (trim(pattern) <> ''),
                embedding TEXT NOT NULL CHECK (
                    json_valid(embedding) AND json_type(embedding) = 'array'
                ),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scores (
                interview_id TEXT PRIMARY KEY,
                dimensions TEXT NOT NULL CHECK (
                    json_valid(dimensions)
                    AND json_type(dimensions) = 'array'
                    AND json_array_length(dimensions) > 0
                ),
                total_score REAL NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
                risk_notes TEXT NOT NULL DEFAULT '[]' CHECK (
                    json_valid(risk_notes) AND json_type(risk_notes) = 'array'
                ),
                recommendation TEXT NOT NULL CHECK (
                    recommendation IN ('strong_yes', 'yes', 'hold', 'no')
                ),
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object')
            );
            CREATE TABLE IF NOT EXISTS aigc_results (
                id TEXT PRIMARY KEY,
                interview_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                ai_generated_prob REAL NOT NULL CHECK (
                    ai_generated_prob >= 0 AND ai_generated_prob <= 1
                ),
                template_similarity REAL NOT NULL CHECK (
                    template_similarity >= 0 AND template_similarity <= 1
                ),
                matched_template TEXT CHECK (
                    matched_template IS NULL OR trim(matched_template) <> ''
                ),
                flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object')
            );
            CREATE TABLE IF NOT EXISTS reports (
                interview_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                html TEXT NOT NULL CHECK (trim(html) <> '')
            );
            CREATE TABLE IF NOT EXISTS consents (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL CHECK (trim(candidate_id) <> ''),
                consent_type TEXT NOT NULL CHECK (
                    consent_type IN ('behavior_signal', 'long_term_memory')
                ),
                granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
                granted_at TEXT NOT NULL,
                revoked_at TEXT,
                CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
            );
            """
        )
        _migrate_sqlite_consent_types(conn)
        _ensure_sqlite_columns(conn)


def _migrate_sqlite_consent_types(conn: sqlite3.Connection) -> None:
    """Widen the consents CHECK for long_term_memory on databases created before it existed."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'consents'"
    ).fetchone()
    if row is None or "long_term_memory" in (row["sql"] or ""):
        return
    conn.executescript(
        """
        ALTER TABLE consents RENAME TO consents_legacy;
        CREATE TABLE consents (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL CHECK (trim(candidate_id) <> ''),
            consent_type TEXT NOT NULL CHECK (
                consent_type IN ('behavior_signal', 'long_term_memory')
            ),
            granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
            granted_at TEXT NOT NULL,
            revoked_at TEXT,
            CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
        );
        INSERT INTO consents
            (id, candidate_id, consent_type, granted, granted_at, revoked_at)
        SELECT id, candidate_id, consent_type, granted, granted_at, revoked_at
        FROM consents_legacy;
        DROP TABLE consents_legacy;
        """
    )
    conn.commit()


def _ensure_sqlite_columns(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS utterances (
            id TEXT PRIMARY KEY,
            interview_id TEXT NOT NULL,
            utterance_index INTEGER NOT NULL CHECK (utterance_index >= 0),
            speaker TEXT NOT NULL CHECK (speaker IN ('interviewer', 'candidate', 'unknown')),
            text TEXT NOT NULL CHECK (trim(text) <> ''),
            start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
            end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
            sentence_count INTEGER NOT NULL CHECK (sentence_count >= 1),
            payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
            UNIQUE (interview_id, utterance_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS probe_chains (
            id TEXT PRIMARY KEY,
            interview_id TEXT NOT NULL,
            chain_index INTEGER NOT NULL CHECK (chain_index >= 0),
            topic TEXT NOT NULL CHECK (trim(topic) <> ''),
            origin TEXT NOT NULL CHECK (
                origin IN ('resume_claim', 'answer_claim', 'competency_gap')
            ),
            verdict TEXT NOT NULL CHECK (verdict IN ('held_up', 'cracked', 'unresolved')),
            payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
            UNIQUE (interview_id, chain_index)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS question_banks (
            interview_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
            created_at TEXT NOT NULL
        )
        """
    )

    existing_interviews = {
        row["name"] for row in conn.execute("PRAGMA table_info(interviews)").fetchall()
    }
    interview_columns = {
        "signal_enabled": "INTEGER NOT NULL DEFAULT 0 CHECK (signal_enabled IN (0, 1))",
    }
    for column, column_type in interview_columns.items():
        if column not in existing_interviews:
            conn.execute(f"ALTER TABLE interviews ADD COLUMN {column} {column_type}")

    existing_turns = {row["name"] for row in conn.execute("PRAGMA table_info(qa_turns)").fetchall()}
    turn_columns = {
        "payload": "TEXT",
        "question_utterance_id": "TEXT",
        "answer_utterance_id": "TEXT",
        "probe_chain_id": "TEXT",
        "asked_option_id": "TEXT",
        "question_origin": "TEXT",
    }
    for column, column_type in turn_columns.items():
        if column not in existing_turns:
            conn.execute(f"ALTER TABLE qa_turns ADD COLUMN {column} {column_type}")

    existing_scores = {row["name"] for row in conn.execute("PRAGMA table_info(scores)").fetchall()}
    score_columns = {
        "dimensions": "TEXT",
        "total_score": "REAL",
        "risk_notes": "TEXT",
        "recommendation": "TEXT",
    }
    for column, column_type in score_columns.items():
        if column not in existing_scores:
            conn.execute(f"ALTER TABLE scores ADD COLUMN {column} {column_type}")

    existing_aigc = {row["name"] for row in conn.execute("PRAGMA table_info(aigc_results)").fetchall()}
    aigc_columns = {
        "ai_generated_prob": "REAL",
        "template_similarity": "REAL",
        "matched_template": "TEXT",
        "flagged": "INTEGER",
    }
    for column, column_type in aigc_columns.items():
        if column not in existing_aigc:
            conn.execute(f"ALTER TABLE aigc_results ADD COLUMN {column} {column_type}")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS probe_patterns (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            competency TEXT NOT NULL CHECK (trim(competency) <> ''),
            pattern TEXT NOT NULL CHECK (trim(pattern) <> ''),
            embedding TEXT NOT NULL CHECK (
                json_valid(embedding) AND json_type(embedding) = 'array'
            ),
            created_at TEXT NOT NULL
        )
        """
    )


    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_memories (
            id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL CHECK (trim(repo_path) <> ''),
            repo_name TEXT NOT NULL CHECK (trim(repo_name) <> ''),
            topic TEXT NOT NULL CHECK (trim(topic) <> ''),
            fact TEXT NOT NULL CHECK (trim(fact) <> ''),
            evidence TEXT NOT NULL DEFAULT '',
            embedding TEXT NOT NULL CHECK (
                json_valid(embedding) AND json_type(embedding) = 'array'
            ),
            updated_at TEXT NOT NULL,
            UNIQUE (repo_path, topic)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS interview_memories (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (
                kind IN ('candidate_profile', 'probe_playbook', 'job_insight')
            ),
            subject_key TEXT NOT NULL CHECK (trim(subject_key) <> ''),
            candidate_id TEXT,
            job_id TEXT,
            summary TEXT NOT NULL CHECK (trim(summary) <> ''),
            detail TEXT NOT NULL DEFAULT '',
            embedding TEXT NOT NULL CHECK (
                json_valid(embedding) AND json_type(embedding) = 'array'
            ),
            source_interview_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (kind, subject_key, source_interview_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_interview_memories_candidate "
        "ON interview_memories(candidate_id)"
    )


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def loads(value: str) -> Any:
    if not isinstance(value, str):
        return value
    return json.loads(value)
