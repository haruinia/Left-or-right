from __future__ import annotations

from collections.abc import Callable
from ipaddress import ip_address
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from services.document_service.service import KNOWLEDGE_MAX_BYTES
from services.knowledge_service import store

on_project_deleted: Callable[[str], None] | None = None


def _require_local_settings(request: Request) -> None:
    try:
        local = request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    allowed = local and request.url.hostname in {"127.0.0.1", "localhost", "::1"}
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            allowed = allowed and (
                parsed.scheme == request.url.scheme and parsed.hostname == request.url.hostname
                and (parsed.port or (443 if parsed.scheme == "https" else 80)) == (request.url.port or (443 if request.url.scheme == "https" else 80))
                and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
                and parsed.path in {"", "/"}
            )
        except ValueError:
            allowed = False
    if not allowed or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "知识库只能在本机设置页面操作。")


class _PrivateResponse(JSONResponse):
    def __init__(self, *args, **kwargs):
        headers = {**(kwargs.pop("headers", None) or {}), "Cache-Control": "no-store", "Pragma": "no-cache"}
        super().__init__(*args, headers=headers, **kwargs)


router = APIRouter(prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(_require_local_settings)], default_response_class=_PrivateResponse)


class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class FinishInput(BaseModel):
    replace: bool = False
    preserve_paths: list[str] = Field(default_factory=list, max_length=1000)


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except store.KnowledgeError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/capabilities")
def capabilities():
    return _call(store.capabilities)


@router.get("/projects")
def list_projects():
    return {"projects": _call(store.list_projects)}


@router.post("/projects")
def create_project(body: ProjectInput):
    return {"project": _call(store.create_project, body.name)}


@router.get("/projects/{project_id}")
def project_detail(project_id: str):
    return _call(store.project_detail, project_id)


@router.patch("/projects/{project_id}")
def rename_project(project_id: str, body: ProjectInput):
    return {"project": _call(store.rename_project, project_id, body.name)}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    _call(store.project_detail, project_id)
    if on_project_deleted is not None:
        try:
            on_project_deleted(project_id)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "资料选择保存失败，项目尚未删除，请重试。") from exc
    _call(store.delete_project, project_id)
    return {"ok": True}


@router.get("/projects/{project_id}/documents/{document_id}")
def document_detail(project_id: str, document_id: str):
    return {"document": _call(store.document_detail, project_id, document_id)}


@router.delete("/projects/{project_id}/documents/{document_id}")
def delete_document(project_id: str, document_id: str):
    _call(store.delete_document, project_id, document_id)
    return {"ok": True}


@router.post("/projects/{project_id}/imports")
def begin_import(project_id: str):
    return {"import_id": _call(store.begin_import, project_id)}


async def _read_form(request: Request):
    limit = KNOWLEDGE_MAX_BYTES + 64 * 1024
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise HTTPException(400, "文件请求长度无效。") from exc
    if declared > limit:
        raise HTTPException(413, "单个文件不能超过 5 MiB。")
    if not request.headers.get("content-type", "").lower().startswith("multipart/form-data;"):
        raise HTTPException(415, "请选择文件上传。")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "单个文件不能超过 5 MiB。")
        body.extend(chunk)
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": bytes(body), "more_body": False}

    bounded = Request(request.scope, receive)
    try:
        return await bounded.form(max_files=1, max_fields=1, max_part_size=KNOWLEDGE_MAX_BYTES)
    except Exception as exc:
        raise HTTPException(422, "文件上传格式无效，请重新选择。") from exc


@router.post("/projects/{project_id}/imports/{import_id}/files")
async def stage_file(project_id: str, import_id: str, request: Request):
    form = await _read_form(request)
    try:
        relative_path, file = form.get("relative_path"), form.get("file")
        if not isinstance(relative_path, str) or not isinstance(file, UploadFile) or len(form.multi_items()) != 2:
            raise HTTPException(422, "上传必须包含一个文件及相对路径。")
        data = await file.read(KNOWLEDGE_MAX_BYTES + 1)
        return await run_in_threadpool(_call, store.stage_file, project_id, import_id, relative_path, data)
    finally:
        await form.close()


@router.post("/projects/{project_id}/imports/{import_id}/finish")
def finish_import(project_id: str, import_id: str, body: FinishInput):
    return _call(store.finish_import, project_id, import_id, replace=body.replace, preserve_paths=body.preserve_paths)


@router.delete("/projects/{project_id}/imports/{import_id}")
def cancel_import(project_id: str, import_id: str):
    _call(store.cancel_import, project_id, import_id)
    return {"ok": True}
