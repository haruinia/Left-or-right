import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerKnowledgeImport, sourceFromSelection, scanSource, readChecked, ignoreRules, ignored, excluded, LIMITS } = require('../desktop/main/knowledge-import.js');

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-import-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const write = async (relative, content = '# Project\nLocal text') => { const absolute = path.join(root, relative); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content); return absolute; };
  return { directory, root, write };
}

async function ipcFixture(t, options = {}) {
  const f = await fixture(t), handlers = new Map();
  const win = new EventEmitter();
  win.visible = true; win.destroyed = false;
  win.isVisible = () => win.visible; win.isDestroyed = () => win.destroyed;
  win.webContents = new EventEmitter(); win.webContents.mainFrame = {};
  win.webContents.getURL = () => 'http://127.0.0.1:9958/settings#knowledge';
  win.hide = () => { win.visible = false; win.emit('hide'); };
  win.show = () => { throw Error('Importer must not show windows'); }; win.focus = win.show;
  let revision = 1, allowed = true;
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  let picks = 0;
  const dialog = { async showOpenDialog() { picks += 1; return options.choose ? options.choose(f, win) : { canceled: false, filePaths: [f.root] }; } };
  const visibility = { version: () => revision, canShow: value => value === revision && allowed };
  registerKnowledgeImport({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog, getSettingsWindow: () => win, gatewayUrl: 'http://127.0.0.1:9958', visibility, sourcesPath: path.join(f.directory, 'sources.json') });
  const invoke = (name, input, sender = event) => handlers.get(`knowledge-import:${name}`)(sender, input);
  return { ...f, win, invoke, event, picks: () => picks, invalidate() { revision += 1; }, capturing(value) { allowed = !value; } };
}

test('folder scan retains relative structure and excludes credentials, builds and unsupported files', async t => {
  const f = await fixture(t);
  for (const name of ['docs/readme.md', 'src/main.ts', '.env', '.env.local', 'secret.json', 'credentials.yaml', 'model_profiles.json', 'id_rsa', 'keys/private.key', 'node_modules/pkg/readme.md', '.git/config', 'dist/output.js', 'image.png']) await f.write(name);
  const source = await sourceFromSelection('folder', [f.root]);
  const result = await scanSource(source);
  assert.deepEqual(result.files.map(file => file.path), ['docs/readme.md', 'src/main.ts']);
  assert.ok(result.skipped.some(file => file.path === '.env' && file.reason === '敏感文件'));
  assert.ok(result.skipped.some(file => file.path === 'node_modules'));
  assert.equal(JSON.stringify(result.files).includes(f.root), false);
});

test('nested gitignore handles anchored, negation, directory, globstar and escaped characters', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '*.log\n!keep.log\n/cache/\n**/draft*.md\n\\#private.txt\n');
  await f.write('docs/.gitignore', '/local.md\n!draft-public.md\n');
  for (const name of ['a.log', 'keep.log', 'cache/readme.md', 'src/cache/readme.md', 'docs/local.md', 'docs/deep/local.md', 'draft.md', 'docs/draft-a.md', 'docs/draft-public.md', '#private.txt', 'readme.md']) await f.write(name);
  const result = await scanSource(await sourceFromSelection('folder', [f.root]));
  assert.deepEqual(result.files.map(file => file.path), ['docs/deep/local.md', 'docs/draft-public.md', 'keep.log', 'readme.md', 'src/cache/readme.md']);
  assert.equal(ignored('foo bar.md', false, ignoreRules('foo\\ bar.md')), true);
  assert.equal(ignored('a.md', false, ignoreRules('[ab].md')), true);
});

test('oversized gitignore aborts import with an actionable error rather than ignoring its rules', async t => {
  const f = await ipcFixture(t); await f.write('readme.md'); await f.write('.gitignore', '#'.repeat(64 * 1024 + 1));
  await assert.rejects(f.invoke('choose', { kind: 'folder' }), /\.gitignore 超过 64 KiB/);
  await fs.unlink(path.join(f.root, '.gitignore')); await f.write('docs/.gitignore', '#'.repeat(64 * 1024 + 1));
  await assert.rejects(f.invoke('choose', { kind: 'folder' }), /\.gitignore 超过 64 KiB/);
});

test('ignored directory cannot be resurrected by a file-only negation', async t => {
  const f = await fixture(t); await f.write('.gitignore', 'private/\n!private/keep.md'); await f.write('private/keep.md');
  assert.deepEqual((await scanSource(await sourceFromSelection('folder', [f.root]))).files, []);
});

