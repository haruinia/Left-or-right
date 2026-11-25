'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, files: 1000, visited: 5000, milliseconds: 30000, lifetime: 10 * 60 * 1000 });
const SUFFIXES = new Set('.md .markdown .txt .py .js .ts .jsx .tsx .java .go .rs .c .h .cpp .hpp .cs .rb .php .swift .kt .kts .sql .sh .css .html .vue .svelte .json .yaml .yml .toml .xml .csv .log .rst .jsonl .scss .ini .cfg .bash .zsh .pdf .docx'.split(' '));
const EXCLUDED_DIRS = new Set(['.git', '.svn', '.hg', '.ssh', '.aws', '.azure', '.kube', '.config', 'node_modules', 'vendor', 'bower_components', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.terraform', '.next', '.nuxt', '.cache', '.claude', '.idea', 'dist', 'build', 'target', 'out', 'output', 'coverage']);
const SENSITIVE = /^(?:\.env.*|\.npmrc|\.pypirc|\.netrc|\.git-credentials|(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[._-].*)?|service[-_]?account(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore)|(?:asr|model)_profiles\.json|knowledge-sources\.json)$/i;
const FILE_ERROR = '文件已变更、不可读取或不在本次选择范围，请重新选择。';
const SOURCE_ERROR = '无法读取本机导入来源，请重新选择文件或文件夹。';
const IGNORE_ERROR = '文件夹的 .gitignore 超过 64 KiB，请缩小规则文件后重试。';
const AUTH_ERROR = '导入授权已失效，请在知识库页面重新选择。';
const projectIdValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };

function relativePath(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative.length > 500 || relative.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\\:]/.test(relative)) throw new Error(FILE_ERROR);
  return relative;
}

function excluded(relative, directory = false) {
  const parts = relative.split('/');
  if (parts.some(part => SENSITIVE.test(part))) return '敏感文件';
  if (parts.some((part, index) => (directory || index < parts.length - 1) && EXCLUDED_DIRS.has(part.toLowerCase()))) return '依赖或生成目录';
  if (!directory && !SUFFIXES.has(path.extname(parts.at(-1)).toLowerCase())) return '不支持的文件类型';
  return '';
}

function globPattern(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const value = pattern[index];
    if (value === '\\' && index + 1 < pattern.length) { source += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (value === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') { source += '(?:.*/)?'; index += 1; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (value === '?') source += '[^/]';
    else if (value === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) source += '\\[';
      else { let group = pattern.slice(index + 1, end); if (group.startsWith('!')) group = `^${group.slice(1)}`; source += `[${group.replaceAll('\\', '\\\\')}]`; index = end; }
    } else source += value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

function ignoreRules(text, base = '') {
  const rules = [];
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    if (!line) continue;
    const directory = line.endsWith('/');
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    try { rules.push({ base, negate, directory, regex: new RegExp(`${anchored || line.includes('/') ? '^' : '(?:^|/)'}${globPattern(line)}$`) }); } catch { /* Invalid ignore patterns cannot authorize extra file reads. */ }
  }
  return rules;
}

function ignored(relative, directory, rules) {
  let match = false;
  for (const rule of rules) {
    if (rule.base && !relative.startsWith(`${rule.base}/`)) continue;
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative;
    if ((!rule.directory || directory) && rule.regex.test(local)) match = !rule.negate;
  }
  return match;
}

async function assertPath(root, absolute, rootStat) {
  if (!inside(root, absolute)) throw new Error(FILE_ERROR);
  const start = await fs.promises.lstat(root);
  if (start.isSymbolicLink() || !start.isDirectory() || !sameFile(start, rootStat) || await fs.promises.realpath(root) !== root) throw new Error(FILE_ERROR);
  let cursor = root;
  let result = start;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    result = await fs.promises.lstat(cursor);
    if (result.isSymbolicLink() || await fs.promises.realpath(cursor) !== cursor) throw new Error(FILE_ERROR);
  }
  return result;
}

async function readChecked(root, absolute, expected, rootStat, validate = () => {}, maxBytes = LIMITS.fileBytes) {
  validate();
  const before = await assertPath(root, absolute, rootStat);
  if (!before.isFile() || !sameVersion(before, expected) || before.size > maxBytes) throw new Error(FILE_ERROR);
  const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameVersion(opened, before)) throw new Error(FILE_ERROR);
    await assertPath(root, absolute, rootStat);
    const parts = [];
    let size = 0;
    while (true) {
      validate();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(FILE_ERROR);
      parts.push(buffer.subarray(0, bytesRead));
    }
    validate();
    if (!sameVersion(await handle.stat(), before) || !sameVersion(await assertPath(root, absolute, rootStat), before)) throw new Error(FILE_ERROR);
    return Buffer.concat(parts, size);
  } finally { await handle.close(); }
}

