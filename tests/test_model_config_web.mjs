import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/modules/model-config.js', import.meta.url), 'utf8');

function moduleUnderTest() {
  const elements = new Map();
  const element = (id) => ({
    id, value: '', checked: false, placeholder: '', textContent: '', disabled: false, dataset: {},
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren(...children) { this.children = children; },
    scrollIntoView() {},
  });
  for (const id of [
    '#llmProfileSelect', '#llmProfileName', '#llmBaseUrl', '#llmModel', '#llmVisionModel',
    '#llmProtocol', '#llmMaxTokens', '#llmApiPath', '#llmAuthHeader', '#llmAuthScheme',
    '#llmResponsePath', '#llmExtraBody', '#llmApiKey', '#llmClearKey', '#llmProfileState',
    '#connectedModel', '#llmModelOptions', '#llmImportText', '#llmImportState',
    '#llmNewProfile', '#llmDeleteProfile', '#saveLlmProfile', '#saveLlmApiOnly',
    '#importLlmProfile', '#llmImportFile', '#models',
  ]) elements.set(id, element(id));
  const posts = [];
  const profiles = {
    profiles: [{
      id: 'lan', name: '局域网', llm_model: 'model-a', llm_base_url: 'http://10.0.0.2:9555/v1',
      llm_protocol: 'auto', llm_api_path: '/chat/completions', llm_auth_header: 'Authorization',
      llm_auth_scheme: 'Bearer', llm_response_content_path: 'choices.0.message.content',
      llm_extra_body_json: '', llm_max_tokens: 16384, vision_model: '', llm_api_key_configured: true,
    }],
    active_profile_id: 'lan',
    presets: [{ id: 'lan', name: '局域网', models: ['model-a', 'model-b'] }],
  };
  const gateway = {
    fetchGatewayJson: async () => profiles,
    postJson: async (path, body) => { posts.push({ path, body }); return { imported: 1 }; },
    fetchGateway: async () => ({ json: async () => profiles }),
  };
  const code = source
    .replace(/import .*?from "\.\/gateway\.js";/, '')
    .replace(/import .*?from "\.\/ui\.js";/, '')
    .replaceAll('export async function', 'async function')
    .replaceAll('export function', 'function');
  const sandbox = {
    document: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: (selector) => selector.split(',').map((item) => elements.get(item.trim())).filter(Boolean),
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
  return { elements, posts, sandbox, vm };
}

test('profile list fills the saved connection and never puts a key in the page', async () => {
  const { elements, sandbox, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  assert.equal(elements.get('#llmBaseUrl').value, 'http://10.0.0.2:9555/v1');
  assert.equal(elements.get('#llmModel').value, 'model-a');
  assert.equal(elements.get('#llmMaxTokens').value, 16384);
  assert.equal(elements.get('#llmApiKey').value, '');
  assert.match(elements.get('#llmApiKey').placeholder, /已配置/);
  assert.ok(!JSON.stringify([...elements].map(([, value]) => value)).includes('secret'));
});

test('saving sends only form fields and asked-for key actions', async () => {
  const { elements, posts, sandbox, vm: runner } = moduleUnderTest();
  await runner.runInNewContext('loadProfiles()', sandbox);
  elements.get('#llmMaxTokens').value = '32768';
  elements.get('#llmApiKey').value = 'new-key';
  const result = await runner.runInNewContext('saveProfile({})', sandbox);
  assert.equal(result, true);
  assert.equal(posts[0].path, '/api/config/llm');
  assert.equal(posts[0].body.llm_max_tokens, 32768);
  assert.equal(posts[0].body.llm_api_key, 'new-key');
  assert.equal(posts[0].body.llm_base_url, 'http://10.0.0.2:9555/v1');
  assert.equal(elements.get('#llmApiKey').value, '');
});

test('imported JSON is parsed in the page and imported without enabling it', async () => {
  const { elements, posts, sandbox, vm: runner } = moduleUnderTest();
  elements.get('#llmImportText').value = JSON.stringify({ base_url: 'https://x.test/v1', model: 'm' });
  await runner.runInNewContext('importConfig()', sandbox);
  assert.equal(posts[0].path, '/api/config/llm/import');
  assert.equal(posts[0].body.config.model, 'm');
  assert.match(elements.get('#llmImportState').textContent, /保存并启用/);
  assert.equal(posts.length, 1, 'import must not also activate a profile');
});

test('invalid JSON reports an error and posts nothing', async () => {
  const { elements, posts, sandbox, vm: runner } = moduleUnderTest();
  elements.get('#llmImportText').value = '{not json';
  await runner.runInNewContext('importConfig()', sandbox);
  assert.equal(posts.length, 0);
  assert.match(elements.get('#llmImportState').textContent, /JSON/);
});
