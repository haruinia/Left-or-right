// 本地知识库：从会话记录自动提取知识点，支持搜索、标签和导出。
// 结构: { id, question, answer, tags, sourceSessionId, createdAt, reviewCount, lastReviewedAt }
// 存储在 localStorage，key 为 liuwa_knowledge_base

const KB_KEY = "liuwa_knowledge_base";
const MAX_ITEMS = 500;

function loadKB() {
  try {
    const raw = localStorage.getItem(KB_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveKB(items) {
  try {
    const trimmed = items.slice(-MAX_ITEMS);
    localStorage.setItem(KB_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

function makeId() {
  return `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 从会话记录提取知识点：简单策略——用户提问 + AI 回答配对
export function extractKnowledgeFromSession(record) {
  if (!record || !record.turns || record.turns.length < 2) return [];
  const items = [];
  for (let i = 0; i < record.turns.length - 1; i += 2) {
    const userTurn = record.turns[i];
    const assistantTurn = record.turns[i + 1];
    if (userTurn.role !== "user" || assistantTurn.role !== "assistant") continue;
    // 跳过太短的问答（可能是闲聊）
    if (userTurn.text.length < 5 || assistantTurn.text.length < 20) continue;
    items.push({
      id: makeId(),
      question: userTurn.text.slice(0, 2000),
      answer: assistantTurn.text.slice(0, 8000),
      tags: guessTags(userTurn.text + " " + assistantTurn.text),
      sourceSessionId: record.id,
      createdAt: record.endedAt || new Date().toISOString(),
      reviewCount: 0,
      lastReviewedAt: null,
    });
  }
  return items;
}

// 简单的标签猜测：基于关键词匹配
function guessTags(text) {
  const tagMap = {
    "算法": ["算法", "复杂度", "排序", "查找", "动态规划", "贪心", "递归", "回溯"],
    "数据结构": ["链表", "树", "图", "栈", "队列", "哈希", "堆", "数组", "字符串"],
    "前端": ["React", "Vue", "CSS", "HTML", "JavaScript", "TypeScript", "DOM", "浏览器"],
    "后端": ["API", "数据库", "SQL", "缓存", "消息队列", "微服务", "分布式"],
    "系统设计": ["架构", "设计", "扩展", "高并发", "可用性", "一致性"],
    "网络": ["HTTP", "TCP", "UDP", "DNS", "CDN", "负载均衡"],
    "操作系统": ["进程", "线程", "内存", "锁", "调度", "文件系统"],
    "编程语言": ["Python", "Java", "Go", "C++", "Rust", "语法"],
    "面试": ["面试", "笔试", "算法题", "编程题"],
    "数据库": ["MySQL", "Redis", "MongoDB", "索引", "事务", "范式"],
  };
  const tags = new Set();
  const lower = text.toLowerCase();
  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) {
      tags.add(tag);
    }
  }
  return Array.from(tags);
}

// 批量导入会话记录到知识库
export function importSessionRecords(records) {
  const kb = loadKB();
  let imported = 0;
  for (const record of records) {
    const items = extractKnowledgeFromSession(record);
    // 去重：相同 question 的前 100 字符
    for (const item of items) {
      const exists = kb.some(
        (existing) => existing.question.slice(0, 100) === item.question.slice(0, 100)
      );
      if (!exists) {
        kb.push(item);
        imported += 1;
      }
    }
  }
  saveKB(kb);
  return imported;
}

export function listKnowledgeItems({ tag, search, limit = 100 } = {}) {
  let items = loadKB().reverse(); // 最新在前
  if (tag) {
    items = items.filter((item) => item.tags.includes(tag));
  }
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(
      (item) =>
        item.question.toLowerCase().includes(q) ||
        item.answer.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  return items.slice(0, limit);
}

export function getKnowledgeItem(id) {
  return loadKB().find((item) => item.id === id) || null;
}

export function deleteKnowledgeItem(id) {
  const items = loadKB().filter((item) => item.id !== id);
  return saveKB(items);
}

export function listTags() {
  const items = loadKB();
  const tagCounts = new Map();
  for (const item of items) {
    for (const tag of item.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// 标记为已复习（用于间隔重复）
export function markReviewed(id) {
  const items = loadKB();
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  item.reviewCount = (item.reviewCount || 0) + 1;
  item.lastReviewedAt = new Date().toISOString();
  return saveKB(items);
}

// 导出知识库为 JSON
export function exportKnowledgeBase() {
  const items = loadKB();
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-kb-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 导出为 Markdown，按标签分组
export function exportKnowledgeBaseAsMarkdown() {
  const items = loadKB().reverse();
  let md = "# 左右 · 本地知识库\n\n";
  const byTag = new Map();
  for (const item of items) {
    for (const tag of item.tags.length ? item.tags : ["未分类"]) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(item);
    }
  }
  for (const [tag, tagItems] of byTag) {
    md += `## ${tag} (${tagItems.length})\n\n`;
    for (const item of tagItems) {
      md += `### Q: ${item.question.slice(0, 100)}${item.question.length > 100 ? "…" : ""}\n\n`;
      md += `${item.answer}\n\n`;
      md += `> 来源: ${new Date(item.createdAt).toLocaleDateString()} · 复习 ${item.reviewCount} 次\n\n---\n\n`;
    }
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liuwa-kb-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// 统计
export function getKBStats() {
  const items = loadKB();
  const tags = listTags();
  const totalReviews = items.reduce((sum, i) => sum + (i.reviewCount || 0), 0);
  const reviewed = items.filter((i) => i.reviewCount > 0).length;
  return {
    totalItems: items.length,
    totalTags: tags.length,
    totalReviews,
    reviewedItems: reviewed,
    unreviewedItems: items.length - reviewed,
  };
}