test('symlink sources are rejected and symlink children are skipped without being read', async t => {
  const f = await fixture(t); await f.write('readme.md');
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.md'), 'Do not import');
  await fs.symlink(outside, path.join(f.root, 'external'));
  await fs.symlink(path.join(outside, 'secret.md'), path.join(f.root, 'alias.md'));
  await assert.rejects(sourceFromSelection('folder', [path.join(f.root, 'external')]));
  const result = await scanSource(await sourceFromSelection('folder', [f.root]));
  assert.deepEqual(result.files.map(file => file.path), ['readme.md']);
  assert.equal(result.skipped.filter(file => /链接/.test(file.reason)).length, 2);
});

test('ancestor replacement after manifest creation cannot read a new linked target', async t => {
  const f = await fixture(t); const absolute = await f.write('docs/readme.md');
  const source = await sourceFromSelection('folder', [f.root]), result = await scanSource(source), entry = result.entries.get(result.files[0].id);
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'readme.md'), 'private');
  await fs.rename(path.dirname(absolute), path.join(f.root, 'old-docs')); await fs.symlink(outside, path.join(f.root, 'docs'));
  await assert.rejects(readChecked(f.root, entry.absolute, entry.stat, result.rootStat), /重新选择/);
});

test('file replacement, edits and root replacement invalidate a scanned manifest', async t => {
  const f = await fixture(t); const absolute = await f.write('readme.md');
  const source = await sourceFromSelection('folder', [f.root]), result = await scanSource(source), entry = result.entries.get(result.files[0].id);
  await fs.writeFile(absolute, 'changed');
  await assert.rejects(readChecked(f.root, absolute, entry.stat, result.rootStat));
  await fs.rename(f.root, path.join(f.directory, 'old-root')); await fs.mkdir(f.root); await fs.writeFile(absolute, 'replacement');
  await assert.rejects(readChecked(f.root, absolute, entry.stat, result.rootStat));
});

test('manifest size and scan limits fail explicitly instead of silently returning an incomplete refresh', async t => {
  const f = await fixture(t); await f.write('a.md', 'aaa'); await f.write('b.md', 'bbb');
  const source = await sourceFromSelection('folder', [f.root]);
  for (const patch of [{ files: 1 }, { totalBytes: 4 }, { visited: 1 }, { milliseconds: -1 }]) await assert.rejects(scanSource(source, { limits: { ...LIMITS, ...patch } }), /超限|超时|条目过多/);
  const result = await scanSource(source, { limits: { ...LIMITS, fileBytes: 2 } });
  assert.equal(result.files.length, 0); assert.equal(result.skipped.length, 2);
});

test('explicit file selection keeps relative paths and never accepts traversal in persisted sources', async t => {
  const f = await fixture(t); const a = await f.write('docs/a.md'), b = await f.write('src/b.py');
  const source = await sourceFromSelection('files', [a, b]), result = await scanSource(source);
  assert.deepEqual(result.files.map(file => file.path), ['docs/a.md', 'src/b.py']);
  for (const selectedFiles of [['../outside.md'], ['/etc/passwd'], ['docs/../docs/a.md']]) await assert.rejects(scanSource({ kind: 'files', root: f.root, selectedFiles }));
});

test('IPC only accepts the visible trusted settings main frame on the exact gateway', async t => {
  const f = await ipcFixture(t); await f.write('readme.md');
  for (const event of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.event.sender, senderFrame: {} }]) await assert.rejects(f.invoke('choose', { kind: 'folder' }, event), /授权已失效/);
  f.win.webContents.getURL = () => 'http://127.0.0.1:9960/settings'; await assert.rejects(f.invoke('choose', { kind: 'folder' }), /授权已失效/);
  f.win.webContents.getURL = () => 'http://127.0.0.1:9958/'; await assert.rejects(f.invoke('choose', { kind: 'folder' }), /授权已失效/);
  assert.equal(f.picks(), 0);
});

test('picker completion after hide and capture restoration cannot return a fresh grant', async t => {
  let resolve;
  const f = await ipcFixture(t, { choose: () => new Promise(done => { resolve = done; }) });
  const pending = f.invoke('choose', { kind: 'folder' });
  f.win.hide(); f.win.visible = true;
  resolve({ canceled: false, filePaths: [f.root] });
  await assert.rejects(pending, /授权已失效/);
});

test('concurrent pickers do not open parallel dialogs and hide invalidates an existing read grant', async t => {
  const f = await ipcFixture(t); await f.write('readme.md');
  const first = f.invoke('choose', { kind: 'folder' });
  await assert.rejects(f.invoke('choose', { kind: 'folder' }), /授权已失效/);
  const grant = await first; assert.equal(f.picks(), 1);
  const item = grant.files[0]; assert.equal(Buffer.from((await f.invoke('read', { token: grant.token, id: item.id })).base64, 'base64').toString(), '# Project\nLocal text');
  f.win.hide(); f.win.visible = true;
  await assert.rejects(f.invoke('read', { token: grant.token, id: item.id }), /授权已失效/);
});

