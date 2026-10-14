// 回答反馈存储：记录用户对 AI 回答的 👍/👎 反馈，用于改进提示词和评估质量。
// 结构: { id, answerText, feedbackType, questionText, timestamp, model, preset }

const FEEDBACK_KEY = "liuwa_answer_feedback";
const MAX_FEEDBACK = 500;

function loadFeedback() {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFeedbackList(items) {
  try {
    const trimmed = items.slice(-MAX_FEEDBACK);
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

function makeId() {
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 保存一条反馈
export function saveFeedback({ answerText, feedbackType, questionText = "", model = "", preset = "" }) {
  const items = loadFeedback();
  const item = {
    id: makeId(),
    answerText: String(answerText || "").slice(0, 4000),
    questionText: String(questionText || "").slice(0, 1000),
    feedbackType, // "up" | "down"
    model,
    preset,
    timestamp: new Date().toISOString(),
  };
  items.push(item);
  if (saveFeedbackList(items)) {
    return item;
  }
  return null;
}

// 获取反馈统计
export function getFeedbackStats() {
  const items = loadFeedback();
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
export function listRecentNegativeFeedback(limit = 20) {
  return loadFeedback()
    .filter((i) => i.feedbackType === "down")
    .reverse()
    .slice(0, limit);
}

// 导出为 Markdown
export function exportFeedbackAsMarkdown() {
  const items = loadFeedback().reverse();
  let md = "# 左右 · 回答反馈记录\n\n";
  md += `> 共 ${items.length} 条反馈，导出时间：${new Date().toLocaleString("zh-CN")}\n\n`;

  const stats = getFeedbackStats();
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
export function clearFeedback() {
  try {
    localStorage.removeItem(FEEDBACK_KEY);
    return true;
  } catch {
    return false;
  }
}
