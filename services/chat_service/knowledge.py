from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import Counter
from contextlib import closing
from typing import Any

from services.gateway.learning_assets import _database_path
from services.knowledge_service.tokens import tokens as _tokens

_MAX_PAYLOAD_CHARS = 150000
_MAX_DOCUMENTS = 5000
def _document(raw: str, record_id: str, exclude_session_id: str | None) -> dict[str, Any] | None:
    try:
        item = json.loads(raw)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(item, dict) or item.get("partial") or item.get("answer_partial"):
        return None
    if item.get("id") != record_id or not isinstance(record_id, str) or not 0 < len(record_id) <= 200:
        return None
    question, answer = item.get("question"), item.get("answer")
    tags, source = item.get("tags", []), item.get("sourceSessionId", "")
    if not isinstance(question, str) or not isinstance(answer, str) or not question.strip() or not answer.strip():
        return None
    if len(question) > 10000 or len(answer) > 100000:
        return None
    if not isinstance(tags, list) or len(tags) > 30 or any(not isinstance(tag, str) or len(tag) > 120 for tag in tags):
        return None
    if not isinstance(source, str) or len(source) > 200 or (exclude_session_id is not None and source == exclude_session_id):
        return None
    return {"id": record_id, "question": question.strip(), "answer": answer.strip(), "tags": [tag.strip() for tag in tags if tag.strip()], "sourceSessionId": source}


def _source_is_partial(connection: sqlite3.Connection, item: dict[str, Any], cache: dict[str, dict | None]) -> bool:
    source = item["sourceSessionId"]
    if not source:
        return False
    if source not in cache:
        row = connection.execute("SELECT payload FROM assets WHERE kind=? AND id=? AND deleted=0 AND length(payload)<=?", ("sessions", source, 1000000)).fetchone()
        try:
            record = json.loads(row[0]) if row else None
        except (ValueError, TypeError, RecursionError):
            record = None
        cache[source] = record if isinstance(record, dict) else None
    record = cache[source]
    if not record:
        return False
    if record.get("partial"):
        return True
    turns = record.get("turns")
    if not isinstance(turns, list):
        return False
    for before, after in zip(turns, turns[1:]):
        if not isinstance(before, dict) or not isinstance(after, dict) or before.get("role") != "user" or after.get("role") != "assistant":
            continue
        question, answer = before.get("text"), after.get("text")
        if isinstance(question, str) and isinstance(answer, str) and question.strip().startswith(item["question"]) and answer.strip().startswith(item["answer"]):
            return bool(before.get("partial") or after.get("partial"))
    return False


def _documents(exclude_session_id: str | None) -> list[dict[str, Any]]:
    path = _database_path()
    try:
        if not path.is_file():
            return []
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)) as connection:
            rows = connection.execute(
                "SELECT id, payload FROM assets WHERE kind=? AND deleted=0 AND length(payload)<=? ORDER BY id LIMIT ?",
                ("knowledge", _MAX_PAYLOAD_CHARS, _MAX_DOCUMENTS),
            )
            result, seen, source_cache = [], set(), {}
            for record_id, raw in rows:
                item = _document(raw, record_id, exclude_session_id)
                if item is None or _source_is_partial(connection, item, source_cache):
                    continue
                key = tuple("".join(re.findall(r"[a-z0-9一-鿿+#]+", item[field].lower())) for field in ("question", "answer"))
                if key in seen:
                    continue
                seen.add(key)
                result.append(item)
            return result
    except (OSError, sqlite3.Error):
        return []


def _matches(text: str, tokens: set[str]) -> list[tuple[int, str]]:
    lower = text.lower()
    matches = []
    for token in tokens:
        pattern = re.escape(token) if "一" <= token[0] <= "鿿" else rf"(?<![a-z0-9_+#]){re.escape(token)}(?![a-z0-9_+#])"
        for index, match in enumerate(re.finditer(pattern, lower)):
            if index >= 24:
                break
            matches.append((match.start(), token))
    return matches


