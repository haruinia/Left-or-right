from __future__ import annotations

import io
import mimetypes
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from time import monotonic
from typing import Literal
from xml.etree import ElementTree

from pydantic import BaseModel, Field

from libs.common.config import get_settings
from libs.llm_client import LLMMessage, get_llm_client

DocumentKind = Literal["jd", "resume"]

TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".json", ".csv", ".log"}
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}
DOC_SUFFIXES = {".doc"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic"}
PDF_MIME_TYPES = {"application/pdf"}
DOCX_MIME_TYPES = {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
DOC_MIME_TYPES = {"application/msword"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
KNOWLEDGE_TEXT_SUFFIXES = frozenset({
    ".md", ".markdown", ".txt", ".rst", ".json", ".jsonl", ".csv", ".log",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".xml", ".html", ".css", ".scss",
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".kts", ".sql",
    ".sh", ".bash", ".zsh", ".vue", ".svelte",
})
KNOWLEDGE_SUFFIXES = KNOWLEDGE_TEXT_SUFFIXES | {".pdf", ".docx"}
KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024
KNOWLEDGE_MAX_CHARS = 200000


def extract_local_document(filename: str, data: bytes) -> str:
    if not data or len(data) > KNOWLEDGE_MAX_BYTES:
        raise ValueError("文件为空或超过 5 MiB。")
    suffix = Path(filename).suffix.lower()
    if suffix in KNOWLEDGE_TEXT_SUFFIXES:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            try:
                text = data.decode("utf-16")
            except UnicodeDecodeError as exc:
                raise ValueError("文本编码无法读取。") from exc
        else:
            text = _decode_text(data, preserve_whitespace=True)
        if "\x00" in text or any(ord(char) < 32 and char not in "\t\n\r" for char in text):
            raise ValueError("文件包含二进制内容，不作为文本导入。")
    elif suffix == ".docx":
        text = _extract_docx(data, bounded=True)
    elif suffix == ".pdf":
        text = _extract_pdf(data, bounded=True)
    else:
        raise ValueError("此文件类型不支持本地导入。")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise ValueError("未提取到文本。")
    if len(text) > KNOWLEDGE_MAX_CHARS:
        raise ValueError("文档正文超过 200,000 字符。")
    return text


class DocumentParseResult(BaseModel):
    filename: str
    kind: DocumentKind
    text: str = Field(min_length=1)
    source: str
    llm_attempted: bool = False
    used_llm: bool = False
    warning: str = ""


class _CleanedDocument(BaseModel):
    text: str = Field(min_length=1)


def parse_document(
    filename: str,
    data: bytes,
    *,
    kind: DocumentKind,
    content_type: str = "",
) -> DocumentParseResult:
    if not data:
        raise ValueError("uploaded document is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("uploaded document is larger than 25MB")
    suffix = Path(filename).suffix.lower()
    inferred_content_type = _normalize_content_type(
        content_type or mimetypes.guess_type(filename)[0] or ""
    )
    raw_text, source, warning = _extract_text(filename, data, suffix, inferred_content_type)
    cleaned_text, llm_attempted, used_llm, cleanup_warning = _clean_with_llm(raw_text, kind=kind)
    return DocumentParseResult(
        filename=filename or "upload",
        kind=kind,
        text=cleaned_text,
        source=source,
        llm_attempted=llm_attempted,
        used_llm=used_llm,
        warning=_combine_warnings(warning, cleanup_warning),
    )


def _extract_text(
    filename: str,
    data: bytes,
    suffix: str,
    content_type: str,
) -> tuple[str, str, str]:
    if suffix in TEXT_SUFFIXES or content_type.startswith("text/"):
        return _decode_text(data), "text", ""
    if suffix in DOCX_SUFFIXES or content_type in DOCX_MIME_TYPES:
        return _extract_docx(data), "docx", ""
    if suffix in PDF_SUFFIXES or content_type in PDF_MIME_TYPES:
        return _extract_pdf(data), "pdf", ""
    if suffix in IMAGE_SUFFIXES or content_type.startswith("image/"):
        return _extract_image_text(data, suffix), "image_ocr", ""
    if suffix in DOC_SUFFIXES or content_type in DOC_MIME_TYPES:
        return _extract_doc_with_textutil(data, suffix), "doc_textutil", ""
    raise ValueError(
        "unsupported document type; supported: txt, md, json, csv, log, pdf, docx, doc, png, jpg, jpeg, webp, bmp, tif, tiff, heic"
    )


def _normalize_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _decode_text(data: bytes, *, preserve_whitespace: bool = False) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            text = data.decode(encoding)
            _require_text(text)
            return text if preserve_whitespace else text.strip()
        except UnicodeDecodeError:
            continue
    raise ValueError("text document encoding is not supported")


def _extract_docx(data: bytes, *, bounded: bool = False) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if bounded:
                entries = archive.infolist()
                if len(entries) > 2000 or sum(item.file_size for item in entries) > 20 * 1024 * 1024:
                    raise ValueError("DOCX 解包大小或条目数超过限制。")
                document = archive.getinfo("word/document.xml")
                if document.file_size > 5 * 1024 * 1024 or document.file_size > max(1, document.compress_size) * 200:
                    raise ValueError("DOCX 正文解包大小或压缩比超过限制。")
            xml = archive.read("word/document.xml")
        if bounded and re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", xml.replace(b"\x00", b""), re.IGNORECASE):
            raise ValueError("DOCX 正文包含不支持的 XML 声明。")
        root = ElementTree.fromstring(xml)
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise ValueError("docx document is invalid or unreadable") from exc
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        parts = [node.text or "" for node in paragraph.iter(f"{namespace}t")]
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return _require_text("\n".join(paragraphs))


def _extract_pdf(data: bytes, *, bounded: bool = False) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("PDF parsing requires pypdf; install project dependencies first") from exc
    try:
        deadline = monotonic() + 10
        reader = PdfReader(io.BytesIO(data))
        if bounded and len(reader.pages) > 200:
            raise ValueError("PDF 超过 200 页。")
        texts = []
        characters = 0
        for page in reader.pages:
            if bounded and monotonic() > deadline:
                raise ValueError("PDF 本地提取超时。")
            text = (page.extract_text() or "").strip()
            if bounded and monotonic() > deadline:
                raise ValueError("PDF 本地提取超时。")
            characters += len(text)
            if bounded and characters > KNOWLEDGE_MAX_CHARS:
                raise ValueError("PDF 正文超过 200,000 字符。")
            texts.append(text)
    except Exception as exc:
        raise ValueError("pdf document is invalid or unreadable") from exc
    text = "\n".join(text for text in texts if text).strip()
    if not text:
        raise ValueError(
            "pdf text could not be extracted; upload a text PDF/DOCX, enable OCR for image "
            "documents, or paste the resume text directly"
        )
    return text


def extract_image_text(data: bytes, suffix: str) -> str:
    """Public alias; the exam service reuses this OCR path as its vision fallback."""
    return _extract_image_text(data, suffix)


def _extract_image_text(data: bytes, suffix: str) -> str:
    try:
        from ocrmac import OCR
    except ImportError as exc:
        raise ValueError(
            "image OCR requires optional dependency ocrmac on macOS; install with "
            "`pip install -e '.[ocr]'`, or upload a PDF/DOCX/text resume instead"
        ) from exc
    with tempfile.NamedTemporaryFile(suffix=suffix or ".png") as file:
        file.write(data)
        file.flush()
        try:
            ocr = OCR(file.name)
            annotations = ocr.recognize()
        except Exception as exc:
            raise ValueError(
                "image OCR failed; upload a clearer image, a text PDF/DOCX, or paste the "
                "resume text directly"
            ) from exc
    lines = [str(item[0]).strip() for item in annotations if item and str(item[0]).strip()]
    text = "\n".join(lines).strip()
    if not text:
        raise ValueError(
            "image OCR did not detect text; upload a clearer image, a text PDF/DOCX, or paste "
            "the resume text directly"
        )
    return text


def _extract_doc_with_textutil(data: bytes, suffix: str) -> str:
    with tempfile.TemporaryDirectory() as directory:
        input_path = Path(directory) / f"upload{suffix or '.doc'}"
        output_path = Path(directory) / "upload.txt"
        input_path.write_bytes(data)
        try:
            subprocess.run(
                ["textutil", "-convert", "txt", "-output", str(output_path), str(input_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ValueError(
                "legacy .doc parsing requires macOS textutil and a readable Word document; "
                "if it fails, convert the file to .docx or PDF and upload again"
            ) from exc
        return _require_text(output_path.read_text(encoding="utf-8", errors="ignore"))


def _clean_with_llm(text: str, *, kind: DocumentKind) -> tuple[str, bool, bool, str]:
    fallback = _CleanedDocument(text=_trim_text(text))
    settings = get_settings()
    if settings.llm_provider == "mock" or not settings.llm_api_key:
        return fallback.text, False, False, ""
    label = "岗位 JD" if kind == "jd" else "候选人简历"
    prompt = (
        f"请从下面的{label}上传内容中提取可用于面试系统的正文。"
        "删除页眉页脚、乱码、重复水印、目录噪声和无意义符号；保留岗位要求、项目经历、技能、职责、成果指标等事实。"
        "不要编造原文没有的信息。只返回 JSON：{\"text\":\"...\"}。"
    )
    try:
        cleaned = get_llm_client().complete_json_sync(
            [
                LLMMessage(role="system", content="你是严谨的招聘资料解析器，只做信息提取和去噪。"),
                LLMMessage(role="user", content=f"{prompt}\n\n原始内容：\n{text[:12000]}"),
            ],
            _CleanedDocument,
            fallback,
            raise_on_error=True,
        )
    except Exception as exc:
        return (
            fallback.text,
            True,
            False,
            _llm_cleanup_warning(exc),
        )
    cleaned_text = _trim_text(cleaned.text)
    return cleaned_text, True, cleaned_text != fallback.text, ""


def _combine_warnings(*warnings: str) -> str:
    return " ".join(warning.strip() for warning in warnings if warning.strip())


def _llm_cleanup_warning(exc: Exception) -> str:
    detail = str(exc)
    match = re.search(r"\bHTTP\s+(\d{3})\b", detail)
    status = f"HTTP {match.group(1)}，" if match else ""
    return f"DeepSeek 文档清洗失败，已使用原始解析文本。{status}请检查模型配置、额度或网络。"


def _trim_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    collapsed: list[str] = []
    previous = ""
    for line in lines:
        if not line:
            if previous:
                collapsed.append("")
            previous = ""
            continue
        if line == previous:
            continue
        collapsed.append(line)
        previous = line
    return _require_text("\n".join(collapsed).strip())


def _require_text(text: str) -> str:
    value = text.strip()
    if not value:
        raise ValueError("document text could not be extracted")
    return value
