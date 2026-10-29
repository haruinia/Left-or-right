import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/modules/model-config.js', import.meta.url), 'utf8');

function element(id) {
  return {
    id, value: '', checked: false, placeholder: '', textContent: '', disabled: false, hidden: false,
    dataset: {}, children: [],
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren(...children) { this.children = children; },
    closest(selector) { return selector === '#llmPresetBlock' ? elements.get('#llmPresetBlock') : null; },
    focus() {},
    scrollIntoView() {},
  };
}

const elements = new Map();

function moduleUnderTest() {
  elements.clear();
  for (const id of [
    '#llmCurrent', '#llmName', '#llmBaseUrl', '#llmModel', '#llmMaxTokens', '#llmApiKey',
    '#llmProfileState', '#llmFormTitle', '#llmEditTag', '#llmCancelEdit', '#llmModelOptions',
    '#llmProfileCards', '#llmPresetCards', '#llmPresetBlock', '#llmImportText', '#llmImportState',
    '#llmNewProfile', '#saveLlmProfile', '#importLlmProfile', '#llmImportFile', '#models',
  ]) elements.set(id, element(id));
  const posts = [];
  const profile = (overrides = {}) => ({
    id: 'lan', name: '局域网', llm_model: 'model-a', llm_base_url: 'http://10.0.0.2:9555/v1',
    llm_protocol: 'auto', llm_api_path: '/chat/completions', llm_auth_header: 'Authorization',
    llm_auth_scheme: 'Bearer', llm_response_content_path: 'choices.0.message.content',
    llm_extra_body_json: '', llm_max_tokens: 30000, vision_model: '', llm_api_key_configured: true,
    ...overrides,
  });
  const profiles = {
    profiles: [profile()],
    active_profile_id: 'lan',
    presets: [{ id: 'silicon', name: 'SiliconFlow', llm_base_url: 'https://api.siliconflow.cn/v1', llm_model: 'deepseek-ai/DeepSeek-V4.1-Flash', models: ['deepseek-ai/DeepSeek-V4.1-Flash'] }],
  };
  const response = { json: async () => profiles };
  const gateway = {
    fetchGatewayJson: async () => profiles,
    postJson: async (path, body) => { posts.push({ path, body }); return { imported: 1, ...profiles }; },
    fetchGateway: async () => response,
  };
  const code = source
    .replace(/import .*?from "\.\/gateway\.js";/, '')
    .replace(/import .*?from "\.\/ui\.js";/, '')
    .replaceAll('export async function', 'async function')
    .replaceAll('export function', 'function');
  const sandbox = {
    document: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [],
    },
    location: { hash: '' },
    FileReader: class {},
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    appendEvent() {},
    escapeHtml: (value) => String(value),
    console,
    ...gateway,
  };
  vm.runInNewContext(code, sandbox);
  return { sandbox, posts, vm };
}

test('profile list fills the active connection and never puts a key in the page', async () => {
  const { sandbox, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  assert.equal(elements.get('#llmBaseUrl').value, 'http://10.0.0.2:9555/v1');
  assert.equal(elements.get('#llmModel').value, 'model-a');
  assert.equal(elements.get('#llmName').value, '局域网');
  assert.equal(elements.get('#llmMaxTokens').value, '30000');
  assert.equal(elements.get('#llmApiKey').value, '');
  assert.match(elements.get('#llmApiKey').placeholder, /已配置/);
  assert.match(elements.get('#llmCurrent').innerHTML, /当前使用/);
  assert.match(elements.get('#llmCurrent').innerHTML, /局域网/);
  assert.ok(!elements.get('#llmCurrent').innerHTML.includes('secret'));
  assert.ok(!JSON.stringify([...elements].map(([, value]) => value)).includes('secret'));
});

test('saving sends only form fields and asked-for key actions', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  elements.get('#llmMaxTokens').value = '32768';
  elements.get('#llmApiKey').value = 'new-key';
  const result = await runner.runInNewContext('saveProfile()', sandbox);
  assert.equal(result, true);
  assert.equal(posts[0].path, '/api/config/llm');
  assert.equal(posts[0].body.llm_max_tokens, 32768);
  assert.equal(posts[0].body.llm_api_key, 'new-key');
  assert.equal(posts[0].body.llm_base_url, 'http://10.0.0.2:9555/v1');
  assert.equal(posts[0].body.profile_id, 'lan');
  assert.equal(elements.get('#llmApiKey').value, '');
});

test('saving the same address and model updates that profile instead of duplicating it', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  sandbox.__profiles = {
    profiles: [
      { id: 'lan', name: '局域网', llm_model: 'model-a', llm_base_url: 'http://10.0.0.2:9555/v1', llm_max_tokens: 30000, llm_api_key_configured: true },
      { id: 'other', name: '备用', llm_model: 'model-b', llm_base_url: 'https://other.test/v1', llm_max_tokens: 30000, llm_api_key_configured: true },
    ],
    active_profile_id: 'lan',
    presets: [],
  };
  runner.runInNewContext('applyProfiles(__profiles)', sandbox);
  runner.runInNewContext('fillForm(null)', sandbox);
  elements.get('#llmBaseUrl').value = 'https://other.test/v1';
  elements.get('#llmModel').value = 'model-b';
  await runner.runInNewContext('saveProfile()', sandbox);
  assert.equal(posts[0].body.profile_id, 'other');
});

test('activating a saved profile posts its id and keeps the form in sync', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  await runner.runInNewContext('activateProfile("lan")', sandbox);
  assert.equal(posts[0].path, '/api/config/llm/activate');
  assert.equal(posts[0].body.profile_id, 'lan');
  assert.match(elements.get('#llmProfileState').textContent, /已启用/);
});

test('a preset only fills the form and does not call the gateway', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  runner.runInNewContext('handlePresetClick({ target: { closest: () => ({ dataset: { preset: "silicon" } }) } })', sandbox);
  assert.equal(posts.length, 0);
  assert.equal(elements.get('#llmBaseUrl').value, 'https://api.siliconflow.cn/v1');
  assert.equal(elements.get('#llmModel').value, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(elements.get('#llmName').value, 'SiliconFlow');
  assert.match(elements.get('#llmProfileState').textContent, /保存并启用/);
});

test('imported JSON is parsed in the page and imported without enabling it', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  elements.get('#llmImportText').value = JSON.stringify({ base_url: 'https://x.test/v1', model: 'm' });
  await runner.runInNewContext('importConfig()', sandbox);
  assert.equal(posts[0].path, '/api/config/llm/import');
  assert.equal(posts[0].body.config.model, 'm');
  assert.match(elements.get('#llmImportState').textContent, /保存启用/);
  assert.equal(posts.length, 1, 'import must not also activate a profile');
});

test('invalid JSON reports an error and posts nothing', async () => {
  const { sandbox, posts, vm: runner } = moduleUnderTest();
  elements.get('#llmImportText').value = '{not json';
  await runner.runInNewContext('importConfig()', sandbox);
  assert.equal(posts.length, 0);
  assert.match(elements.get('#llmImportState').textContent, /JSON/);
});
