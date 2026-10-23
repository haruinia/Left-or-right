// 会话记录：保存到共享本地服务，支持桌面与设置中心回看和导出。
// 结构: { id, startedAt, endedAt, turns: [{role, text, images?}], note }
// images 只存缩略图 dataUrl；历史回看不保存源截图。

import { createAssetStore } from "./asset-storage.js";
const store = createAssetStore("sessions", "liuwa_session_records");

function makeRecordId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 压缩图片到缩略图（最大 200px 宽，质量 0.6）
function compressImage(dataUrl, maxWidth = 200, quality = 0.6) {
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
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null); // 无法解码时只保留原图数量
    img.src = dataUrl;
  });
}

// 把一轮对话保存为一条记录
export async function saveSessionRecord({ turns, note, startedAt }) {
  if (!turns || !turns.length) return null;
  const record = {
    id: makeRecordId(),
    startedAt: startedAt || new Date().toISOString(),
    endedAt: new Date().toISOString(),
    note: note || "",
    turnCount: turns.length,
    turns: await Promise.all(turns.map(async (turn) => {
      const images = turn.images || [];
      // 保存前 3 张压缩后的缩略图
      const thumbnails = await Promise.all(
        images.slice(0, 3).map((img) => compressImage(img))
      );
      return {
        role: turn.role,
        text: String(turn.text || "").slice(0, 12000),
        images: thumbnails.filter(Boolean),
        imageCount: turn.imageCount ?? images.length,
      };
    })),
  };
  return store.put(record);
}

export async function listSessionRecords() {
  return (await store.list()).reverse();
}

export async function getSessionRecord(id) {
  return (await store.list()).find((r) => r.id === id) || null;
}

export function deleteSessionRecord(id) { return store.remove(id); }
export function clearSessionRecords() { return store.clear(); }

// 导出为 JSON 文件
export async function exportSessionRecords() {
  const records = await store.list();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 导出为 Markdown，方便粘贴到笔记软件
export async function exportSessionRecordsAsMarkdown() {
  const records = await listSessionRecords();
  let md = "# 左右 · 会话记录\n\n";
  for (const record of records) {
    md += `## ${new Date(record.startedAt).toLocaleString()}\n\n`;
    if (record.note) md += `> ${record.note}\n\n`;
    for (const turn of record.turns) {
      const label = turn.role === "user" ? "**问**" : "**答**";
      md += `${label} ${turn.text}\n\n`;
      if (turn.imageCount) md += `*（含 ${turn.imageCount} 张截图）*\n\n`;
    }
    md += "---\n\n";
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-sessions-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
