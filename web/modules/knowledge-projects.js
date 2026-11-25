import { fetchGatewayJson, postJson } from './gateway.js';
import { navigateSettings, confirmSettingsAction } from './settings-navigation.js';
import { renderMarkdown } from './markdown.js';
import { prepareBrowserFiles } from './knowledge-files.js';

const root = document.querySelector('#knowledgeApp');
const native = window.knowledgeBridge;
const endpoint = '/api/knowledge';
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let epoch = 0, privacyRevision = 0, selectionEpoch = 0;
let task = null, capabilities = null, projectSearch = '', documentSearch = '', renderedHash = '';
const reports = new Map();

function route() {
  const parts = location.hash.slice(1).split('/');
  return { section: parts[0], project: parts[1] || '', document: parts[2] === 'documents' ? parts[3] || '' : '' };
}
function projectHash(id) { return `#knowledge/${encodeURIComponent(id)}`; }
function selectedIds() {
  try { return JSON.parse(document.querySelector('#interviewKnowledgeProjects')?.value || '[]'); }
  catch { return []; }
}
function setSelectedIds(ids) {
  const input = document.querySelector('#interviewKnowledgeProjects');
  if (!input) return;
  input.value = JSON.stringify([...new Set(ids)]);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function updateSummary(projects) {
  const target = document.querySelector('#knowledgeSummary');
  if (!target) return;
  const count = selectedIds().filter(id => projects.some(project => project.id === id)).length;
  const notes = document.querySelector('#interviewUseKnowledge')?.checked;
  target.textContent = [count ? `${count} 个项目` : '', notes ? '历史笔记' : ''].filter(Boolean).join('、') || '未选择';
}
async function renderSelection() {
  const target = document.querySelector('#knowledgeSelection');
  if (!target) return;
  const version = ++selectionEpoch;
  try {
    const { projects } = await fetchGatewayJson(`${endpoint}/projects`);
    if (version !== selectionEpoch) return;
    const selected = selectedIds();
    target.innerHTML = projects.length ? projects.map(project => `<label class="knowledge-choice"><input type="checkbox" data-knowledge-select="${escape(project.id)}" ${selected.includes(project.id) ? 'checked' : ''} ${!project.document_count && !selected.includes(project.id) ? 'disabled' : ''} /><span>${escape(project.name)}<small>${project.document_count} 个文件</small></span></label>`).join('') : '<p class="empty-state">还没有项目资料。<a href="#knowledge">导入项目</a></p>';
    updateSummary(projects);
  } catch {
    target.innerHTML = '<p class="is-error" role="alert">项目列表读取失败。<button type="button" class="text-button" data-knowledge-retry-selection>重试</button></p>';
  }
}
function announce(message, error = false) {
  const node = root?.querySelector('[data-knowledge-status]');
  if (node) { node.textContent = message; node.classList.toggle('is-error', error); }
}
function toolbar() {
  return '<div class="knowledge-toolbar"><button type="button" data-knowledge-import="files">导入文件</button><button type="button" class="secondary" data-knowledge-import="folder">导入文件夹</button></div>';
}
function rememberScroll() {
  if (renderedHash === location.hash) history.replaceState({ ...history.state, knowledgeScroll: window.scrollY }, '');
}
function navigate(hash, focus = null) {
  rememberScroll();
  navigateSettings(hash, { focus });
}
function back() {
  const current = route();
  const target = current.document ? projectHash(current.project) : '#knowledge';
  if (history.state?.settingsParent === target) history.back();
  else navigateSettings(target, { replace: true });
}
function reportMarkup(entries) {
  if (!entries?.length) return '';
  return `<section class="knowledge-report"><h2>导入清单</h2><ul>${entries.map(item => `<li><span>${escape(item.path)}</span><small>${escape(item.reason || item.status)}</small></li>`).join('')}</ul></section>`;
}
async function render() {
  if (!root) return;
  const current = route();
  const version = ++epoch;
  renderedHash = '';
  if (current.section !== 'knowledge') return;
  const scroll = history.state?.knowledgeScroll || 0;
  if (current.project === 'import') { renderImport(); return; }
  root.innerHTML = '<p class="empty-state" role="status">正在读取…</p>';
  try {
    if (!current.project) {
      const { projects } = await fetchGatewayJson(`${endpoint}/projects`);
      if (version !== epoch) return;
      root.innerHTML = `${toolbar()}<label class="sr-only" for="knowledgeSearch">搜索项目</label><input type="search" id="knowledgeSearch" placeholder="搜索项目" value="${escape(projectSearch)}" /><p data-knowledge-status role="status"></p><div class="knowledge-project-list">${projects.length ? projects.map(project => `<article class="knowledge-project" data-knowledge-name="${escape(project.name.toLowerCase())}"><a class="knowledge-project-link" href="${projectHash(project.id)}" data-knowledge-project="${escape(project.id)}"><strong>${escape(project.name)}</strong><span>${project.document_count} 个文件</span></a><button type="button" class="text-button is-danger" data-knowledge-delete="${escape(project.id)}" aria-label="删除项目 ${escape(project.name)}">删除</button></article>`).join('') : '<p class="empty-state">将项目文档、Markdown 或源码导入为本地资料。</p>'}</div><a class="knowledge-history-link" href="#assets/kb">历史笔记 →</a>`;
      filterProjects();
    } else if (current.document) {
      const { document } = await fetchGatewayJson(`${endpoint}/projects/${encodeURIComponent(current.project)}/documents/${encodeURIComponent(current.document)}`);
      if (version !== epoch) return;
      const markdown = /\.(?:md|markdown)$/i.test(document.relative_path);
      root.innerHTML = `<header class="knowledge-detail-heading"><button type="button" class="text-button" data-knowledge-back>← 项目文件</button><h1>${escape(document.relative_path)}</h1></header><p class="knowledge-source">${(document.chunks || []).map(chunk => `${escape(chunk.heading || '正文')} · L${chunk.start_line}–${chunk.end_line}`).join(' / ')}</p><div class="knowledge-view-tabs">${markdown ? '<button type="button" class="secondary" data-knowledge-view="preview" aria-pressed="true">预览</button>' : ''}<button type="button" class="secondary" data-knowledge-view="raw" aria-pressed="${!markdown}">原文</button></div><article class="knowledge-document md" id="knowledgePreview" ${markdown ? '' : 'hidden'}></article><pre class="knowledge-raw" id="knowledgeRaw" ${markdown ? 'hidden' : ''}></pre><p data-knowledge-status role="status"></p>`;
      root.querySelector('#knowledgeRaw').textContent = document.text;
      if (markdown) root.querySelector('#knowledgePreview').innerHTML = renderMarkdown(document.text);
    } else {
      const { project, documents, last_import } = await fetchGatewayJson(`${endpoint}/projects/${encodeURIComponent(current.project)}`);
      const refreshable = native ? await native.hasSource({ projectId: project.id }) : false;
      if (version !== epoch) return;
      root.innerHTML = `<header class="knowledge-detail-heading"><button type="button" class="text-button" data-knowledge-back>← 项目列表</button><div class="knowledge-project-title"><h1>${escape(project.name)}</h1><button type="button" class="text-button" data-knowledge-rename>重命名</button></div><form class="knowledge-rename" hidden><label for="knowledgeProjectName">项目名称</label><input id="knowledgeProjectName" maxlength="100" required value="${escape(project.name)}" /><button type="submit">保存名称</button><button type="button" class="text-button" data-knowledge-cancel-rename>取消</button></form><p class="knowledge-source">${documents.length} 个文件 · 本地副本</p></header>${toolbar()}${refreshable ? '<button type="button" class="text-button" data-knowledge-refresh>刷新上次来源</button>' : ''}<label class="sr-only" for="knowledgeFileSearch">搜索文件</label><input id="knowledgeFileSearch" type="search" placeholder="搜索文件路径" value="${escape(documentSearch)}" /><p data-knowledge-status role="status"></p><div class="knowledge-files">${documents.length ? documents.map(document => `<div class="knowledge-file" data-knowledge-path="${escape(document.relative_path.toLowerCase())}"><a href="${projectHash(project.id)}/documents/${encodeURIComponent(document.id)}" data-knowledge-document="${escape(document.id)}"><span>${escape(document.relative_path)}</span><small>${document.chunk_count} 个片段</small></a><button type="button" class="text-button is-danger" data-knowledge-delete-document="${escape(document.id)}" aria-label="删除文件 ${escape(document.relative_path)}">移除</button></div>`).join('') : '<p class="empty-state">尚无可检索的文件。导入后仍需在面试资料中选择此项目。</p>'}</div>${reportMarkup(reports.get(project.id) || last_import)}`;
      filterDocuments();
    }
    if (version !== epoch) return;
    window.scrollTo({ top: scroll, behavior: 'instant' });
    const focus = history.state?.settingsFocus;
    if (focus?.kind === 'knowledge') [...root.querySelectorAll('[data-knowledge-project]')].find(node => node.dataset.knowledgeProject === focus.id)?.focus({ preventScroll: true });
    renderedHash = location.hash;
  } catch (error) {
    if (version !== epoch) return;
    root.innerHTML = '<button type="button" class="text-button" data-knowledge-back>← 返回项目列表</button><p class="is-error" role="alert" data-knowledge-error></p><button type="button" class="secondary" data-knowledge-retry>重试</button>';
    root.querySelector('[data-knowledge-error]').textContent = error.message || '知识库读取失败。';
  }
}
function filterProjects() {
  root?.querySelectorAll('[data-knowledge-name]').forEach(node => { node.hidden = !node.dataset.knowledgeName.includes(projectSearch.toLowerCase()); });
}
function filterDocuments() {
  root?.querySelectorAll('[data-knowledge-path]').forEach(node => { node.hidden = !node.dataset.knowledgePath.includes(documentSearch.toLowerCase()); });
}
async function choose(kind, refresh = false) {
  if (task?.running) return;
  const revision = privacyRevision;
  const requestedHash = location.hash;
  const project = route().project;
  const existing = project && project !== 'import' ? project : '';
  try {
    capabilities ||= await fetchGatewayJson(`${endpoint}/capabilities`);
    if (revision !== privacyRevision) return;
    let selection;
    if (native) {
      announce('正在读取文件清单…');
      selection = await native.choose({ kind: refresh ? 'refresh' : kind, ...(existing ? { projectId: existing } : {}) });
    } else {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.hidden = true;
      if (kind === 'folder') input.setAttribute('webkitdirectory', '');
      else input.accept = capabilities.suffixes.join(',');
      document.body.append(input);
      const files = await new Promise(resolve => {
        const finish = value => { input.remove(); resolve(value); };
        input.addEventListener('change', () => finish([...input.files]), { once: true });
        input.addEventListener('cancel', () => finish([]), { once: true });
        input.click();
      });
      if (revision !== privacyRevision || !files.length) return;
      selection = await prepareBrowserFiles(files, capabilities, kind === 'folder');
    }
    if (!selection) { announce(''); return; }
    if (revision !== privacyRevision || location.hash !== requestedHash) { if (selection.token) await native.release({ token: selection.token }); return; }
    if (task?.token) await native.release({ token: task.token });
    const completeManifest = !selection.skippedTotal || selection.skippedTotal <= (selection.skipped || []).length;
    task = { ...selection, project: existing, replace: refresh && selection.kind === 'folder' && completeManifest && Array.isArray(selection.refreshPaths), running: false, finished: false, report: [...(selection.skipped || [])], done: 0, revision };
    navigate('#knowledge/import');
  } catch (error) { if (revision === privacyRevision) announce(error.message || '文件选择失败。', true); }
}
function renderImport() {
  if (!task) { root.innerHTML = '<p class="empty-state">没有待导入的文件。</p><button type="button" class="secondary" data-knowledge-back>返回项目列表</button>'; return; }
  root.innerHTML = `<header class="page-heading"><h1>${task.project ? '更新项目资料' : '导入项目资料'}</h1></header><form id="knowledgeImportForm">${task.project ? '' : `<label for="knowledgeImportName">项目名称</label><input id="knowledgeImportName" required maxlength="100" value="${escape(task.name)}" ${task.running ? 'disabled' : ''} />`}<p class="knowledge-source">${task.files.length} 个文件${task.replace ? ' · 刷新将同步已删除的源文件' : ''}</p><p class="field-hint">文件仅在本机提取和索引。导入不会自动启用面试引用。</p><progress max="${Math.max(1, task.files.length)}" value="${task.done}" aria-label="导入进度"></progress><p id="knowledgeImportProgress" role="status">${task.running ? `已处理 ${task.done} / ${task.files.length}` : '准备就绪'}</p><div class="form-actions"><button type="submit" ${task.running || (!task.files.length && !task.replace) ? 'disabled' : ''}>${task.running ? '正在导入…' : '开始导入'}</button><button type="button" class="secondary" data-knowledge-cancel-import ${task.finishing ? 'disabled' : ''}>${task.running ? '取消导入' : '取消'}</button></div><p data-knowledge-status role="status"></p></form>${reportMarkup(task.report)}`;
}
async function cancelImport({ hidden = false } = {}) {
  const current = task;
  if (!current) return;
  if (current.finishing) return;
  const cancelledHash = location.hash, cancelledEpoch = epoch, cancelledRevision = privacyRevision;
  task = null;
  current.cancelled = true;
  current.controller?.abort();
  try {
    if (current.importId) await fetchGatewayJson(`${endpoint}/projects/${current.project}/imports/${current.importId}`, { method: 'DELETE', timeoutMs: 15000 });
  } catch { /* Unpublished stages also expire on the server. */ }
  if (current.token) await native.release({ token: current.token }).catch(() => {});
  if (!hidden && !task && location.hash === cancelledHash && epoch === cancelledEpoch && privacyRevision === cancelledRevision) navigate(current.project ? projectHash(current.project) : '#knowledge');
}
async function startImport(event) {
  event.preventDefault();
  const current = task;
  if (!current || current.running || (!current.files.length && !current.replace)) return;
  const name = root.querySelector('#knowledgeImportName')?.value.trim() || current.name;
  if (!name) return;
  current.name = name; current.running = true; current.done = 0;
  current.report = [...(current.skipped || [])];
  current.controller = new AbortController();
  renderImport();
  const active = () => task === current && !current.cancelled && current.revision === privacyRevision;
  try {
    if (!current.project) {
      const { project } = await postJson(`${endpoint}/projects`, { name });
      current.project = project.id;
    }
    if (!active()) return;
    const { import_id } = await postJson(`${endpoint}/projects/${current.project}/imports`, {});
    current.importId = import_id;
    if (!active()) { await fetchGatewayJson(`${endpoint}/projects/${current.project}/imports/${import_id}`, { method: 'DELETE' }); return; }
    for (const entry of current.files) {
      if (!active()) return;
      let file = entry.file;
      if (current.token) {
        const { base64 } = await native.read({ token: current.token, id: entry.id });
        if (!active()) return;
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        file = new Blob([bytes], { type: 'application/octet-stream' });
      }
      const body = new FormData();
      body.append('relative_path', entry.path); body.append('file', file, entry.path.split('/').pop());
      const response = await fetchGatewayJson(`${endpoint}/projects/${current.project}/imports/${import_id}/files`, { method: 'POST', body, timeoutMs: 60000, signal: current.controller.signal });
      current.done += 1;
      current.report.push({ path: entry.path, status: response.status, reason: response.reason || ({ ready: '已索引', unchanged: '未变化', failed: '提取失败', skipped: '已跳过' }[response.status] || response.status) });
      if (active()) renderImport();
    }
    if (!active()) return;
    current.finishing = true; renderImport();
    let preservePaths = [];
    if (current.replace) {
      const { documents } = await fetchGatewayJson(`${endpoint}/projects/${current.project}`);
      const sourcePaths = new Set(current.refreshPaths);
      preservePaths = documents.filter(document => !sourcePaths.has(document.relative_path) || current.skipped.some(item => document.relative_path === item.path || document.relative_path.startsWith(item.path + '/'))).map(document => document.relative_path);
    }
    const result = await postJson(`${endpoint}/projects/${current.project}/imports/${import_id}/finish`, { replace: current.replace, preserve_paths: preservePaths }, { timeoutMs: 60000 });
    current.finished = true;
    reports.set(current.project, current.report);
    if (current.token && active()) {
      await native.bind({ token: current.token, projectId: current.project }).catch(() => {
        current.report.push({ path: '源文件关联', reason: '关联保存失败；本地索引已保存，可重新选择文件更新。' });
      });
    }
    if (current.token) await native.release({ token: current.token }).catch(() => {});
    if (!active() || route().section !== 'knowledge' || route().project !== 'import') { task = null; return; }
    task = null;
    navigate(projectHash(result.project?.id || current.project));
    await renderSelection();
  } catch (error) {
    if (current.importId && !current.finished) {
      await fetchGatewayJson(`${endpoint}/projects/${current.project}/imports/${current.importId}`, { method: 'DELETE' }).catch(() => {});
      current.importId = null;
    }
    current.running = false; current.finishing = false;
    if (active()) { renderImport(); announce(error.message || '导入失败，已有资料未变更，可重试。', true); }
  }
}

root?.addEventListener('click', async event => {
  const button = event.target.closest('button, a');
  if (!button) return;
  try {
    if (button.dataset.knowledgeImport) { await choose(button.dataset.knowledgeImport); return; }
    if (button.hasAttribute('data-knowledge-refresh')) { await choose('folder', true); return; }
    if (button.hasAttribute('data-knowledge-cancel-import')) { await cancelImport(); return; }
    if (button.hasAttribute('data-knowledge-back')) { back(); return; }
    if (button.hasAttribute('data-knowledge-retry')) { await render(); return; }
    if (button.dataset.knowledgeProject) { event.preventDefault(); navigate(projectHash(button.dataset.knowledgeProject), { kind: 'knowledge', id: button.dataset.knowledgeProject }); return; }
    if (button.dataset.knowledgeDocument) { event.preventDefault(); navigate(`${projectHash(route().project)}/documents/${encodeURIComponent(button.dataset.knowledgeDocument)}`); return; }
    if (button.dataset.knowledgeDelete) {
      const id = button.dataset.knowledgeDelete;
      const revision = privacyRevision;
      if (!await confirmSettingsAction('删除项目的本地副本和索引？源文件不会删除。') || revision !== privacyRevision) return;
      await fetchGatewayJson(`${endpoint}/projects/${id}`, { method: 'DELETE' });
      if (native) await native.forget({ projectId: id });
      setSelectedIds(selectedIds().filter(item => item !== id));
      await Promise.all([render(), renderSelection()]); return;
    }
    if (button.dataset.knowledgeDeleteDocument) {
      if (!await confirmSettingsAction('移除本地文件和索引？源文件不会删除。')) return;
      await fetchGatewayJson(`${endpoint}/projects/${route().project}/documents/${button.dataset.knowledgeDeleteDocument}`, { method: 'DELETE' });
      await Promise.all([render(), renderSelection()]); return;
    }
    if (button.hasAttribute('data-knowledge-rename')) { root.querySelector('.knowledge-rename').hidden = false; root.querySelector('#knowledgeProjectName').focus(); return; }
    if (button.hasAttribute('data-knowledge-cancel-rename')) { root.querySelector('.knowledge-rename').hidden = true; return; }
    if (button.dataset.knowledgeView) {
      const raw = button.dataset.knowledgeView === 'raw';
      root.querySelector('#knowledgeRaw').hidden = !raw; root.querySelector('#knowledgePreview').hidden = raw;
      root.querySelectorAll('[data-knowledge-view]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    }
  } catch (error) { announce(error.message || '操作失败，请重试。', true); }
});
root?.addEventListener('submit', async event => {
  if (event.target.id === 'knowledgeImportForm') { await startImport(event); return; }
  if (!event.target.matches('.knowledge-rename')) return;
  event.preventDefault();
  try {
    await postJson(`${endpoint}/projects/${route().project}`, { name: root.querySelector('#knowledgeProjectName').value.trim() }, { method: 'PATCH' });
    await Promise.all([render(), renderSelection()]);
  } catch (error) { announce(error.message, true); }
});
root?.addEventListener('input', event => {
  if (event.target.id === 'knowledgeSearch') { projectSearch = event.target.value; filterProjects(); }
  if (event.target.id === 'knowledgeFileSearch') { documentSearch = event.target.value; filterDocuments(); }
  if (event.target.id === 'knowledgeImportName' && task) task.name = event.target.value;
});
document.querySelector('#knowledgeSelection')?.addEventListener('change', event => {
  const id = event.target.dataset.knowledgeSelect;
  if (id) { setSelectedIds(event.target.checked ? [...selectedIds(), id] : selectedIds().filter(item => item !== id)); renderSelection(); }
});
document.querySelector('#knowledgeSelection')?.addEventListener('click', event => { if (event.target.closest('[data-knowledge-retry-selection]')) renderSelection(); });
document.querySelector('#interviewUseKnowledge')?.addEventListener('change', renderSelection);
window.addEventListener('settings:loaded', renderSelection);
for (const name of ['hashchange', 'popstate', 'settings:navigate']) window.addEventListener(name, () => {
  if ((route().section !== 'knowledge' || route().project !== 'import') && task) cancelImport({ hidden: true });
  render();
  if (location.hash.startsWith('#briefing')) renderSelection();
});
window.addEventListener('knowledge:back', back);
window.addEventListener('scroll', rememberScroll, { passive: true });
const hide = () => { privacyRevision += 1; epoch += 1; cancelImport({ hidden: true }); };
window.addEventListener('app:privacy-hidden', hide);
window.addEventListener('pagehide', hide);
document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
render();