test('unknown files, changed privacy revisions, navigation, expiry and release revoke reads', async t => {
  const f = await ipcFixture(t); await f.write('readme.md');
  let grant = await f.invoke('choose', { kind: 'folder' });
  await assert.rejects(f.invoke('read', { token: grant.token, id: '../readme.md' }), /授权已失效/);
  f.invalidate(); await assert.rejects(f.invoke('read', { token: grant.token, id: grant.files[0].id }), /授权已失效/);
  grant = await f.invoke('choose', { kind: 'folder' });
  f.win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:9958/settings#knowledge/import', true, true);
  f.win.webContents.getURL = () => 'http://127.0.0.1:9958/settings#knowledge/import';
  assert.ok((await f.invoke('read', { token: grant.token, id: grant.files[0].id })).base64);
  f.win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:9958/settings', false, false);
  assert.ok((await f.invoke('read', { token: grant.token, id: grant.files[0].id })).base64);
  f.win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:9958/settings', false, true);
  await assert.rejects(f.invoke('read', { token: grant.token, id: grant.files[0].id }), /授权已失效/);
  grant = await f.invoke('choose', { kind: 'folder' }); await f.invoke('release', { token: grant.token });
  await assert.rejects(f.invoke('read', { token: grant.token, id: grant.files[0].id }), /授权已失效/);
  grant = await f.invoke('choose', { kind: 'folder' });
  const original = Date.now; Date.now = () => original() + LIMITS.lifetime + 1;
  try { await assert.rejects(f.invoke('read', { token: grant.token, id: grant.files[0].id }), /授权已失效/); } finally { Date.now = original; }
});

test('manual refresh re-scans a privately saved source without opening another picker', async t => {
  const f = await ipcFixture(t); await f.write('readme.md');
  const grant = await f.invoke('choose', { kind: 'folder' });
  await f.invoke('bind', { token: grant.token, projectId: 'project-123' });
  assert.equal(await f.invoke('hasSource', { projectId: 'project-123' }), true);
  const stat = await fs.stat(path.join(f.directory, 'sources.json'));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  await f.write('new.md'); await fs.unlink(path.join(f.root, 'readme.md'));
  const refresh = await f.invoke('choose', { kind: 'refresh', projectId: 'project-123' });
  assert.deepEqual(refresh.files.map(file => file.path), ['new.md']); assert.equal(f.picks(), 1);
  assert.deepEqual(refresh.refreshPaths, ['readme.md']);
  await f.invoke('bind', { token: refresh.token, projectId: 'project-123' });
  const next = await f.invoke('choose', { kind: 'refresh', projectId: 'project-123' });
  assert.deepEqual(next.refreshPaths.sort(), ['new.md', 'readme.md']);
  assert.equal(JSON.stringify(refresh).includes(f.root), false);
  for (const projectId of ['__proto__', 'constructor', '../other', '']) await assert.rejects(f.invoke('bind', { token: next.token, projectId }), /授权已失效/);
  await f.invoke('forget', { projectId: 'project-123' });
  assert.equal(await f.invoke('hasSource', { projectId: 'project-123' }), false);
});

test('source read failures never disclose absolute paths and capture blocks every operation', async t => {
  const f = await ipcFixture(t); await f.write('readme.md'); const grant = await f.invoke('choose', { kind: 'folder' });
  await fs.unlink(path.join(f.root, 'readme.md'));
  await assert.rejects(f.invoke('read', { token: grant.token, id: grant.files[0].id }), error => !error.message.includes(f.directory) && /重新选择/.test(error.message));
  f.capturing(true);
  for (const [name, input] of [['hasSource', { projectId: 'a' }], ['forget', { projectId: 'a' }], ['release', { token: grant.token }], ['choose', { kind: 'folder' }]]) await assert.rejects(f.invoke(name, input), /授权已失效/);
});

test('hard exclusions remain stronger than gitignore negation', () => {
  for (const filename of ['.env.local', '.environment', 'config/secrets.yaml', 'credential.json', 'credentials.json', 'token.json', 'tokens.json', 'passwords.txt', 'private_key.json', 'service-account.json', 'service_account.yaml', 'keys/private.pem', 'asr_profiles.json', 'node_modules/a.md', '.ssh/config.txt', '.aws/config.ini', '.azure/account.json', '.kube/config.yaml', 'output/report.md', 'bower_components/pkg/index.js', '.terraform/state.json']) assert.ok(excluded(filename), filename);
});
