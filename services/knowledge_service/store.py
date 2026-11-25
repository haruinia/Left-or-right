from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import PurePosixPath
from typing import Any

from services.document_service.service import (
    KNOWLEDGE_MAX_BYTES,
    KNOWLEDGE_MAX_CHARS,
    KNOWLEDGE_SUFFIXES,
    extract_local_document,
)
from services.gateway.learning_assets import _database_path
from services.knowledge_service.tokens import index_tokens, tokens

MAX_FILES = 1000
MAX_TOTAL_BYTES = 40 * 1024 * 1024
MAX_TOTAL_CHARS = 1000000
PARSER_VERSION = 1
IMPORT_TTL = 30 * 60
CHUNK_CHARS = 1600
MAX_PROJECTS = 100
_EXCLUDED_DIRECTORIES = frozenset({
    ".git", ".hg", ".svn", ".ssh", ".aws", ".azure", ".config", ".idea",
    "node_modules", "vendor", "bower_components", "venv", ".venv", "__pycache__",
    "dist", "build", "out", "output", "target", "coverage", ".next", ".nuxt",
    ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".terraform",
})
_SECRET_NAME = re.compile(r"^(?:\.env.*|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[._-].*)?|service[-_]?account(?:[._-].*)?)$", re.IGNORECASE)
_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS knowledge_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL,
        parser_version INTEGER NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
        updated_at REAL NOT NULL, UNIQUE(project_id, relative_path)
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, heading TEXT NOT NULL, start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL, text TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(chunk_id UNINDEXED, tokens)",
    """CREATE TABLE IF NOT EXISTS knowledge_import_reports (
        project_id TEXT PRIMARY KEY REFERENCES knowledge_projects(id) ON DELETE CASCADE, report TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_imports (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES knowledge_projects(id) ON DELETE CASCADE,
        created_at REAL NOT NULL, bytes_used INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS knowledge_import_files (
        import_id TEXT NOT NULL REFERENCES knowledge_imports(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(import_id, relative_path)
    )""",
)


class KnowledgeError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


