// 回答翻页（对齐 Gank 的 solution-panel 实际实现）：
// Gank 的「上一页 / 下一页」不是切换内容，是按视口高度滚动——
//
//   const step = Math.min(clientHeight, Math.max(0.85 * clientHeight, 200));
//   box.scrollBy({ top: ±step, behavior: "smooth" });
//
// 它没有分段、没有标签页，也没有页码；中间那行是「使用 X 或 Y 上下滚动」。
// 翻页只移动正文，不切换题目或语义小节。

const thread = () => document.querySelector("#liuwaThread");

// 主面板始终只有当前答案，无论它是否已溢出，都使用同一个正文容器。
// 不能在内容增长时动态换容器，否则分页位置和滚动高度会发生跳变。
export function readingBox() {
  const outer = thread();
  if (!outer) return null;
  return outer.querySelector(".liuwa-stream") || outer;
}

const step = () => {
  const box = readingBox();
  if (!box) return 0;
  const h = box.clientHeight || 300;
  return Math.min(h, Math.max(0.85 * h, 200));
};

function atTop(box) {
  return box.scrollTop <= 1;
}

function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 1;
}

// 翻页并在页尾/页首时把边界状态回给调用方，用来提示「已经到头了」。
export function page(direction) {
  const box = readingBox();
  if (!box) return;
  const delta = step() * (direction < 0 ? -1 : 1);
  box.scrollBy({ top: delta, behavior: "smooth" });
}

export function scrollByScreen(fraction = 0.85) {
  const box = readingBox();
  if (!box) return;
  box.scrollBy({ top: box.clientHeight * fraction, behavior: "smooth" });
}

// 本产品的新题明确从开头读；Gank MV 没有显式复位，不能把此策略当作其运行证据。
export function resetReading() {
  const box = readingBox();
  if (box) box.scrollTop = 0;
}

export function isAtTop() {
  const box = readingBox();
  return box ? atTop(box) : true;
}

export function isAtBottom() {
  const box = readingBox();
  return box ? atBottom(box) : true;
}
