import { renderMarkdown } from './markdown.js';
import { splitAnswer } from './answer-sections.js';

const readers = new WeakMap();

// 复制按钮的点击落在每次重绘后的新节点上，所以在容器上委托一次即可。
// 流式生成中也可能被点，读的是当时已经渲染出来的那部分代码。
export function wireCodeCopy(root) {
  if (!root?.addEventListener || root.dataset?.copyWired) return;
  root.dataset.copyWired = 'true';
  root.addEventListener('click', async (event) => {
    const button = event.target.closest?.('.md-copy');
    if (!button || !root.contains(button)) return;
    const source = button.closest('.md-code-block')?.querySelector('.md-code')?.textContent || '';
    if (!source) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(source);
      copied = true;
    } catch {
      // 没有剪贴板权限（或非安全上下文）时退回旧接口，Electron 里通常走得到。
      const area = root.ownerDocument?.createElement?.('textarea');
      if (area) {
        area.value = source;
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        root.ownerDocument.body.append(area);
        area.select();
        try { copied = root.ownerDocument.execCommand('copy'); } catch { copied = false; }
        area.remove();
      }
    }
    button.textContent = copied ? '已复制' : '复制失败';
    button.classList.toggle('is-done', copied);
    clearTimeout(button.__copyTimer);
    button.__copyTimer = setTimeout(() => {
      button.textContent = '复制';
      button.classList.remove('is-done');
    }, 1500);
  });
}

export function renderAnswer(markdown, root, {complete = false} = {}) {
  if (!root) return;
  let reader = readers.get(root);
  if (!reader) {
    reader = {selected:null, manual:false, positions:new Map(), model:null};
    readers.set(root, reader);
  }
  wireCodeCopy(root);
  const model = splitAnswer(markdown);
  reader.positions.set(reader.selected, root.scrollTop || 0);
  reader.model = model;
  if (!reader.manual) reader.selected = model.preferred;
  if (complete && !model.panels.some(p => p.key === reader.selected && p.hasContent)) {
    reader.selected = model.panels.find(p => p.hasContent)?.key || 'all';
  }
  reader.complete = complete;
  const paint = () => {
    const panel = reader.model.panels.find(p => p.key === reader.selected);
    root.innerHTML = panel?.hasContent ? renderMarkdown(panel.markdown) : '';
    if (root.dataset) {
      root.dataset.answerPanel = reader.selected;
      root.dataset.answerType = reader.model.type;
      root.dataset.hasAnswer = String(Boolean(panel?.hasContent));
      root.dataset.waiting = `正在生成${panel?.label || '回答'}…`;
    }
    root.scrollTop = reader.positions.get(reader.selected) || 0;
  };
  const tabs = root.closest?.('.liuwa-reader')?.querySelector('#liuwaAnswerTabs');
  const syncTabs = () => {
    if (!tabs) return;
    const keys = reader.model.panels.filter(p => !reader.complete || p.hasContent).map(p => p.key);
    tabs.hidden = keys.length < 2;
    const signature = keys.join('|') + reader.model.type;
    if (tabs.dataset.signature !== signature) {
      const focused = tabs.contains(tabs.ownerDocument.activeElement);
      tabs.replaceChildren(...keys.map(key => {
        const p = reader.model.panels.find(p => p.key === key);
        const button = tabs.ownerDocument.createElement('button');
        button.type = 'button'; button.role = 'tab'; button.dataset.panel = key;
        button.id = `answer-tab-${key}`;
        button.textContent = p.label;
        button.setAttribute('aria-controls', 'liuwaAnswerBody');
        return button;
      }));
      tabs.dataset.signature = signature;
      if(focused) tabs.querySelector(`[data-panel="${reader.selected}"]`)?.focus();
    }
    tabs.querySelectorAll('button').forEach(button => {
      const selected = button.dataset.panel === reader.selected;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    root.id = 'liuwaAnswerBody';
    root.setAttribute('role', 'tabpanel');
    root.setAttribute('aria-labelledby', `answer-tab-${reader.selected}`);
    root.tabIndex = 0;
  };
  const select = key => {
    if(!reader.model.panels.some(p => p.key === key)) return;
    reader.positions.set(reader.selected, root.scrollTop);
    reader.selected = key; reader.manual = true;
    paint(); syncTabs();
    root.dispatchEvent(new Event('answer-panel-change', {bubbles:true}));
  };
  if (tabs) {
    tabs.onclick = event => { const key = event.target.closest('[data-panel]')?.dataset.panel; if(key) select(key); };
    tabs.onkeydown = event => {
      const buttons = [...tabs.querySelectorAll('button')];
      const index = buttons.indexOf(event.target);
      if(index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      select(buttons[next].dataset.panel); buttons[next].focus();
    };
  }
  paint(); syncTabs();
  return {...model, selected:reader.selected};
}

export function stepAnswerTab(direction, root) {
  const doc = (root && root.ownerDocument) ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
  if (!doc) return false;
  const targetRoot = root || doc.querySelector?.('.liuwa-stream');
  const container = targetRoot?.closest?.('.liuwa-reader') || doc;
  const tabs = container.querySelector?.('#liuwaAnswerTabs');
  if (!tabs || tabs.hidden) return false;
  const buttons = Array.from(tabs.querySelectorAll?.('button[data-panel]') || []).filter(b => !b.hidden && b.style?.display !== 'none');
  if (buttons.length < 2) return false;
  const delta = typeof direction === 'string'
    ? (direction === 'prev' ? -1 : 1)
    : (direction < 0 ? -1 : 1);
  const currentIndex = buttons.findIndex(b => b.getAttribute?.('aria-selected') === 'true');
  const nextIndex = currentIndex === -1
    ? (delta > 0 ? 0 : buttons.length - 1)
    : (currentIndex + delta + buttons.length) % buttons.length;
  const targetButton = buttons[nextIndex];
  if (typeof targetButton.click === 'function') {
    targetButton.click();
  } else if (typeof tabs.onclick === 'function') {
    tabs.onclick({ target: targetButton });
  }
  return true;
}
