import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../web/modules/model-config.js', import.meta.url), 'utf8');
function moduleUnderTest() {
  const elements = new Map();
  for (const id of ['llmBaseUrl', 'llmModel', 'llmMaxTokens', 'llmApiKey', 'llmToggleKey', 'llmProfileState', 'llmFormTitle', 'llmModelOptions', 'llmProfileCards', 'llmPresetCards', 'llmPresetBlock', 'llmImportText', 'llmImportState', 'llmNewProfile', 'saveLlmProfile', 'importLlmProfile', 'llmImportFile', 'llmCancelEdit', 'llmForm', 'checkModel']) {
    elements.set(`#${id}`, {
      value: '', type: 'password', textContent: '', dataset: {}, disabled: false, hidden: false, listeners: {}, attributes: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren() {}, focus() {}, select() {},
    });
  }
  const store = {
    active_profile_id: 'lan',
    profiles: [{ id: 'lan', llm_model: 'model-a', llm_base_url: 'http://10.0.0.2:9555/v1', llm_protocol: 'auto', llm_api_path: '/chat/completions', llm_auth_header: 'Authorization', llm_auth_scheme: 'Bearer', llm_response_content_path: 'choices.0.message.content', llm_extra_body_json: '', llm_max_tokens: 30000, vision_model: '', llm_api_key_configured: true }],
    presets: [{ id: 'cloud', name: '云端备用', llm_base_url: 'https://api.example.test/v1', llm_model: 'model-b', models: ['model-b'] }],
  };
  const posts = [];
  const sandbox = {
    document: { querySelector: (s) => elements.get(s) || null },
    crypto: webcrypto,
    Option: class {},
    confirm: () => true,
    escapeHtml: (s) => String(s),
    fetchGatewayJson: async () => store,
    fetchGateway: async () => ({ json: async () => store }),
    postJson: async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith('/key')) return { llm_api_key: 'saved-test-secret' };
      if (path.endsWith('/activate')) store.active_profile_id = body.profile_id;
      return { ...store, imported: 1 };
    },
  };
  const code = source.replace(/^import .*;$/gm, '').replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  const run = (code) => vm.runInContext(code, context);
  run('wireModelConfig()');
  return { elements, store, posts, sandbox, run };
}

test('saved key displays a mask and remains private until explicitly revealed', async () => {
  const { run, elements, posts } = moduleUnderTest();
  await run('loadProfiles()');
  assert.equal(elements.get('#llmApiKey').value, '************');
  assert.equal(elements.get('#llmApiKey').type, 'password');
  assert.equal(posts.length, 0);
  assert.ok(!elements.get('#llmProfileCards').innerHTML.includes('saved-test-secret'));
  await run('toggleKey()');
  assert.equal(posts[0].path, '/api/config/llm/profiles/lan/key');
  assert.equal(elements.get('#llmApiKey').value, 'saved-test-secret');
  assert.equal(elements.get('#llmApiKey').type, 'text');
  assert.equal(elements.get('#llmToggleKey').attributes['aria-pressed'], 'true');
  await run('toggleKey()');
  assert.equal(elements.get('#llmApiKey').type, 'password');
  assert.equal(posts.length, 1);
});

test('saving an untouched masked key never sends the mask as a credential', async () => {
  const { run, posts } = moduleUnderTest();
  await run('loadProfiles()');
  assert.equal(await run('saveProfile()'), true);
  assert.equal(posts[0].body.profile_id, 'lan');
  assert.equal(posts[0].body.llm_api_key, '');
  assert.equal(posts[0].body.clear_api_key, false);
  assert.equal(posts[0].body.llm_max_tokens, 30000);
});

test('editing and clearing a key send the requested credential change', async () => {
  const { run, elements, posts } = moduleUnderTest();
  await run('loadProfiles()');
  const input = elements.get('#llmApiKey');
  input.value = 'new-test-key';
  input.listeners.input();
  await run('saveProfile()');
  assert.equal(posts[0].body.llm_api_key, 'new-test-key');
  input.value = '';
  input.listeners.input();
  await run('saveProfile()');
  assert.equal(posts[1].body.clear_api_key, true);
});

