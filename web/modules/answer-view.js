// 对齐 Gank 的 solution-panel：整篇 Markdown 保持模型输出顺序，
// 上一页 / 下一页只滚动正文，不把答案隐藏到小节标签中。
import { renderMarkdown } from "./markdown.js";

export function renderAnswer(markdown, root) {
  if (!root) return;
  const scrollTop = root.scrollTop;
  root.innerHTML = renderMarkdown(markdown);
  root.scrollTop = scrollTop;
}
