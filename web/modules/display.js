const opacityInput = document.querySelector('#liuwaOpacity');
const opacityValue = document.querySelector('#liuwaOpacityValue');
const layoutInput = document.querySelector('#liuwaLayout');
const compactButton = document.querySelector('#liuwaCompact');
const status = document.querySelector('#liuwaDisplayStatus');
const readingInput = document.querySelector('#liuwaReadingFontSize');
const zoomInput = document.querySelector('#liuwaZoom');
const displayBridge = window.appearanceBridge || window.cockpit;
let current = {opacity: .9, layout: 'narrow', compact: true, theme:'light', answer:false, readingFontSize:18, zoomFactor:1};
let confirmed = {...current};
let revision = -1;
let requestId = 0;
const pending = new Map();

export function applyDisplay(display = {}) {
  // getConfig, surface events and IPC replies can arrive after a newer change.
  if (!Number.isFinite(display.revision) || display.revision >= revision) {
    if (Number.isFinite(display.revision)) revision = display.revision;
    confirmed = {...confirmed, ...display};
  }
  current = {...confirmed, ...Object.fromEntries([...pending].map(([key, item]) => [key, item.value]))};
  const opacity = Math.max(0, Math.min(1, Number.isFinite(Number(current.opacity)) ? Number(current.opacity) : .9));
  document.documentElement.style.setProperty('--panel-opacity', opacity);
  document.documentElement.dataset.layout = current.layout;
  document.documentElement.dataset.theme = current.theme;
  const readingFontSize = [16,18,20,22,24].includes(current.readingFontSize) ? current.readingFontSize : 18;
  const zoomFactor = Number.isFinite(current.zoomFactor) ? Math.max(.7, Math.min(1.6, current.zoomFactor)) : 1;
  document.documentElement.style.setProperty('--reading-font-size', `${readingFontSize / 16}rem`);
  if (!displayBridge) document.documentElement.style.zoom = String(zoomFactor);
  if (readingInput) readingInput.value = String(readingFontSize);
  if (zoomInput) zoomInput.value = String(zoomFactor);
  document.body.classList.toggle('liuwa-compact', Boolean(current.compact));
  const transparent = current.theme.startsWith('transparent-');
  if (opacityInput) {opacityInput.value = String(transparent ? 0 : Math.round(opacity * 100));opacityInput.disabled=transparent;}
  if (opacityValue) opacityValue.textContent = transparent ? '全透明' : `${Math.round(opacity * 100)}%`;
  document.querySelectorAll('[data-theme-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeMode===current.theme)));
  if (layoutInput) layoutInput.value = current.layout;
  if (compactButton) {compactButton.textContent = current.compact ? '展开回答' : '收起回答';compactButton.disabled=!current.answer;}
}

async function updateDisplay(patch) {
  const id = ++requestId;
  for (const [key, value] of Object.entries(patch)) pending.set(key, {id, value});
  const release = () => {
    for (const key of Object.keys(patch)) if (pending.get(key)?.id === id) pending.delete(key);
  };
  applyDisplay();
  try {
    if (displayBridge?.setDisplay) {
      const result = await displayBridge.setDisplay(patch);
      release();
      applyDisplay(result);
      if (status && id === requestId) status.textContent = result.saved === false ? '本次已应用，偏好保存失败。' : '';
    } else {
      localStorage.setItem('liuwa.display', JSON.stringify(current));
      release();
      applyDisplay(patch);
      if (status) status.textContent = '';
    }
  } catch {
    release();
    applyDisplay();
    if (status && id === requestId) status.textContent = '显示设置未能应用，请重试。';
  }
}

opacityInput?.addEventListener('input', () => updateDisplay({opacity: Number(opacityInput.value) / 100}));
layoutInput?.addEventListener('change', () => updateDisplay({layout: layoutInput.value, compact: false}));
compactButton?.addEventListener('click', () => updateDisplay({compact: !current.compact}));
document.querySelectorAll('[data-theme-mode]').forEach(button=>button.addEventListener('click',()=>updateDisplay({theme:button.dataset.themeMode})));
readingInput?.addEventListener('change', () => updateDisplay({readingFontSize: Number(readingInput.value)}));
zoomInput?.addEventListener('change', () => updateDisplay({zoomFactor: Number(zoomInput.value)}));
document.querySelector('#liuwaDisplayReset')?.addEventListener('click', () => updateDisplay({readingFontSize:18, zoomFactor:1}));
displayBridge?.onDisplay?.(applyDisplay);
if (!displayBridge) {
  const restore = () => {
    try { applyDisplay(JSON.parse(localStorage.getItem('liuwa.display') || '{}')); } catch { applyDisplay(); }
  };
  restore();
  window.addEventListener?.('storage', event => { if (event.key === 'liuwa.display') restore(); });
} else {
  applyDisplay();
  if (window.appearanceBridge) window.appearanceBridge.getDisplay().then(applyDisplay).catch(() => {
    if (status) status.textContent = '显示设置读取失败，请重新打开此页。';
  });
}