async function sourceFromSelection(kind, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > LIMITS.files || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw new Error(SOURCE_ERROR);
  const initial = await Promise.all(paths.map(value => fs.promises.lstat(value)));
  if (initial.some(stat => stat.isSymbolicLink())) throw new Error(SOURCE_ERROR);
  const canonical = await Promise.all(paths.map(value => fs.promises.realpath(value)));
  for (let index = 0; index < paths.length; index += 1) {
    const current = await fs.promises.lstat(paths[index]);
    if (current.isSymbolicLink() || !sameFile(current, initial[index]) || !sameFile(await fs.promises.lstat(canonical[index]), initial[index]) || await fs.promises.realpath(paths[index]) !== canonical[index]) throw new Error(SOURCE_ERROR);
  }
  if (kind === 'folder') {
    if (paths.length !== 1 || !initial[0].isDirectory()) throw new Error(SOURCE_ERROR);
    return { kind, root: canonical[0], rootIdentity: { dev: initial[0].dev, ino: initial[0].ino } };
  }
  let root = path.dirname(canonical[0]);
  while (canonical.some(value => !inside(root, value))) root = path.dirname(root);
  const rootStat = await fs.promises.lstat(root);
  return { kind: 'files', root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, selectedFiles: canonical.map(absolute => relativePath(root, absolute)) };
}

async function scanSource(source, { validate = () => {}, limits = LIMITS } = {}) {
  if (!source || !['folder', 'files'].includes(source.kind) || typeof source.root !== 'string' || !path.isAbsolute(source.root)) throw new Error(SOURCE_ERROR);
  const root = source.root;
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (source.rootIdentity && !sameFile(rootStat, source.rootIdentity)) || await fs.promises.realpath(root) !== root) throw new Error(SOURCE_ERROR);
  const started = Date.now();
  const files = [], skipped = [], entries = new Map();
  let visited = 0, totalBytes = 0, skippedTotal = 0;
  const check = () => { validate(); if (Date.now() - started > limits.milliseconds) throw new Error('导入扫描超时，请选择较小的文档文件夹。'); };
  const skip = (relative, reason) => { skippedTotal += 1; if (skipped.length < 200) skipped.push({ path: relative, reason }); };
  const visitFile = async (absolute, relative, stat, rules) => {
    const reason = excluded(relative) || (ignored(relative, false, rules) ? '.gitignore 已忽略' : '');
    if (reason) { skip(relative, reason); return; }
    if (stat.size > limits.fileBytes) { skip(relative, '文件超过 5 MiB'); return; }
    if (files.length >= limits.files || totalBytes + stat.size > limits.totalBytes) throw new Error('文件数量或总大小超限，请选择较小的文档文件夹。');
    const id = crypto.randomUUID();
    files.push({ id, path: relative, size: stat.size });
    entries.set(id, { absolute, stat }); totalBytes += stat.size;
  };
  const walk = async (directory, inherited) => {
    check();
    const directoryStat = await assertPath(root, directory, rootStat);
    const names = [];
    const handle = await fs.promises.opendir(directory);
    for await (const entry of handle) {
      check(); if (++visited > limits.visited) throw new Error('目录条目过多，请选择较小的文档文件夹。');
      names.push(entry.name);
    }
    if (!sameVersion(await assertPath(root, directory, rootStat), directoryStat)) throw new Error(FILE_ERROR);
    names.sort();
    let rules = inherited;
    if (names.includes('.gitignore')) {
      const ignore = path.join(directory, '.gitignore');
      const stat = await assertPath(root, ignore, rootStat);
      if (stat.isFile() && stat.size > 64 * 1024) throw new Error(IGNORE_ERROR);
      if (stat.isFile()) {
        const data = await readChecked(root, ignore, stat, rootStat, check, 64 * 1024);
        rules = [...inherited, ...ignoreRules(data.toString('utf8'), path.relative(root, directory).split(path.sep).join('/'))];
      }
    }
    for (const name of names) {
      check();
      const absolute = path.join(directory, name), relative = relativePath(root, absolute);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) { skip(relative, '符号链接或重解析路径'); continue; }
      const reason = excluded(relative, stat.isDirectory()) || (ignored(relative, stat.isDirectory(), rules) ? '.gitignore 已忽略' : '');
      if (reason) { skip(relative, reason); continue; }
      await assertPath(root, absolute, rootStat);
      if (stat.isDirectory()) await walk(absolute, rules);
      else if (stat.isFile()) await visitFile(absolute, relative, stat, rules);
      else skip(relative, '非常规文件');
    }
    if (!sameVersion(await assertPath(root, directory, rootStat), directoryStat)) throw new Error(FILE_ERROR);
  };
  if (source.kind === 'folder') await walk(root, []);
  else {
    if (!Array.isArray(source.selectedFiles) || source.selectedFiles.length > limits.files) throw new Error(SOURCE_ERROR);
    for (const relative of source.selectedFiles) {
      check();
      if (typeof relative !== 'string') throw new Error(SOURCE_ERROR);
      const absolute = path.resolve(root, relative);
      if (relativePath(root, absolute) !== relative) throw new Error(SOURCE_ERROR);
      try {
        const stat = await assertPath(root, absolute, rootStat);
        if (stat.isFile()) await visitFile(absolute, relative, stat, []);
        else skip(relative, '非常规文件');
      } catch { throw new Error(FILE_ERROR); }
    }
  }
  check();
  return { files, skipped, skippedTotal, entries, rootStat };
}

