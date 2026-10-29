// 笔试记录：每次截图提问保存题目缩略图、发送内容与模型回答，便于回看与整理。
import { createAssetStore } from "./asset-storage.js";

const store = createAssetStore("exams", "liuwa_exam_records");

function makeRecordId() {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function compressImage(dataUrl, maxWidth = 260, quality = 0.62) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export async function saveExamRecord({
  images = [],
  query = "",
  answer = "",
  model = "",
  partial = false,
  startedAt = "",
}) {
  if (!answer.trim() && !images.length) return null;
  const thumbnails = await Promise.all(images.slice(0, 3).map((img) => compressImage(img)));
  const record = {
    id: makeRecordId(),
    createdAt: new Date().toISOString(),
    startedAt: startedAt || "",
    model: String(model || ""),
    query: String(query || "").slice(0, 8000),
    answer: String(answer || "").slice(0, 40000),
    partial: Boolean(partial),
    imageCount: images.length,
    images: thumbnails.filter(Boolean),
  };
  return store.put(record);
}

export async function listExamRecords() {
  return (await store.list()).reverse();
}

export function deleteExamRecord(id) {
  return store.remove(id);
}

export async function exportExamRecordsAsMarkdown() {
  const records = await listExamRecords();
  let md = "# 左右 · 笔试记录\n\n";
  for (const record of records) {
    md += `## ${new Date(record.createdAt).toLocaleString()}\n\n`;
    if (record.model) md += `*模型：${record.model}*\n\n`;
    if (record.imageCount) md += `*（含 ${record.imageCount} 张题图）*\n\n`;
    if (record.query) md += `**问** ${record.query}\n\n`;
    md += `**答** ${record.answer}\n\n`;
    if (record.partial) md += "> 该回答生成中断，内容不完整。\n\n";
    md += "---\n\n";
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-exams-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
