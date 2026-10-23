// 截图放大查看：浮窗只有 780×760，整屏截图缩到 128×72 后细节全丢，
// 所以点缩略图在原窗口内铺满一层，滚轮缩放、拖动平移、Esc 关闭。
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const STEP = 1.15;

let overlay = null;
let stage = null;
let imgNode = null;
let counter = null;
let items = [];
let index = 0;
let scale = MIN_SCALE;
let offsetX = 0;
let offsetY = 0;
let drag = null;

function applyTransform() {
  if (!imgNode) return;
  imgNode.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  if (stage) stage.classList.toggle("is-zoomed", scale > MIN_SCALE + 0.001);
}

function resetView() {
  scale = MIN_SCALE;
  offsetX = 0;
  offsetY = 0;
  applyTransform();
}

function showIndex(next) {
  if (!items.length) return;
  index = (next + items.length) % items.length;
  imgNode.src = items[index];
  if (counter) counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
  resetView();
}

function onWheel(event) {
  event.preventDefault();
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (event.deltaY < 0 ? STEP : 1 / STEP)));
  if (Math.abs(next - scale) < 0.001) return;
  scale = next;
  if (scale <= MIN_SCALE + 0.001) {
    offsetX = 0;
    offsetY = 0;
  }
  applyTransform();
}

function onPointerDown(event) {
  if (event.button !== 0 || scale <= MIN_SCALE + 0.001) return;
  drag = { x: event.clientX - offsetX, y: event.clientY - offsetY };
  stage.classList.add("is-dragging");
  stage.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (!drag) return;
  offsetX = event.clientX - drag.x;
  offsetY = event.clientY - drag.y;
  applyTransform();
}

function onPointerUp(event) {
  if (!drag) return;
  drag = null;
  stage.classList.remove("is-dragging");
  stage.releasePointerCapture?.(event.pointerId);
}

function onDoubleClick() {
  scale = scale > MIN_SCALE + 0.001 ? MIN_SCALE : 2;
  if (scale === MIN_SCALE) {
    offsetX = 0;
    offsetY = 0;
  }
  applyTransform();
}

function onKeyDown(event) {
  if (!overlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeLightbox();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (items.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    showIndex(index + (event.key === "ArrowRight" ? 1 : -1));
  }
}

function buildOverlay() {
  overlay = document.createElement("div");
  overlay.className = "liuwa-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "查看截图");

  stage = document.createElement("div");
  stage.className = "liuwa-lightbox-stage";
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("dblclick", onDoubleClick);

  imgNode = document.createElement("img");
  imgNode.alt = "截图";
  imgNode.draggable = false;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "liuwa-lightbox-close";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", closeLightbox);

  counter = document.createElement("span");
  counter.className = "liuwa-lightbox-counter";

  stage.append(imgNode);
  overlay.append(stage, counter, close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeLightbox();
  });
  document.body.append(overlay);
}

export function isLightboxOpen() {
  return Boolean(overlay);
}

export function openLightbox(list, start = 0) {
  const safe = (list || []).filter((src) => typeof src === "string" && src);
  if (!safe.length) return;
  closeLightbox();
  items = safe;
  buildOverlay();
  showIndex(Math.min(Math.max(start, 0), safe.length - 1));
  document.addEventListener("keydown", onKeyDown, true);
  document.body.classList.add("is-lightbox");
}

export function closeLightbox() {
  if (!overlay) return;
  document.removeEventListener("keydown", onKeyDown, true);
  document.body.classList.remove("is-lightbox");
  overlay.remove();
  overlay = null;
  stage = null;
  imgNode = null;
  counter = null;
  items = [];
  index = 0;
  scale = MIN_SCALE;
  offsetX = 0;
  offsetY = 0;
  drag = null;
}