@contextmanager
def _connection():
    path = _database_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        os.chmod(path, 0o600)
        with closing(sqlite3.connect(path, timeout=10)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            with connection:
                for statement in _SCHEMA:
                    connection.execute(statement)
            with connection:
                connection.execute("DELETE FROM knowledge_imports WHERE created_at<?", (time.time() - IMPORT_TTL,))
            with connection:
                yield connection
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.exists():
                os.chmod(sidecar, 0o600)
    except (OSError, sqlite3.Error) as exc:
        raise KnowledgeError(503, "知识库存储或本地索引暂时不可用，请重试。") from exc


def validate_path(relative_path: str) -> str:
    if not isinstance(relative_path, str) or not 0 < len(relative_path) <= 1000:
        raise KnowledgeError(422, "文件相对路径无效。")
    if "\\" in relative_path or ":" in relative_path or any(ord(char) < 32 for char in relative_path):
        raise KnowledgeError(422, "文件相对路径无效。")
    path = PurePosixPath(relative_path)
    parts = relative_path.split("/")
    if path.is_absolute() or any(part in {"", ".", ".."} for part in parts):
        raise KnowledgeError(422, "文件路径不能越过导入目录。")
    if any(part.lower() in _EXCLUDED_DIRECTORIES or _SECRET_NAME.fullmatch(part) for part in parts):
        raise KnowledgeError(422, "已跳过敏感文件或依赖、构建目录。")
    if path.suffix.lower() not in KNOWLEDGE_SUFFIXES:
        raise KnowledgeError(422, "此文件类型不支持导入。")
    return path.as_posix()


def capabilities() -> dict[str, Any]:
    with _connection():
        pass
    return {"suffixes": sorted(KNOWLEDGE_SUFFIXES), "max_file_bytes": KNOWLEDGE_MAX_BYTES,
            "max_files": MAX_FILES, "max_total_bytes": MAX_TOTAL_BYTES,
            "max_document_chars": KNOWLEDGE_MAX_CHARS, "max_total_chars": MAX_TOTAL_CHARS,
            "local_only": True, "fts5": True}


def _project(connection, project_id: str):
    row = connection.execute(
        """SELECT p.*, (SELECT count(*) FROM knowledge_documents d WHERE d.project_id=p.id) AS document_count
        FROM knowledge_projects p WHERE p.id=?""", (project_id,),
    ).fetchone()
    if row is None:
        raise KnowledgeError(404, "项目已不存在，请返回知识库。")
    return dict(row)


def create_project(name: str) -> dict[str, Any]:
    name = name.strip()
    if not name or len(name) > 120:
        raise KnowledgeError(422, "项目名称须为 1–120 个字符。")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT count(*) FROM knowledge_projects").fetchone()[0] >= MAX_PROJECTS:
            raise KnowledgeError(409, "最多保留 100 个项目，请先整理已有项目。")
        project_id, now = uuid.uuid4().hex, time.time()
        connection.execute("INSERT INTO knowledge_projects VALUES (?,?,?,?)", (project_id, name, now, now))
        return _project(connection, project_id)


def list_projects() -> list[dict[str, Any]]:
    with _connection() as connection:
        return [dict(row) for row in connection.execute(
            """SELECT p.*, (SELECT count(*) FROM knowledge_documents d WHERE d.project_id=p.id) AS document_count
            FROM knowledge_projects p ORDER BY p.updated_at DESC, p.id"""
        )]


def project_detail(project_id: str) -> dict[str, Any]:
    with _connection() as connection:
        project = _project(connection, project_id)
        documents = [dict(row) for row in connection.execute(
            """SELECT d.id,d.relative_path,d.title,d.content_hash,d.updated_at,d.version,
            (SELECT count(*) FROM knowledge_chunks c WHERE c.document_id=d.id) AS chunk_count
            FROM knowledge_documents d WHERE project_id=? ORDER BY relative_path""", (project_id,),
        )]
        report = connection.execute("SELECT report FROM knowledge_import_reports WHERE project_id=?", (project_id,)).fetchone()
        return {"project": project, "documents": documents, "last_import": json.loads(report[0]) if report else []}


def rename_project(project_id: str, name: str) -> dict[str, Any]:
    name = name.strip()
    if not name or len(name) > 120:
        raise KnowledgeError(422, "项目名称须为 1–120 个字符。")
    with _connection() as connection:
        _project(connection, project_id)
        connection.execute("UPDATE knowledge_projects SET name=?,updated_at=? WHERE id=?", (name, time.time(), project_id))
        return _project(connection, project_id)


def _remove_document(connection, document_id: str):
    connection.execute("DELETE FROM knowledge_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?)", (document_id,))
    connection.execute("DELETE FROM knowledge_documents WHERE id=?", (document_id,))


def delete_project(project_id: str):
    with _connection() as connection:
        _project(connection, project_id)
        for row in connection.execute("SELECT id FROM knowledge_documents WHERE project_id=?", (project_id,)).fetchall():
            _remove_document(connection, row[0])
        connection.execute("DELETE FROM knowledge_projects WHERE id=?", (project_id,))


def delete_document(project_id: str, document_id: str):
    with _connection() as connection:
        _document(connection, project_id, document_id)
        if connection.execute("SELECT 1 FROM knowledge_imports WHERE project_id=?", (project_id,)).fetchone():
            raise KnowledgeError(409, "项目正在导入，请完成或取消后再删除文件。")
        _remove_document(connection, document_id)
        connection.execute("UPDATE knowledge_projects SET updated_at=? WHERE id=?", (time.time(), project_id))


def _document(connection, project_id: str, document_id: str):
    row = connection.execute("SELECT * FROM knowledge_documents WHERE project_id=? AND id=?", (project_id, document_id)).fetchone()
    if row is None:
        raise KnowledgeError(404, "文件已不存在，请返回项目。")
    return dict(row)


def document_detail(project_id: str, document_id: str) -> dict[str, Any]:
    with _connection() as connection:
        document = _document(connection, project_id, document_id)
        document["chunks"] = [dict(row) for row in connection.execute(
            "SELECT heading,start_line,end_line FROM knowledge_chunks WHERE document_id=? ORDER BY id", (document_id,),
        )]
        return document


def begin_import(project_id: str) -> str:
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _project(connection, project_id)
        if connection.execute("SELECT 1 FROM knowledge_imports WHERE project_id=?", (project_id,)).fetchone():
            raise KnowledgeError(409, "项目已有进行中的导入，请先完成或取消。")
        import_id = uuid.uuid4().hex
        connection.execute("INSERT INTO knowledge_imports(id,project_id,created_at) VALUES (?,?,?)", (import_id, project_id, time.time()))
        return import_id


def _import(connection, project_id: str, import_id: str):
    row = connection.execute("SELECT * FROM knowledge_imports WHERE id=? AND project_id=?", (import_id, project_id)).fetchone()
    if row is None:
        raise KnowledgeError(404, "导入已取消或过期，请重新选择文件。")
    return dict(row)


def cancel_import(project_id: str, import_id: str):
    with _connection() as connection:
        connection.execute("DELETE FROM knowledge_imports WHERE id=? AND project_id=?", (import_id, project_id))


def stage_file(project_id: str, import_id: str, relative_path: str, data: bytes) -> dict[str, Any]:
    relative_path = validate_path(relative_path)
    if len(data) > KNOWLEDGE_MAX_BYTES:
        raise KnowledgeError(413, "单个文件不能超过 5 MiB。")
    content_hash = hashlib.sha256(data).hexdigest()
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = _import(connection, project_id, import_id)
        if task["bytes_used"] + len(data) > MAX_TOTAL_BYTES:
            raise KnowledgeError(413, "本批文件超过 40 MiB，请分批导入。")
        existing_stage = connection.execute("SELECT status FROM knowledge_import_files WHERE import_id=? AND relative_path=?", (import_id, relative_path)).fetchone()
        count = connection.execute("SELECT count(*) FROM knowledge_import_files WHERE import_id=?", (import_id,)).fetchone()[0]
        if existing_stage is None and count >= MAX_FILES:
            raise KnowledgeError(413, "单批最多导入 1000 个文件。")
        if existing_stage is not None and existing_stage[0] == "processing":
            raise KnowledgeError(409, "此文件正在处理，请稍后重试。")
        old = connection.execute("SELECT content_hash,parser_version FROM knowledge_documents WHERE project_id=? AND relative_path=?", (project_id, relative_path)).fetchone()
        unchanged = bool(old and old["content_hash"] == content_hash and old["parser_version"] == PARSER_VERSION)
        status = "unchanged" if unchanged else "processing"
        connection.execute("UPDATE knowledge_imports SET bytes_used=bytes_used+? WHERE id=?", (len(data), import_id))
        connection.execute("""INSERT INTO knowledge_import_files(import_id,relative_path,status,content_hash) VALUES (?,?,?,?)
            ON CONFLICT(import_id,relative_path) DO UPDATE SET status=excluded.status,content_hash=excluded.content_hash,text='',reason=''""",
            (import_id, relative_path, status, content_hash))
    if unchanged:
        return {"status": "unchanged", "relative_path": relative_path}
    try:
        text = extract_local_document(relative_path, data)
        status, reason = "ready", ""
    except (ValueError, UnicodeError, RuntimeError) as exc:
        text, status, reason = "", "failed", _safe_reason(exc)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _import(connection, project_id, import_id)
        if status == "ready":
            used = connection.execute("SELECT coalesce(sum(length(text)),0) FROM knowledge_import_files WHERE import_id=? AND relative_path<>?", (import_id, relative_path)).fetchone()[0]
            if used + len(text) > MAX_TOTAL_CHARS:
                text, status, reason = "", "failed", "本批正文超过 1,000,000 字符，请分批导入。"
        connection.execute("UPDATE knowledge_import_files SET status=?,text=?,reason=? WHERE import_id=? AND relative_path=?",
                           (status, text, reason, import_id, relative_path))
    return {"status": status, "relative_path": relative_path, **({"reason": reason} if reason else {})}


def _safe_reason(error: Exception) -> str:
    message = str(error)
    if isinstance(error, ValueError) and len(message) < 240 and not re.search(r"(?:[A-Za-z]:[\\/]|/(?:Users|home|private|tmp)/)", message):
        return message
    return "文件文本无法解析，请检查格式后重试。"


def chunks(text: str) -> list[dict[str, Any]]:
    sections: list[tuple[str, int, list[str]]] = []
    headings: list[tuple[int, str]] = []
    heading = ""
    start_line = 1
    current: list[str] = []
    fence = ""
    fence_width = 0
    for line_number, line in enumerate(text.split("\n"), 1):
        fence_match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        is_heading = None if fence else re.match(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if is_heading:
            if current:
                sections.append((heading, start_line, current))
            level, title = len(is_heading[1]), is_heading[2].strip()
            headings = [(depth, name) for depth, name in headings if depth < level]
            headings.append((level, title))
            heading = " / ".join(name for _depth, name in headings)[:500]
            start_line, current = line_number, []
        current.append(line)
        if fence_match:
            marker = fence_match[1]
            if not fence:
                fence, fence_width = marker[0], len(marker)
            elif marker[0] == fence and len(marker) >= fence_width and not fence_match[2].strip():
                fence = ""
    if current:
        sections.append((heading, start_line, current))
    result = []
    for heading, start, lines in sections:
        part, part_start, count = [], start, 0
        for offset, line in enumerate(lines):
            number = start + offset
            if part and count + len(line) + 1 > CHUNK_CHARS:
                result.append({"heading": heading, "start_line": part_start, "end_line": number - 1, "text": "\n".join(part)})
                part, count = [], 0
            for index in range(0, max(1, len(line)), CHUNK_CHARS):
                piece = line[index:index + CHUNK_CHARS]
                if index or len(line) > CHUNK_CHARS:
                    if piece.strip():
                        result.append({"heading": heading, "start_line": number, "end_line": number, "text": piece})
                else:
                    if not part:
                        part_start = number
                    part.append(piece)
                    count += len(piece) + 1
        if part and "\n".join(part).strip():
            result.append({"heading": heading, "start_line": part_start, "end_line": start + len(lines) - 1, "text": "\n".join(part)})
    return result


def finish_import(project_id: str, import_id: str, *, replace: bool = False, preserve_paths: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    if len(preserve_paths) > MAX_FILES:
        raise KnowledgeError(422, "保留文件清单过大。")
    for path in preserve_paths:
        if not isinstance(path, str) or not 0 < len(path) <= 1000 or path.startswith("/") or "\\" in path or ":" in path or any(part in {"", ".", ".."} for part in path.split("/")) or any(ord(char) < 32 for char in path):
            raise KnowledgeError(422, "保留文件相对路径无效。")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _import(connection, project_id, import_id)
        staged = connection.execute("SELECT * FROM knowledge_import_files WHERE import_id=? ORDER BY relative_path", (import_id,)).fetchall()
        if any(row["status"] == "processing" for row in staged):
            raise KnowledgeError(409, "文件仍在处理，请稍后完成导入。")
        if not staged and not replace:
            raise KnowledgeError(422, "没有可处理的文件，已有项目内容未改变。")
        now = time.time()
        imported = unchanged = failed = 0
        for row in staged:
            if row["status"] == "failed":
                failed += 1
                continue
            if row["status"] == "unchanged":
                unchanged += 1
                continue
            old = connection.execute("SELECT id,version FROM knowledge_documents WHERE project_id=? AND relative_path=?", (project_id, row["relative_path"])).fetchone()
            document_id, version = (old["id"], old["version"] + 1) if old else (uuid.uuid4().hex, 1)
            pieces = chunks(row["text"])
            title = next((piece["heading"].split(" / ")[0] for piece in pieces if piece["heading"]), PurePosixPath(row["relative_path"]).stem)
            if old:
                connection.execute("DELETE FROM knowledge_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?)", (document_id,))
                connection.execute("DELETE FROM knowledge_chunks WHERE document_id=?", (document_id,))
            connection.execute("""INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_hash=excluded.content_hash,
                parser_version=excluded.parser_version,version=excluded.version,text=excluded.text,updated_at=excluded.updated_at""",
                (document_id, project_id, row["relative_path"], title, row["content_hash"], PARSER_VERSION, version, row["text"], now))
            for piece in pieces:
                cursor = connection.execute("INSERT INTO knowledge_chunks(document_id,version,heading,start_line,end_line,text) VALUES (?,?,?,?,?,?)",
                    (document_id, version, piece["heading"], piece["start_line"], piece["end_line"], piece["text"]))
                connection.execute("INSERT INTO knowledge_fts(chunk_id,tokens) VALUES (?,?)",
                    (cursor.lastrowid, index_tokens(row["relative_path"] + "\n" + piece["heading"] + "\n" + piece["text"])))
            imported += 1
        if replace:
            retained = {row["relative_path"] for row in staged} | set(preserve_paths)
            for row in connection.execute("SELECT id,relative_path FROM knowledge_documents WHERE project_id=?", (project_id,)).fetchall():
                if row["relative_path"] not in retained:
                    _remove_document(connection, row["id"])
        report = [{"path": row["relative_path"], "status": row["status"], "reason": row["reason"]} for row in staged]
        connection.execute("INSERT INTO knowledge_import_reports(project_id,report) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET report=excluded.report",
                           (project_id, json.dumps(report, ensure_ascii=False)))
        connection.execute("UPDATE knowledge_projects SET updated_at=? WHERE id=?", (now, project_id))
        connection.execute("DELETE FROM knowledge_imports WHERE id=?", (import_id,))
        return {"project": _project(connection, project_id), "imported": imported, "unchanged": unchanged, "failed": failed,
                "documents": [dict(row) for row in connection.execute("SELECT id,relative_path,title,content_hash,updated_at FROM knowledge_documents WHERE project_id=? ORDER BY relative_path", (project_id,))]}


def _excerpt(text: str, query_tokens: set[str], budget: int) -> str:
    if len(text) <= budget:
        return text
    width = max(1, budget - 2)
    matches = []
    for token in query_tokens:
        pattern = re.escape(token) if "一" <= token[0] <= "鿿" else rf"(?<![a-z0-9_+#]){re.escape(token)}(?![a-z0-9_+#])"
        match = re.search(pattern, text.lower())
        if match:
            matches.append(match.start())
    candidates = {0, *(max(0, min(position - width // 3, len(text) - width)) for position in matches)}
    start = max(candidates, key=lambda candidate: (sum(candidate <= position < candidate + width for position in matches), -candidate))
    stop = min(len(text), start + width)
    return ("…" if start else "") + text[start:stop] + ("…" if stop < len(text) else "")


def search(query: str, project_ids: list[str] | tuple[str, ...], *, limit: int = 3, max_chars: int = 6000) -> list[dict[str, Any]]:
    project_ids = list(dict.fromkeys(project_ids))[:MAX_PROJECTS]
    query_tokens = set(sorted(tokens(query[:8000]))[:64])
    limit, max_chars = min(3, max(0, limit)), min(6000, max(0, max_chars))
    if not project_ids or not query_tokens or not limit or max_chars < 250:
        return []
    path = _database_path()
    if not path.is_file():
        return []
    encoded = " OR ".join('"' + token.encode("utf-8").hex() + '"' for token in sorted(query_tokens))
    placeholders = ",".join("?" for _ in project_ids)
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(f"""SELECT c.id,c.text,c.heading,c.start_line,c.end_line,d.project_id,d.relative_path,p.name AS project_name
                FROM knowledge_fts JOIN knowledge_chunks c ON c.id=knowledge_fts.chunk_id
                JOIN knowledge_documents d ON d.id=c.document_id AND d.version=c.version
                JOIN knowledge_projects p ON p.id=d.project_id
                WHERE knowledge_fts MATCH ? AND d.project_id IN ({placeholders})
                ORDER BY bm25(knowledge_fts),c.id LIMIT 60""", (encoded, *project_ids)).fetchall()
    except (OSError, sqlite3.Error):
        return []
    result = []
    chinese = {token for token in query_tokens if "一" <= token[0] <= "鿿"}
    for row in rows:
        overlap = query_tokens & tokens(row["relative_path"] + "\n" + row["heading"] + "\n" + row["text"])
        if not overlap or (not overlap - chinese and len(chinese) >= 3 and len(overlap) < 2):
            continue
        if len(overlap) / len(query_tokens) < 0.25:
            continue
        hit = {"id": str(row["id"]), "kind": "document", "project_id": row["project_id"], "project_name": row["project_name"],
               "relative_path": row["relative_path"], "heading": row["heading"], "start_line": row["start_line"], "end_line": row["end_line"], "text": row["text"]}
        used = sum(len(json.dumps(item, ensure_ascii=False)) for item in result)
        budget = max_chars - used
        metadata = len(json.dumps({**hit, "text": ""}, ensure_ascii=False))
        if budget <= metadata + 40:
            continue
        hit["text"] = _excerpt(hit["text"], query_tokens, budget - metadata)
        while len(json.dumps(hit, ensure_ascii=False)) > budget:
            hit["text"] = hit["text"][:-1]
        result.append(hit)
        if len(result) >= limit:
            break
    return result