test('new profile uses a distinct id and a 30000 token default', async () => {
  const { run, elements, posts } = moduleUnderTest();
  await run('loadProfiles()');
  elements.get('#llmNewProfile').listeners.click();
  assert.equal(elements.get('#llmApiKey').value, '');
  elements.get('#llmBaseUrl').value = 'https://other.test/v1';
  elements.get('#llmModel').value = 'other';
  await run('saveProfile()');
  assert.notEqual(posts[0].body.profile_id, 'lan');
  assert.equal(posts[0].body.llm_max_tokens, 30000);
});

test('new duplicate connection reuses the saved profile id', async () => {
  const { run, elements, posts } = moduleUnderTest();
  await run('loadProfiles()');
  elements.get('#llmNewProfile').listeners.click();
  elements.get('#llmBaseUrl').value = 'http://10.0.0.2:9555/v1/';
  elements.get('#llmModel').value = 'model-a';
  await run('saveProfile()');
  assert.equal(posts[0].body.profile_id, 'lan');
});

test('changing provider resets protocol metadata and does not send the revealed old key', async () => {
  const { run, elements, posts, store } = moduleUnderTest();
  store.profiles[0].llm_protocol = 'anthropic_messages';
  await run('loadProfiles()');
  await run('toggleKey()');
  elements.get('#llmBaseUrl').value = 'https://other.test/v1';
  await run('saveProfile()');
  assert.equal(posts[1].body.llm_api_key, '');
  assert.equal(posts[1].body.llm_protocol, 'auto');
});

test('preset fills the three fields without saving or activating', async () => {
  const { run, elements, posts, store } = moduleUnderTest();
  store.presets[0].llm_api_key_configured = true;
  await run('loadProfiles()');
  elements.get('#llmPresetCards').listeners.click({ target: { closest: () => ({ dataset: { preset: 'cloud' } }) } });
  assert.equal(posts.length, 0);
  assert.equal(elements.get('#llmBaseUrl').value, 'https://api.example.test/v1');
  assert.equal(elements.get('#llmModel').value, 'model-b');
  assert.equal(elements.get('#llmApiKey').value, '');
});

test('import does not change the active profile or overwrite unsaved form input', async () => {
  const { run, elements, posts } = moduleUnderTest();
  await run('loadProfiles()');
  elements.get('#llmModel').value = 'unsaved-draft';
  elements.get('#llmImportText').value = '{"base_url":"https://x.test/v1","model":"imported"}';
  await run('importConfig()');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/config/llm/import');
  assert.equal(elements.get('#llmModel').value, 'unsaved-draft');
  assert.equal(elements.get('#llmImportText').value, '');
});

test('invalid JSON is reported without sending a request', async () => {
  const { run, elements, posts } = moduleUnderTest();
  elements.get('#llmImportText').value = '{bad';
  await run('importConfig()');
  assert.equal(posts.length, 0);
  assert.match(elements.get('#llmImportState').textContent, /JSON/);
});

test('late reveal response cannot overwrite a newly selected profile', async () => {
  const { run, elements, sandbox } = moduleUnderTest();
  await run('loadProfiles()');
  let resolve;
  sandbox.postJson = () => new Promise((r) => { resolve = r; });
  const request = run('toggleKey()');
  run('fillForm(null)');
  resolve({ llm_api_key: 'previous-secret' });
  await request;
  assert.equal(elements.get('#llmApiKey').value, '');
  assert.equal(elements.get('#llmApiKey').type, 'password');
});

test('late reveal response cannot overwrite a key typed while fetching', async () => {
  const { run, elements, sandbox } = moduleUnderTest();
  await run('loadProfiles()');
  let resolve;
  sandbox.postJson = () => new Promise((r) => { resolve = r; });
  const request = run('toggleKey()');
  elements.get('#llmApiKey').value = 'new-key';
  elements.get('#llmApiKey').listeners.input();
  resolve({ llm_api_key: 'previous-secret' });
  await request;
  assert.equal(elements.get('#llmApiKey').value, 'new-key');
});
