export function settingsRoute(hash = location.hash) {
  const parts = hash.replace(/^#/, '').split('/');
  if (parts[0] === 'asr') return { section: 'models', tab: 'asr', kind: 'list', hash: '#models/asr' };
  const section = parts[0] === 'legacySettings' ? 'briefing' : parts[0] || 'models';
  if (section !== 'models') return { section, hash: `#${section}` };
  if (parts[1] === 'import') return { section, tab: 'llm', kind: 'import', hash: '#models/import' };
  const tab = parts[1] === 'asr' ? 'asr' : 'llm';
  let id = '';
  try { id = decodeURIComponent(parts[2] || ''); } catch { /* Invalid links return to the list. */ }
  return { section, tab, id, kind: id ? 'editor' : 'list', hash: id ? `#models/${tab}/${encodeURIComponent(id)}` : tab === 'asr' ? '#models/asr' : '#models' };
}

export function navigateSettings(hash, { replace = false, focus = null } = {}) {
  if (location.hash === hash) return;
  history.replaceState({ ...history.state, settingsScroll: window.scrollY, ...(focus ? { settingsFocus: focus } : {}) }, '');
  history[replace ? 'replaceState' : 'pushState']({ settingsScroll: 0, settingsParent: location.hash }, '', hash);
  window.dispatchEvent(new Event('settings:navigate'));
}

export function returnToConnections(tab = 'llm') {
  const target = tab === 'asr' ? '#models/asr' : '#models';
  if (history.state?.settingsParent === target) history.back();
  else navigateSettings(target, { replace: true });
}

export function confirmSettingsAction(message) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'asset-dialog'; dialog.setAttribute('aria-labelledby', 'settingsConfirmTitle');
    const title = document.createElement('h2'); title.id = 'settingsConfirmTitle'; title.textContent = message;
    const actions = document.createElement('div'); actions.className = 'asset-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消'; cancel.autofocus = true;
    const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = '删除'; accept.dataset.settingsConfirm = '';
    let accepted = false;
    const close = () => { if (dialog.open) dialog.close(); };
    cancel.addEventListener('click', close);
    accept.addEventListener('click', () => { accepted = true; close(); });
    const events = ['app:privacy-hidden', 'hashchange', 'popstate', 'settings:navigate'];
    events.forEach(name => window.addEventListener(name, close));
    dialog.addEventListener('close', () => {
      events.forEach(name => window.removeEventListener(name, close));
      dialog.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(accepted);
    }, { once: true });
    actions.append(cancel, accept); dialog.append(title, actions); document.body.append(dialog); dialog.showModal();
  });
}
