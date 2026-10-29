import assert from 'node:assert/strict';
import test from 'node:test';

const local = new Map();
globalThis.window = { location: { origin: 'file://', protocol: 'file:', search: '' }, __GATEWAY_KEY__: 'shell-key' };
globalThis.sessionStorage = { getItem: () => null };
globalThis.localStorage = {
  getItem: key => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, value),
};
const { createAssetStore } = await import('../web/modules/asset-storage.js');

test('legacy migration only acknowledges durable success, retries failure and never erases backup', async () => {
  const old = [{ id: 'legacy', answer: 'keep me' }];
  local.set('migration-test', JSON.stringify(old));
  const store = createAssetStore('knowledge', 'migration-test');
  const calls = [];
  let unavailable = true;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (unavailable) throw new TypeError('offline');
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ service: 'shuihuo-killer-gateway' }) };
    return { ok: true, json: async () => url.endsWith('/migrate') ? { ok: true } : { items: old } };
  };
  await assert.rejects(store.list(), /启动网关后重试/);
  assert.equal(local.get('migration-test_shared_v1'), undefined);
  unavailable = false;
  assert.deepEqual(await store.list(), old);
  assert.equal(local.get('migration-test_shared_v1'), 'done');
  assert.equal(local.get('migration-test'), JSON.stringify(old));
  const migrated = calls.find(call => call.url.endsWith('/migrate') && call.options.body);
  assert.deepEqual(JSON.parse(migrated.options.body), { items: old });
  assert.equal(migrated.options.headers['X-API-Key'], 'shell-key');
  assert.match(migrated.url, /^http:\/\/127\.0\.0\.1:9958\//);
});

test('per-record writes and deletes do not send stale collection snapshots', async () => {
  const store = createAssetStore('feedback', 'write-test');
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ item: JSON.parse(options.body).item }) };
  };
  assert.deepEqual(await store.put({ id: 'new' }), { id: 'new' });
  await store.remove('old');
  assert.match(calls[0].url, /feedback\/upsert$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { item: { id: 'new' } });
  assert.deepEqual(JSON.parse(calls[1].options.body), { id: 'old' });
});

test('an assets module import with live settings elements completes without TDZ startup errors', async () => {
  const elements = new Map();
  for (const id of ['#assetTabs', '#assetRecords', '#assetKB', '#assetExams', '#recordsList',
    '#kbList', '#kbTags', '#kbStats', '#kbSearch', '#examsList']) {
    elements.set(id, {
      innerHTML: '', value: '', addEventListener() {}, querySelector() { return null; },
    });
  }
  globalThis.document = { querySelector: selector => elements.get(selector) ?? null };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
  await import('../web/modules/assets.js');
  // Network completions render on subsequent microtasks.
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('#recordsList').innerHTML, /还没有保存的会话记录/);
  assert.match(elements.get('#kbStats').innerHTML, /共 0 条/);
  assert.match(elements.get('#examsList').innerHTML, /还没有笔试记录/);
});
