// 两点式框选（对齐 Gank 的 area-screenshot）：
// 第一下点定一个角，第二下点定对角，矩形就定了——不是按住拖。
//
// 刻意不做任何反馈：不画选框、不画角点、不显示尺寸、不动系统光标。
// 覆盖层只负责记录两次点击的坐标；点歪了按 Esc 或右键取消，重新按快捷键即可。

let first = null; // { x, y } 第一下点击的屏幕坐标（CSS 像素）

function corners(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

document.addEventListener("mousedown", (event) => {
  event.preventDefault();
  if (event.button === 2) {
    window.__liuwaSelect?.cancel();
    return;
  }
  if (event.button !== 0) return;
  const point = { x: event.clientX, y: event.clientY };

  if (!first) {
    first = point;
    return;
  }

  const rect = corners(first, point);
  // 两次点在同一处（或一条线上）说明是误触：按 Gank 的做法直接放弃这次截图，
  // 而不是让用户猜"选区太小"之后还要再点两下。
  if (rect.width < 4 || rect.height < 4) {
    window.__liuwaSelect?.cancel();
    return;
  }
  window.__liuwaSelect?.commit(rect);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.__liuwaSelect?.cancel();
  }
});

// 兜底：窗口失焦（用户切走了）也算取消，避免覆盖层一直悬在屏幕上。
window.addEventListener("blur", () => {
  window.__liuwaSelect?.cancel();
});