def _excerpt(text: str, tokens: set[str], budget: int) -> str:
    if len(text) <= budget:
        return text
    if budget <= 0:
        return ""
    if budget <= 2:
        return text[:budget]
    width = budget - 2
    matches = _matches(text, tokens)
    candidates = {0, *(max(0, min(position - width // 3, len(text) - width)) for position, _token in matches)}
    start = max(candidates, key=lambda position: (len({token for offset, token in matches if position <= offset < position + width}), -position))
    stop = min(len(text), start + width)
    return ("…" if start else "") + text[start:stop] + ("…" if stop < len(text) else "")


def _snippet(item: dict[str, Any], tokens: set[str], budget: int) -> dict[str, Any]:
    tags, tag_budget = [], min(200, budget // 8)
    for tag in item["tags"]:
        if len(tag) <= tag_budget:
            tags.append(tag)
            tag_budget -= len(tag)
    remaining = budget - sum(map(len, tags))
    question = _excerpt(item["question"], tokens, min(800, max(1, remaining // 3)))
    answer = _excerpt(item["answer"], tokens, remaining - len(question))
    return {"id": item["id"], "question": question, "answer": answer, "tags": tags, "sourceSessionId": item["sourceSessionId"]}


def _retrieve_history(query: str, *, limit: int = 3, max_chars: int = 6000, exclude_session_id: str | None = None) -> list[dict[str, Any]]:
    limit, max_chars = min(3, max(0, limit)), min(6000, max(0, max_chars))
    tokens = _tokens(query[:8000])
    if not tokens or not limit or max_chars < 2:
        return []
    documents = _documents(exclude_session_id)
    fields = [(_tokens(item["question"]), _tokens(" ".join(item["tags"])), _tokens(item["answer"])) for item in documents]
    frequencies = Counter(token for groups in fields for token in set.union(*groups))
    weights = {token: math.log(1 + (len(documents) + 0.5) / (frequencies[token] + 0.5)) for token in tokens}
    total_weight = sum(weights.values())
    ranked = []
    chinese = {token for token in tokens if "一" <= token[0] <= "鿿"}
    for item, groups in zip(documents, fields, strict=True):
        overlap = tokens & set.union(*groups)
        english_match = bool(overlap - chinese)
        if not overlap or (not english_match and len(chinese) >= 3 and len(overlap) < 2):
            continue
        coverage = sum(weights[token] for token in overlap) / total_weight
        if coverage < 0.25 and not ((overlap - chinese) & (groups[0] | groups[1])):
            continue
        score = coverage * sum(sum(weights[token] for token in tokens & group) * factor / math.sqrt(1 + len(group) / 30) for group, factor in zip(groups, (4, 5, 1), strict=True))
        ranked.append((score, item))
    ranked.sort(key=lambda pair: (-pair[0], pair[1]["id"]))
    selected = [item for _score, item in ranked[:min(limit, max_chars // 2)]]
    result, remaining = [], max_chars
    for index, item in enumerate(selected):
        snippet = _snippet(item, tokens, remaining // (len(selected) - index))
        remaining -= len(snippet["question"]) + len(snippet["answer"]) + sum(map(len, snippet["tags"]))
        result.append(snippet)
    return result


def retrieve_knowledge(
    query: str, *, limit: int = 3, max_chars: int = 6000,
    exclude_session_id: str | None = None, project_ids: list[str] | tuple[str, ...] = (),
    include_history: bool = True,
) -> list[dict[str, Any]]:
    limit, max_chars = min(3, max(0, limit)), min(6000, max(0, max_chars))
    if not limit or max_chars < 2 or not _tokens(query[:8000]):
        return []
    result = []
    if project_ids:
        from services.knowledge_service.store import search

        result = search(query, project_ids, limit=limit, max_chars=max_chars)
    remaining = max_chars - sum(len(json.dumps(item, ensure_ascii=False)) for item in result)
    if include_history and remaining >= 2 and len(result) < limit:
        result.extend(_retrieve_history(
            query, limit=limit - len(result), max_chars=remaining,
            exclude_session_id=exclude_session_id,
        ))
    return result
