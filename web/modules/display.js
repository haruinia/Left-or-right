const opacityInput = document.querySelector('#liuwaOpacity');
const opacityValue = document.querySelector('#liuwaOpacityValue');
const layoutInput = document.querySelector('#liuwaLayout');
const compactButton = document.querySelector('#liuwaCompact');
const status = document.querySelector('#liuwaDisplayStatus');
let current = {opacity: .9, layout: 'standard', compact: false};

export function applyDisplay(display = {}) {
  current = {...current, ...display};
  const opacity = Math.max(.3, Math.min(1, Number(current.opacity) || .9));
  document.documentElement.style.setProperty('--panel-opacity', opacity);
  document.documentElement.dataset.layout = current.layout;
  document.body.classList.toggle('liuwa-compact', Boolean(current.compact));
  if (opacityInput) opacityInput.value = String(Math.round(opacity * 100));
  if (opacityValue) opacityValue.textContent = `${Math.round(opacity * 100)}%`;
  if (layoutInput) layoutInput.value = current.layout;
  if (compactButton) compactButton.textContent = current.compact ? '展开窗口' : '收起窗口';
}

async function updateDisplay(patch) {
  const previous = {...current};
  applyDisplay(patch);
  try {
    if (window.cockpit?.setDisplay) {
      const result = await window.cockpit.setDisplay(patch);
      applyDisplay(result);
      if (status) status.textContent = result.saved === false ? '本次已应用，偏好保存失败。' : '';
    } else {
      localStorage.setItem('liuwa.display', JSON.stringify(current));
      if (status) status.textContent = '浏览器预览布局';
    }
  } catch {
    applyDisplay(previous);
    if (status) status.textContent = '显示设置未能应用，请重试。';
  }
}

opacityInput?.addEventListener('input', () => updateDisplay({opacity: Number(opacityInput.value) / 100}));
layoutInput?.addEventListener('change', () => updateDisplay({layout: layoutInput.value, compact: false}));
compactButton?.addEventListener('click', () => updateDisplay({compact: !current.compact}));
window.cockpit?.onDisplay?.(applyDisplay);
if (!window.cockpit) {
  try { applyDisplay(JSON.parse(localStorage.getItem('liuwa.display') || '{}')); } catch { applyDisplay(); }
} else applyDisplay();