function registerKnowledgeImport({ ipcMain, dialog, getSettingsWindow, gatewayUrl, visibility, sourcesPath }) {
  const base = new URL(gatewayUrl).origin;
  const grants = new Map();
  const observed = new WeakSet();
  const windowRevisions = new WeakMap();
  const choosing = new WeakSet();
  function trusted(event) {
    const win = getSettingsWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !visibility.canShow(visibility.version())) throw new Error(AUTH_ERROR);
    const url = new URL(win.webContents.getURL());
    if (url.origin !== base || !['/settings', '/settings.html'].includes(url.pathname)) throw new Error(AUTH_ERROR);
    if (!observed.has(win)) {
      observed.add(win);
      windowRevisions.set(win, 0);
      const clear = () => { windowRevisions.set(win, windowRevisions.get(win) + 1); for (const [token, grant] of grants) if (grant.win === win) grants.delete(token); };
      win.on('hide', clear); win.on('closed', clear);
      win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame !== false && !inPlace) clear(); });
      win.webContents.on('render-process-gone', clear);
    }
    return win;
  }
  function validate(win, revision, windowRevision) {
    if (getSettingsWindow() !== win || win.isDestroyed() || !win.isVisible() || !visibility.canShow(revision) || (windowRevision !== undefined && windowRevision !== windowRevisions.get(win))) throw new Error(AUTH_ERROR);
  }
  function getGrant(event, token) {
    const win = trusted(event), grant = grants.get(token);
    if (!grant || grant.win !== win || Date.now() >= grant.expires) { grants.delete(token); throw new Error(AUTH_ERROR); }
    validate(win, grant.revision, grant.windowRevision);
    return grant;
  }
  async function readSources() {
    try {
      const stat = await fs.promises.lstat(sourcesPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error(SOURCE_ERROR);
      const raw = JSON.parse(await fs.promises.readFile(sourcesPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(SOURCE_ERROR);
      return Object.assign(Object.create(null), Object.fromEntries(Object.entries(raw).filter(([key]) => projectIdValid(key))));
    } catch (error) { if (error.code === 'ENOENT') return Object.create(null); throw new Error(SOURCE_ERROR); }
  }
  let sourceQueue = Promise.resolve();
  function updateSources(update, check = () => {}) {
    const operation = sourceQueue.catch(() => {}).then(async () => {
      check(); const sources = await readSources(); check(); update(sources);
      if (Buffer.byteLength(JSON.stringify(sources)) > 512 * 1024) throw new Error(SOURCE_ERROR);
      const temporary = `${sourcesPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(sources), { mode: 0o600, flag: 'wx' });
        check(); await fs.promises.rename(temporary, sourcesPath);
      } finally { await fs.promises.rm(temporary, { force: true }); }
    });
    sourceQueue = operation;
    return operation;
  }
  const handlers = {
    async choose(event, input) {
      const win = trusted(event), revision = visibility.version(), windowRevision = windowRevisions.get(win);
      if (!input || !['files', 'folder', 'refresh'].includes(input.kind)) throw new Error(AUTH_ERROR);
      for (const [token, grant] of grants) if (grant.win === win || Date.now() >= grant.expires) grants.delete(token);
      let source;
      if (input.kind === 'refresh') {
        if (!projectIdValid(input.projectId)) throw new Error(AUTH_ERROR);
        source = (await readSources())[input.projectId];
        if (!source) throw new Error(SOURCE_ERROR);
      } else {
        const chosen = await dialog.showOpenDialog(win, {
          title: input.kind === 'folder' ? '导入项目文档文件夹' : '导入项目文档',
          properties: input.kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          ...(input.kind === 'files' ? { filters: [{ name: '项目文档', extensions: [...SUFFIXES].map(value => value.slice(1)) }] } : {}),
        });
        validate(win, revision, windowRevision);
        if (chosen.canceled || !chosen.filePaths?.length) return null;
        source = await sourceFromSelection(input.kind, chosen.filePaths);
      }
      validate(win, revision, windowRevision);
      let scanned;
      try { scanned = await scanSource(source, { validate: () => validate(win, revision, windowRevision) }); }
      catch (error) { if ([AUTH_ERROR, FILE_ERROR, IGNORE_ERROR].includes(error.message) || /超限|超时|条目过多/.test(error.message)) throw error; throw new Error(SOURCE_ERROR); }
      validate(win, revision, windowRevision);
      const token = crypto.randomUUID();
      grants.set(token, { win, revision, windowRevision, expires: Date.now() + LIMITS.lifetime, source, ...scanned });
      return { token, name: path.basename(source.kind === 'folder' ? source.root : source.selectedFiles[0], path.extname(source.kind === 'files' ? source.selectedFiles[0] : '')), kind: source.kind, files: scanned.files, skipped: scanned.skipped, skippedTotal: scanned.skippedTotal, refreshPaths: input.kind === 'refresh' && Array.isArray(source.documentPaths) ? source.documentPaths : null };
    },
    async read(event, input) {
      const grant = getGrant(event, input?.token), file = grant.entries.get(input?.id);
      if (!file) throw new Error(AUTH_ERROR);
      try {
        const buffer = await readChecked(grant.source.root, file.absolute, file.stat, grant.rootStat, () => {
          if (getGrant(event, input.token) !== grant) throw new Error(AUTH_ERROR);
        });
        return { base64: buffer.toString('base64') };
      } catch (error) { if (error.message === AUTH_ERROR) throw error; throw new Error(FILE_ERROR); }
    },
    async bind(event, input) {
      const grant = getGrant(event, input?.token);
      if (!projectIdValid(input?.projectId)) throw new Error(AUTH_ERROR);
      await updateSources(sources => {
        const previous = sources[input.projectId];
        const previousPaths = previous?.root === grant.source.root && Array.isArray(previous.documentPaths) ? previous.documentPaths : [];
        sources[input.projectId] = { ...grant.source, documentPaths: [...new Set([...previousPaths, ...grant.files.map(file => file.path)])] };
      }, () => getGrant(event, input.token));
      return true;
    },
    release(event, input) { trusted(event); const grant = grants.get(input?.token); if (grant && grant.win !== getSettingsWindow()) throw new Error(AUTH_ERROR); grants.delete(input?.token); return true; },
    async forget(event, input) { const win = trusted(event), revision = visibility.version(), windowRevision = windowRevisions.get(win); if (!projectIdValid(input?.projectId)) throw new Error(AUTH_ERROR); await updateSources(sources => { delete sources[input.projectId]; }, () => validate(win, revision, windowRevision)); return true; },
    async hasSource(event, input) { const win = trusted(event), revision = visibility.version(), windowRevision = windowRevisions.get(win); if (!projectIdValid(input?.projectId)) return false; const sources = await readSources(); validate(win, revision, windowRevision); return Boolean(sources[input.projectId]); },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`knowledge-import:${name}`, async (...args) => {
    let choosingWindow;
    try {
      if (name === 'choose') { choosingWindow = trusted(args[0]); if (choosing.has(choosingWindow)) { choosingWindow = null; throw new Error(AUTH_ERROR); } choosing.add(choosingWindow); }
      return await handler(...args);
    } catch (error) {
      if ([AUTH_ERROR, FILE_ERROR, SOURCE_ERROR, IGNORE_ERROR].includes(error.message) || /^文件数量或总大小超限|^目录条目过多|^导入扫描超时/.test(error.message)) throw error;
      throw new Error(SOURCE_ERROR);
    } finally { if (choosingWindow) choosing.delete(choosingWindow); }
  });
  return { handlers };
}

module.exports = { registerKnowledgeImport, scanSource, sourceFromSelection, readChecked, ignoreRules, ignored, excluded, LIMITS, SUFFIXES };
