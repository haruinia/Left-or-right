from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime

from libs.common.config import get_settings
from libs.common.database import connect, dumps, get_database_target, init_db, loads
from libs.common.prompts import load_prompt
from libs.llm_client import LLMMessage, get_llm_client
from libs.schemas import (
    CompetencyItem,
    CompetencyModel,
    JobCreate,
    JobRecord,
    ProbePatternHit,
    new_id,
)


DEFAULT_DIMENSIONS = [
    ("专业能力深度", "核心技能掌握、技术取舍、问题定位与解决能力", 0.30),
    ("项目真实性", "能否讲清楚个人职责、细节、困难和真实贡献", 0.25),
    ("岗位匹配度", "经历、动机与岗位职责和业务场景的契合程度", 0.20),
    ("沟通与逻辑", "表达结构、因果链和信息密度", 0.15),
    ("注水风险", "AIGC、模板化、前后矛盾与追问露馅风险", -0.10),
]

EMBEDDING_DIMENSIONS = 64


def _tokens(text: str) -> set[str]:
    raw_tokens = re.findall(r"[a-zA-Z0-9_+\-.#]+|[\u4e00-\u9fff]{2,}", text.lower())
    tokens: set[str] = set()
    for token in raw_tokens:
        tokens.add(token)
        if re.fullmatch(r"[\u4e00-\u9fff]{3,}", token):
            tokens.update(token[index : index + 2] for index in range(len(token) - 1))
    return tokens


def _score_pattern(query: str, competency: str, pattern: str) -> float:
    query_tokens = _tokens(query)
    if not query_tokens:
        return 0.0
    haystack = _tokens(f"{competency} {pattern}")
    overlap = len(query_tokens & haystack)
    phrase_bonus = 0.0
    lowered = f"{competency} {pattern}".lower()
    for token in query_tokens:
        if token in lowered:
            phrase_bonus += 0.25
    return round(overlap + phrase_bonus, 3)


def _technical_token_boost(query: str, pattern: str) -> float:
    query_tokens = {
        token
        for token in _tokens(query)
        if re.fullmatch(r"[a-zA-Z0-9_+\-.#]{2,}", token)
    }
    pattern_tokens = {
        token
        for token in _tokens(pattern)
        if re.fullmatch(r"[a-zA-Z0-9_+\-.#]{2,}", token)
    }
    return len(query_tokens & pattern_tokens) * 12.0


def embed_text(text: str, dimensions: int = EMBEDDING_DIMENSIONS) -> list[float]:
    vector = [0.0] * dimensions
    tokens = _tokens(text)
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[index] += sign
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [round(value / norm, 6) for value in vector]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return round(sum(a * b for a, b in zip(left, right, strict=True)), 6)


def generate_competency_model(job_id: str, title: str, jd_text: str) -> CompetencyModel:
    fallback = fallback_competency_model(job_id, title, jd_text)
    messages = [
        LLMMessage(role="system", content=load_prompt("competency_gen.md")),
        LLMMessage(
            role="user",
            content=json.dumps(
                {"job_id": job_id, "job_title": title, "jd_text": jd_text},
                ensure_ascii=False,
            ),
        ),
    ]
    draft = get_llm_client().complete_json_sync(messages, CompetencyModel, fallback)
    return _normalize_competency_model(draft, fallback, job_id=job_id, title=title)


def _normalize_competency_model(
    draft: CompetencyModel,
    fallback: CompetencyModel,
    *,
    job_id: str,
    title: str,
) -> CompetencyModel:
    draft_by_name = {item.name.strip(): item for item in draft.items if item.name.strip()}
    default_names = {name for name, _, _ in DEFAULT_DIMENSIONS}
    normalized: list[CompetencyItem] = []

    for fallback_item in fallback.items:
        draft_item = draft_by_name.get(fallback_item.name)
        if draft_item is None:
            normalized.append(fallback_item)
            continue
        normalized.append(
            CompetencyItem(
                name=fallback_item.name,
                description=draft_item.description.strip() or fallback_item.description,
                probe_patterns=_merge_patterns(
                    draft_item.probe_patterns,
                    fallback_item.probe_patterns,
                ),
                weight=fallback_item.weight,
            )
        )

    for draft_item in draft.items:
        name = draft_item.name.strip()
        if not name or name in default_names:
            continue
        weight = draft_item.weight if math.isfinite(draft_item.weight) else 0.10
        normalized.append(
            CompetencyItem(
                name=name,
                description=draft_item.description.strip() or f"{name}相关岗位能力",
                probe_patterns=_merge_patterns(
                    draft_item.probe_patterns,
                    [f"请围绕{name}追问一个可验证的具体案例。"],
                ),
                weight=max(0.0, min(1.0, weight)),
            )
        )

    return CompetencyModel(job_id=job_id, job_title=title, items=normalized)


def _merge_patterns(primary: list[str], fallback: list[str]) -> list[str]:
    merged: list[str] = []
    for pattern in [*primary, *fallback]:
        cleaned = pattern.strip()
        if cleaned and cleaned not in merged:
            merged.append(cleaned)
    return merged


def fallback_competency_model(job_id: str, title: str, jd_text: str) -> CompetencyModel:
    text = jd_text.lower()
    items: list[CompetencyItem] = []
    for name, description, weight in DEFAULT_DIMENSIONS:
        patterns = [
            f"请围绕{name}追问一个可验证的具体案例。",
            "请要求候选人说明自己负责的具体部分、为什么这样做、遇到的坑。",
        ]
        if "python" in text or "fastapi" in text:
            patterns.append("请追问 Python/FastAPI 的工程设计、性能和异常处理细节。")
        if "ai" in text or "llm" in text or "大模型" in text:
            patterns.append("请追问 LLM 调用、评估、成本、失败降级和安全边界。")
        items.append(CompetencyItem(name=name, description=description, probe_patterns=patterns, weight=weight))
    return CompetencyModel(job_id=job_id, job_title=title, items=items)


