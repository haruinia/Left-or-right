import { renderMarkdown } from './markdown.js';
import { splitAnswer } from './answer-sections.js';

const readers = new WeakMap();

export function renderAnswer(markdown, root, {complete = false} = {}) {
  if (!root) return;
  let reader = readers.get(root);
  if (!reader) {
    reader = {selected:null, manual:false, positions:new Map(), model:null};
    readers.set(root, reader);
  }
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
