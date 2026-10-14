// 会话记录：每次「新对话」时把当前轮次保存到 localStorage，支持回看和导出。
// 结构: { id, startedAt, endedAt, turns: [{role, text, images?}], note }
// images 只存缩略图 dataUrl（如果太大则只存数量），避免 localStorage 爆掉。

const STORAGE_KEY = "liuwa_session_records";
const MAX_RECORDS = 100;

function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords(records) {
  try {
    // 保留最近 MAX_RECORDS 条，避免无限增长
    const trimmed = records.slice(-MAX_RECORDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

function makeRecordId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 压缩图片到缩略图（最大 200px 宽，质量 0.6）
function compressImage(dataUrl, maxWidth = 200, quality = 0.6) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, maxWidth / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl.slice(0, 500)); // 失败则截断
    img.src = dataUrl;
  });
}

// 把一轮对话保存为一条记录
export async function saveSessionRecord({ turns, note, startedAt }) {
  if (!turns || !turns.length) return null;
  const records = loadRecords();
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
        images: thumbnails,
        imageCount: images.length,
      };
    })),
  };
  records.push(record);
  if (saveRecords(records)) {
    return record;
  }
  return null;
}

export function listSessionRecords() {
  return loadRecords().reverse(); // 最新的在前面
}

export function getSessionRecord(id) {
  return loadRecords().find((r) => r.id === id) || null;
}

export function deleteSessionRecord(id) {
  const records = loadRecords().filter((r) => r.id !== id);
  return saveRecords(records);
}

export function clearSessionRecords() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// 导出为 JSON 文件
export function exportSessionRecords() {
  const records = loadRecords();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 导出为 Markdown，方便粘贴到笔记软件
export function exportSessionRecordsAsMarkdown() {
  const records = loadRecords().reverse();
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
