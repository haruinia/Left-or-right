from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from libs.common.config import get_settings
from libs.common.database import connect, dumps, loads
from libs.schemas import MemoryHit, new_id
from services.jd_kb_service.service import cosine_similarity, embed_text
from services.memory_service.repo_scan import resolve_repo_path, scan_repo

MEMORY_KINDS = ("candidate_profile", "probe_playbook", "job_insight")


def scan_repo_memories(path: str) -> int:
    """Index one local git repo into project_memories. Returns the row count written."""
    repo = resolve_repo_path(path)
    facts = scan_repo(str(repo))
    now = datetime.now(UTC).isoformat()
    repo_name = repo.name
    written = 0
    with connect() as conn:
        for fact in facts:
            embedding = embed_text(f"{repo_name} {fact.topic} {fact.fact}")
            conn.execute(
                """
                INSERT INTO project_memories
                    (id, repo_path, repo_name, topic, fact, evidence, embedding, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo_path, topic) DO UPDATE SET
                    fact = excluded.fact,
                    evidence = excluded.evidence,
                    embedding = excluded.embedding,
                    updated_at = excluded.updated_at
                """,
                (
                    new_id(),
                    str(repo),
                    repo_name,
                    fact.topic,
                    fact.fact,
                    fact.evidence,
                    dumps(embedding),
                    now,
                ),
            )
            written += 1
        conn.commit()
    return written


def scan_configured_roots() -> dict[str, int]:
    """Scan every git repo directly under each configured root."""
    settings = get_settings()
    results: dict[str, int] = {}
    roots = [
        Path(part.strip()).expanduser()
        for part in settings.memory_repo_roots.split(",")
        if part.strip()
    ]
    for root in roots:
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if len(results) >= settings.memory_repo_max_repos:
                return results
            if not (child / ".git").exists():
                continue
            try:
                results[str(child)] = scan_repo_memories(str(child))
            except ValueError:
                continue
    return results


def save_interview_memory(
    *,
    kind: str,
    subject_key: str,
    summary: str,
    detail: str = "",
    source_interview_id: str,
    candidate_id: str | None = None,
    job_id: str | None = None,
) -> None:
    if kind not in MEMORY_KINDS:
        raise ValueError(f"unknown interview memory kind: {kind}")
    if not subject_key.strip():
        raise ValueError("interview memory subject_key must not be blank")
    if not summary.strip():
        raise ValueError("interview memory summary must not be blank")
    embedding = embed_text(f"{subject_key} {summary} {detail}")
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO interview_memories
                (id, kind, subject_key, candidate_id, job_id, summary, detail,
                 embedding, source_interview_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (kind, subject_key, source_interview_id) DO UPDATE SET
                summary = excluded.summary,
                detail = excluded.detail,
                embedding = excluded.embedding
            """,
            (
                new_id(),
                kind,
                subject_key,
                candidate_id,
                job_id,
                summary,
                detail,
                dumps(embedding),
                source_interview_id,
                datetime.now(UTC).isoformat(),
            ),
        )
        conn.commit()


def delete_candidate_memories(candidate_id: str) -> int:
    if not candidate_id.strip():
        raise ValueError("candidate_id must not be blank")
    with connect() as conn:
        cursor = conn.execute(
            "DELETE FROM interview_memories WHERE candidate_id = ?", (candidate_id,)
        )
        conn.commit()
        return int(cursor.rowcount or 0)


def recall_memories(
    query: str,
    *,
    limit: int | None = None,
    exclude_interview_id: str | None = None,
) -> list[MemoryHit]:
    settings = get_settings()
    if not settings.memory_enabled or not query.strip():
        return []
    top_k = limit if limit is not None else settings.memory_recall_limit
    query_embedding = embed_text(query)
    hits: list[MemoryHit] = []

    with connect() as conn:
        for row in conn.execute(
            "SELECT id, repo_name, topic, fact, evidence, embedding FROM project_memories"
        ).fetchall():
            score = cosine_similarity(query_embedding, loads(row["embedding"]))
            if score < settings.memory_recall_min_score:
                continue
            hits.append(
                MemoryHit(
                    memory_id=row["id"],
                    kind="project",
                    subject=f"{row['repo_name']} · {row['topic']}",
                    summary=row["fact"],
                    detail=row["evidence"] or "",
                    score=_clamp(score),
                    origin=f"repo:{row['repo_name']}",
                )
            )
        for row in conn.execute(
            "SELECT id, kind, subject_key, summary, detail, embedding, source_interview_id "
            "FROM interview_memories"
        ).fetchall():
            if exclude_interview_id and row["source_interview_id"] == exclude_interview_id:
                continue
            score = cosine_similarity(query_embedding, loads(row["embedding"]))
            if score < settings.memory_recall_min_score:
                continue
            hits.append(
                MemoryHit(
                    memory_id=row["id"],
                    kind=row["kind"],
                    subject=row["subject_key"],
                    summary=row["summary"],
                    detail=row["detail"] or "",
                    score=_clamp(score),
                    origin=f"interview:{row['source_interview_id']}",
                )
            )

    hits.sort(key=lambda hit: (-hit.score, hit.subject, hit.memory_id))
    return hits[:top_k]


def _clamp(score: float) -> float:
    return max(0.0, min(1.0, round(score, 6)))
