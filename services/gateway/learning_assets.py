"""Shared local learning assets for the desktop shell and browser settings page."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from libs.common.config import get_settings

router = APIRouter(prefix="/api/learning-assets", tags=["learning-assets"])
AssetKind = Literal["sessions", "knowledge", "feedback", "exams"]


def _database_path() -> Path:
    raw = get_settings().database_url
    if raw.startswith("sqlite:///"):
        configured = Path(raw.removeprefix("sqlite:///"))
        if str(configured) not in {"", ":memory:"}:
            return configured.parent / "learning_assets.sqlite3"
    return Path("data") / "learning_assets.sqlite3"


@contextmanager
def _connection():
    path = _database_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=10) as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS assets (
                kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, id)
            )""")
            yield connection
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(503, "学习资产存储暂时不可用，请重试。") from exc


class AssetWrite(BaseModel):
    item: dict[str, Any]


class AssetMigration(BaseModel):
    items: list[dict[str, Any]] = Field(max_length=2000)


class AssetDelete(BaseModel):
    id: str = Field(min_length=1, max_length=200)


def _serialize(item: dict[str, Any]) -> tuple[str, str]:
    record_id = item.get("id")
    if not isinstance(record_id, str) or not record_id or len(record_id) > 200:
        raise HTTPException(422, "资产必须有有效的 id。")
    payload = json.dumps(item, ensure_ascii=False)
    if len(payload.encode("utf-8")) > 4 * 1024 * 1024:
        raise HTTPException(413, "单条资产过大，请减少截图后重试。")
    return record_id, payload


@router.get("/{kind}")
def list_assets(kind: AssetKind):
    with _connection() as connection:
        rows = connection.execute(
            "SELECT payload FROM assets WHERE kind=? AND deleted=0 ORDER BY rowid", (kind,)
        ).fetchall()
    return {"items": [json.loads(row[0]) for row in rows]}


@router.post("/{kind}/upsert")
def upsert_asset(kind: AssetKind, body: AssetWrite):
    record_id, payload = _serialize(body.item)
    with _connection() as connection:
        connection.execute(
            """INSERT INTO assets(kind, id, payload) VALUES (?, ?, ?)
            ON CONFLICT(kind, id) DO UPDATE SET payload=excluded.payload, deleted=0""",
            (kind, record_id, payload),
        )
    return {"item": body.item}


@router.post("/{kind}/migrate")
def migrate_assets(kind: AssetKind, body: AssetMigration):
    # Old localStorage snapshots may exist in several origins. Never overwrite a newer
    # shared edit, or resurrect a deleted record when a second origin migrates later.
    rows = [(kind, *_serialize(item)) for item in body.items]
    with _connection() as connection:
        before = connection.total_changes
        connection.executemany(
            "INSERT OR IGNORE INTO assets(kind, id, payload) VALUES (?, ?, ?)", rows
        )
        imported = connection.total_changes - before
    return {"ok": True, "imported": imported}


@router.post("/{kind}/delete")
def delete_asset(kind: AssetKind, body: AssetDelete):
    with _connection() as connection:
        connection.execute(
            """INSERT INTO assets(kind, id, payload, deleted) VALUES (?, ?, '{}', 1)
            ON CONFLICT(kind, id) DO UPDATE SET deleted=1""", (kind, body.id)
        )
    return {"ok": True}


@router.post("/{kind}/clear")
def clear_assets(kind: AssetKind):
    with _connection() as connection:
        connection.execute("UPDATE assets SET deleted=1 WHERE kind=?", (kind,))
    return {"ok": True}


@router.post("/knowledge/{record_id}/review")
def review_asset(record_id: str):
    from datetime import UTC, datetime

    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT payload FROM assets WHERE kind='knowledge' AND id=? AND deleted=0",
            (record_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "知识已被删除，请刷新列表。")
        item = json.loads(row[0])
        item["reviewCount"] = int(item.get("reviewCount", 0)) + 1
        item["lastReviewedAt"] = datetime.now(UTC).isoformat()
        connection.execute(
            "UPDATE assets SET payload=? WHERE kind='knowledge' AND id=?",
            (json.dumps(item, ensure_ascii=False), record_id),
        )
    return {"item": item}
