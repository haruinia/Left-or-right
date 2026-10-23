// 回答反馈存储：记录用户对 AI 回答的 👍/👎 反馈，用于改进提示词和评估质量。
// 结构: { id, answerText, feedbackType, questionText, timestamp, model, preset }

import { createAssetStore } from "./asset-storage.js";
const store = createAssetStore("feedback", "liuwa_answer_feedback");

function makeId() {
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 保存一条反馈
export async function saveFeedback({ answerText, feedbackType, questionText = "", model = "", preset = "" }) {
  const item = {
    id: makeId(),
    answerText: String(answerText || "").slice(0, 4000),
    questionText: String(questionText || "").slice(0, 1000),
    feedbackType, // "up" | "down"
    model,
    preset,
    timestamp: new Date().toISOString(),
  };
  return store.put(item);
}

// 获取反馈统计
export async function getFeedbackStats() {
  const items = await store.list();
  const up = items.filter((i) => i.feedbackType === "up").length;
  const down = items.filter((i) => i.feedbackType === "down").length;
  return {
    total: items.length,
    up,
    down,
    upRate: items.length ? Math.round((up / items.length) * 100) : 0,
  };
}

// 获取最近的负面反馈（用于改进）
export async function listRecentNegativeFeedback(limit = 20) {
  return (await store.list())
    .filter((i) => i.feedbackType === "down")
    .reverse()
    .slice(0, limit);
}

// 导出为 Markdown
export async function exportFeedbackAsMarkdown() {
  const items = (await store.list()).reverse();
  let md = "# 左右 · 回答反馈记录\n\n";
  md += `> 共 ${items.length} 条反馈，导出时间：${new Date().toLocaleString("zh-CN")}\n\n`;

  const stats = await getFeedbackStats();
  md += `## 统计\n\n`;
  md += `- 👍 有用：${stats.up} 条\n`;
  md += `- 👎 无用：${stats.down} 条\n`;
  md += `- 好评率：${stats.upRate}%\n\n`;

  md += `## 详细记录\n\n`;
  for (const item of items) {
    const icon = item.feedbackType === "up" ? "👍" : "👎";
    const date = new Date(item.timestamp).toLocaleString("zh-CN");
    md += `### ${icon} ${date}\n\n`;
    if (item.questionText) md += `**问题：** ${item.questionText.slice(0, 200)}\n\n`;
    md += `**回答：** ${item.answerText.slice(0, 500)}${item.answerText.length > 500 ? "…" : ""}\n\n`;
    if (item.model) md += `**模型：** ${item.model}\n\n`;
    md += "---\n\n";
  }

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-feedback-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// 清空反馈
export function clearFeedback() { return store.clear(); }
