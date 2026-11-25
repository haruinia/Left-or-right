import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/modules/settings.js', import.meta.url), 'utf8');
const diffFunction = source.slice(source.indexOf('function changedSettings()'), source.indexOf('function validateHotkeys()'));
const saveFunction = source.slice(source.indexOf('async function saveSettings('), source.indexOf('\nhotkeyInputs().forEach'));
function setup() {
  const current = { study_language: 'Java', answer_language: 'zh-CN', interview_knowledge_project_ids: [], hotkeys: { sendChat: 'Control+Enter', captureRegion: 'Control+H' } };
  const saved = { ...current, interview_knowledge_project_ids: [], hotkeys: { captureRegion: 'Control+H', sendChat: 'Control+Enter' } };
  const button = { disabled: false };
  const posts = [];
  const sandbox = {
    savedSettings: saved,
    saving: false,
    window: {dispatchEvent() {}},
    Event: class {},
    saveState: { textContent: '' },
    readSettings: () => current,
    validateHotkeys: () => true,
    syncSavebar() {},
    $: () => button,
    postJson: async (path, body, options) => { posts.push({ path, body, options }); return { ...saved, ...body }; },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(diffFunction + saveFunction, context);
  return { current, sandbox, context, posts, button, run: (code) => vm.runInContext(code, context) };
}

test('shortcut object ordering does not mark unchanged settings as dirty', () => {
  const { run } = setup();
  assert.equal(run('Object.keys(changedSettings()).length'), 0);
});

test('project selection compares by value rather than array identity or ordering', () => {
  const { current, sandbox, run } = setup();
  current.interview_knowledge_project_ids = ['project-b', 'project-a'];
  sandbox.savedSettings.interview_knowledge_project_ids = ['project-a', 'project-b'];
  assert.equal(run('Object.keys(changedSettings()).length'), 0);
  current.interview_knowledge_project_ids = ['project-b'];
  assert.deepEqual(JSON.parse(run('JSON.stringify(changedSettings())')), { interview_knowledge_project_ids: ['project-b'] });
});

test('old preferences without a project selection do not select new projects implicitly', () => {
  const { sandbox, run } = setup();
  delete sandbox.savedSettings.interview_knowledge_project_ids;
  assert.equal(run('Object.keys(changedSettings()).length'), 0);
});

test('saving sends only changed fields, without overwriting other settings', async () => {
  const { run, current, posts } = setup();
  current.study_language = 'Rust';
  await run('saveSettings({ preventDefault() {} })');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/ui/settings');
  assert.equal(posts[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)), { study_language: 'Rust' });
});

test('saving unchanged preferences does not send a request', async () => {
  const { run, posts } = setup();
  await run('saveSettings({ preventDefault() {} })');
  assert.equal(posts.length, 0);
});

test('input typed during a pending save is retained and remains dirty', async () => {
  const { run, current, sandbox, button } = setup();
  current.study_language = 'Rust';
  let resolve;
  sandbox.postJson = () => new Promise((r) => { resolve = r; });
  const pending = run('saveSettings({ preventDefault() {} })');
  current.study_language = 'Go';
  resolve({ ...sandbox.savedSettings, study_language: 'Rust' });
  await pending;
  assert.equal(current.study_language, 'Go');
  assert.equal(run('changedSettings().study_language'), 'Go');
  assert.equal(button.disabled, false);
});

test('a successful save does not leave a permanent success notice', async () => {
  const { run, current, sandbox } = setup();
  current.study_language = 'Rust';
  await run('saveSettings({ preventDefault() {} })');
  assert.equal(sandbox.saveState.textContent, '');
});

test('settings use document summaries and separate details without an obsolete recorder', () => {
  const html = fs.readFileSync(new URL('../web/settings.html', import.meta.url), 'utf8');
  assert.match(html, /href="#knowledge">知识库/);
  assert.match(html, /id="knowledgeApp"/);
  assert.match(html, /data-briefing-detail="jd" hidden/);
  assert.match(html, /data-briefing-detail="resume" hidden/);
  assert.match(html, /data-briefing-detail="knowledge" hidden/);
  assert.match(html, /data-study-detail="instructions" hidden/);
  assert.match(html, /id="interviewKnowledgeProjects" value="\[\]"/);
  assert.match(html, /仅将选中的资料中命中片段随问题发送给当前模型/);
  assert.doesNotMatch(html, /id="interview"|interviewStart|interviewRecordingBadge|id="kbImport"|id="kbStats"|site-footer/);
  assert.doesNotMatch(html, /accept="[^"]*(?:image\/\*|\.doc,)/);
  assert.doesNotMatch(source, /interview-transcription\.js|audio-start-view|已与应用同步/);
});

test('failed saves keep input and re-enable saving', async () => {
  const { run, current, sandbox, button } = setup();
  current.study_language = 'Go';
  sandbox.postJson = async () => { throw new Error('network'); };
  await run('saveSettings({ preventDefault() {} })');
  assert.equal(current.study_language, 'Go');
  assert.equal(button.disabled, false);
  assert.match(sandbox.saveState.textContent, /保存失败/);
});
