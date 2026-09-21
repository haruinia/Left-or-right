import { errorText, fetchGateway, readJsonResponse } from './gateway.js';
import { documentParseTimeoutMs, maxDocumentUploadBytes, state, supportedDocumentMimeTypes, supportedDocumentSuffixes } from './state.js';
import { appendEvent, escapeHtml, setControls } from './ui.js';

async function parseDocumentFile(file, input, target, label, kind) {
  if (!file) return;
  if (!supportedDocumentFile(file)) {
    setUploadInputStatus(input, `${label} 文件格式暂不支持：${file.name}`, "warn");
    appendEvent(
      "资料上传失败",
      `${escapeHtml(label)} 文件格式暂不支持，请上传 txt、md、json、csv、log、pdf、docx、doc 或图片。`,
      "red"
    );
    input.value = "";
    return;
  }
  if (file.size > maxDocumentUploadBytes) {
    setUploadInputStatus(input, `${label} 文件超过 25MB：${file.name}`, "warn");
    appendEvent(
      "资料上传失败",
      `${escapeHtml(label)} 文件超过 25MB，请压缩、拆分或直接粘贴关键内容。`,
      "red"
    );
    input.value = "";
    return;
  }
  appendEvent("资料上传", `${escapeHtml(label)} 正在解析：${escapeHtml(file.name)}`);
  setUploadInputStatus(input, `${label} 正在解析：${file.name}`, "live");
  const documentParseToken = nextDocumentParseToken(input);
  state.documentParsingCount += 1;
  input.disabled = true;
  setControls();
  try {
    const params = new URLSearchParams({ kind, filename: file.name });
    const response = await fetchGateway(`/api/documents/parse?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: await file.arrayBuffer(),
      timeoutMs: documentParseTimeoutMs,
    });
    const result = await readJsonResponse(response, "资料解析响应不是有效 JSON");
    const parsedText = String(result.text || "").trim();
    if (!documentParseStillCurrent(input, documentParseToken)) {
      setUploadInputStatus(input, `${label} 解析已取消：${file.name}`);
      appendEvent("资料上传", `${escapeHtml(label)} 解析已取消：${escapeHtml(file.name)}`);
      return;
    }
    if (!parsedText) {
      setUploadInputStatus(input, `${label} 未提取到可用文本：${file.name}`, "warn");
      appendEvent(
        "资料上传失败",
        `${escapeHtml(label)} 未提取到可用文本，请换成文字版 PDF、DOCX 或直接粘贴内容。`,
        "red"
      );
      return;
    }
    target.value = result.text;
    let modelNote = "";
    if (result.llm_attempted) {
      if (result.used_llm) {
        modelNote = "，已调用 DeepSeek 清洗正文";
      } else if (String(result.warning || "").includes("DeepSeek")) {
        modelNote = "，DeepSeek 清洗未完成";
      } else {
        modelNote = "，已调用 DeepSeek 校验正文";
      }
    }
    appendEvent(
      "资料上传",
      `${escapeHtml(label)} 已解析：${escapeHtml(file.name)}（${escapeHtml(result.source)}${modelNote}）`
    );
    setUploadInputStatus(input, `${label} 已解析：${file.name}`, "ready");
    if (result.warning) {
      appendEvent("资料上传提示", escapeHtml(result.warning), "red");
    }
  } catch (error) {
    if (!documentParseStillCurrent(input, documentParseToken)) return;
    const message = errorText(error);
    setUploadInputStatus(input, `${label} 解析失败：${message}`, "warn");
    appendEvent("资料上传失败", escapeHtml(message), "red");
  } finally {
    state.documentParsingCount = Math.max(0, state.documentParsingCount - 1);
    const parseStillCurrent = documentParseStillCurrent(input, documentParseToken);
    if (parseStillCurrent) {
      delete input.dataset.documentParseToken;
      input.disabled = false;
      input.value = "";
    }
    setControls();
  }
}

function setUploadInputStatus(input, message, tone = "") {
  const text = String(message || "").trim();
  input.title = text;
  const status = document.querySelector(`#${input.id}Status`);
  if (status) {
    status.className = `small upload-status ${tone}`.trim();
    status.textContent = text || "支持 PDF、Word、图片和文本文件。";
  }
}

function nextDocumentParseToken(input) {
  const token = `${state.documentParseEpoch}:${Date.now()}:${Math.random()}`;
  input.dataset.documentParseToken = token;
  return token;
}

function documentParseStillCurrent(input, token) {
  return input.dataset.documentParseToken === token;
}

function cancelDocumentParses() {
  state.documentParseEpoch += 1;
  document.querySelectorAll("[data-document-parse-token]").forEach((input) => {
    delete input.dataset.documentParseToken;
  });
}

function resetDocumentUploadInputs() {
  document.querySelectorAll("#jdFile, #resumeFile").forEach((input) => {
    input.disabled = false;
    input.value = "";
    setUploadInputStatus(input, "");
    delete input.dataset.documentParseToken;
  });
}

function fileSuffix(filename) {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function supportedDocumentFile(file) {
  const type = normalizedContentType(file.type);
  return (
    supportedDocumentSuffixes.has(fileSuffix(file.name)) ||
    supportedDocumentMimeTypes.has(type) ||
    type.startsWith("text/") ||
    type.startsWith("image/")
  );
}

function normalizedContentType(contentType) {
  return String(contentType || "").split(";", 1)[0].trim().toLowerCase();
}


export {
  cancelDocumentParses,
  documentParseStillCurrent,
  fileSuffix,
  nextDocumentParseToken,
  normalizedContentType,
  parseDocumentFile,
  resetDocumentUploadInputs,
  setUploadInputStatus,
  supportedDocumentFile,
};