def _pattern_text(competency: str, pattern: str) -> str:
    return f"{competency} {pattern}"


def retrieve_probe_patterns(
    competency_model: CompetencyModel,
    query: str,
    *,
    limit: int = 5,
) -> list[ProbePatternHit]:
    hits: list[ProbePatternHit] = []
    for item in competency_model.items:
        for pattern in item.probe_patterns:
            score = _score_pattern(query, item.name, pattern)
            if score > 0:
                hits.append(
                    ProbePatternHit(
                        job_id=competency_model.job_id,
                        competency=item.name,
                        pattern=pattern,
                        score=score,
                    )
                )
    hits.sort(key=lambda hit: (-hit.score, hit.competency, hit.pattern))
    return hits[:limit]


def retrieve_job_probe_patterns(job_id: str, query: str, *, limit: int = 5) -> list[ProbePatternHit]:
    if _use_pgvector():
        pgvector_hits = _retrieve_pgvector_probe_patterns(job_id, query, limit=limit)
        if pgvector_hits:
            return pgvector_hits
    indexed_hits = _retrieve_indexed_probe_patterns(job_id, query, limit=limit)
    if indexed_hits:
        return indexed_hits
    return retrieve_probe_patterns(get_job(job_id).competency_model, query, limit=limit)


def _retrieve_indexed_probe_patterns(job_id: str, query: str, *, limit: int) -> list[ProbePatternHit]:
    init_db()
    query_embedding = embed_text(query)
    with connect() as conn:
        rows = conn.execute(
            "SELECT competency, pattern, embedding FROM probe_patterns WHERE job_id = ?",
            (job_id,),
        ).fetchall()
    hits: list[ProbePatternHit] = []
    for row in rows:
        competency = row["competency"]
        pattern = row["pattern"]
        embedding = loads(row["embedding"])
        semantic = cosine_similarity(query_embedding, embedding)
        lexical = _score_pattern(query, competency, pattern)
        score = round(max(0.0, semantic) + lexical + _technical_token_boost(query, pattern), 6)
        if score > 0:
            hits.append(
                ProbePatternHit(
                    job_id=job_id,
                    competency=competency,
                    pattern=pattern,
                    score=score,
                )
            )
    hits.sort(key=lambda hit: (-hit.score, hit.competency, hit.pattern))
    return hits[:limit]


def _retrieve_pgvector_probe_patterns(job_id: str, query: str, *, limit: int) -> list[ProbePatternHit]:
    init_db()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT competency, pattern, 1 - (embedding_vector <=> ?::vector) AS score
            FROM probe_patterns
            WHERE job_id = ? AND embedding_vector IS NOT NULL
            ORDER BY embedding_vector <=> ?::vector
            LIMIT ?
            """,
            (
                _pgvector_literal(embed_text(query)),
                job_id,
                _pgvector_literal(embed_text(query)),
                limit,
            ),
        ).fetchall()
    return [
        ProbePatternHit(
            job_id=job_id,
            competency=row["competency"],
            pattern=row["pattern"],
            score=round(float(row["score"]), 6),
        )
        for row in rows
        if row["score"] is not None
    ]


def _index_probe_patterns(record: JobRecord) -> None:
    now = datetime.now(UTC).isoformat()
    with connect() as conn:
        for item in record.competency_model.items:
            for pattern in item.probe_patterns:
                embedding = embed_text(_pattern_text(item.name, pattern))
                if _use_pgvector():
                    conn.execute(
                        """
                        INSERT INTO probe_patterns
                        (id, job_id, competency, pattern, embedding, embedding_vector, created_at)
                        VALUES (?, ?, ?, ?, ?, ?::vector, ?)
                        """,
                        (
                            new_id(),
                            record.id,
                            item.name,
                            pattern,
                            dumps(embedding),
                            _pgvector_literal(embedding),
                            now,
                        ),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO probe_patterns
                        (id, job_id, competency, pattern, embedding, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            new_id(),
                            record.id,
                            item.name,
                            pattern,
                            dumps(embedding),
                            now,
                        ),
                    )


def _use_pgvector() -> bool:
    return get_settings().jd_vector_backend == "pgvector" and get_database_target().dialect == "postgresql"


def _pgvector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def create_job(payload: JobCreate) -> JobRecord:
    init_db()
    job_id = new_id()
    record = JobRecord(
        id=job_id,
        title=payload.title,
        jd_text=payload.jd_text,
        competency_model=generate_competency_model(job_id, payload.title, payload.jd_text),
    )
    with connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, title, jd_text, competency_model, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                record.id,
                record.title,
                record.jd_text,
                dumps(record.competency_model.model_dump()),
                record.created_at.isoformat(),
            ),
        )
    _index_probe_patterns(record)
    return record


def update_job_title(job_id: str, title: str) -> JobRecord:
    clean_title = title.strip()
    if clean_title:
        with connect() as conn:
            conn.execute("UPDATE jobs SET title = ? WHERE id = ?", (clean_title, job_id))
    return get_job(job_id)


def get_job(job_id: str) -> JobRecord:
    init_db()
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise KeyError(f"job not found: {job_id}")
    return JobRecord(
        id=row["id"],
        title=row["title"],
        jd_text=row["jd_text"],
        competency_model=CompetencyModel.model_validate(loads(row["competency_model"])),
        created_at=datetime.fromisoformat(row["created_at"]),
    )
