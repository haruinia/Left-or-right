// 回答翻页（对齐 Gank 的 solution-panel 实际实现）：
// Gank 的「上一页 / 下一页」不是切换内容，是按视口高度滚动——
//
//   const step = Math.min(clientHeight, Math.max(0.85 * clientHeight, 200));
//   box.scrollBy({ top: ±step, behavior: "smooth" });
//
// 它没有分段、没有标签页，也没有页码；中间那行是「使用 X 或 Y 上下滚动」。
// 所以这里也只做滚动：进入新回答时视口复位，翻页就是往前/往后推一屏多一点。

const thread = () => document.querySelector("#liuwaThread");

// 最新回答的卡片自己滚动，外层只负责旧回答。选择视口里真正可滚动的容器，
// 否则长答案看得到滚动条，快捷键却在滚一个没有溢出的外层。
export function readingBox() {
  const outer = thread();
  if (!outer) return null;
  const viewport = outer.getBoundingClientRect();
  let best = outer;
  let overlap = 0;
  for (const node of outer.querySelectorAll(".liuwa-answer-body, .liuwa-stream")) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const rect = node.getBoundingClientRect();
    const visible = Math.max(0, Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top));
    if (visible > overlap) {
      overlap = visible;
      best = node;
    }
  }
  return best;
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

// 新回答开始时把视口拉回开头——Gank 换题也是从顶部开始读。
export function resetReading() {
  const box = thread();
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
