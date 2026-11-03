import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../desktop/main/audio-capture.js', import.meta.url), 'utf8');
function fixture({ platform = 'darwin', release = '25.3.0', electron = '45.2.1', gatewayUrl = 'http://127.0.0.1:9958' } = {}) {
  const handlers = {}, calls = [];
  let destroyed = false;
  const frame = { url: `${gatewayUrl}/settings#interview` };
  const contents = { getURL: () => frame.url, mainFrame: frame };
  const mainContents = { getURL: () => 'file:///app/web/index.html' };
  const main = { isDestroyed: () => false, webContents: mainContents };
  const settings = { isDestroyed: () => destroyed, webContents: contents };
  let getSources = async options => { calls.push(options); return [{ id: 'wrong', display_id: '1' }, { id: 'right', display_id: '2' }]; };
  const context = { module: { exports: {} }, process: { platform, versions: { electron } }, URL,
    require: name => name === 'node:os' ? { release: () => release } : name === 'electron' ? {
      desktopCapturer: { getSources: options => getSources(options) }, session: { defaultSession: {
        setPermissionRequestHandler: fn => { handlers.permission = fn; },
        setPermissionCheckHandler: fn => { handlers.check = fn; },
        setDisplayMediaRequestHandler: (fn, options) => { handlers.display = fn; handlers.options = options; },
      } },
    } : require(name) };
  vm.runInNewContext(source, context);
  context.module.exports.configureAudioCapture({ gatewayUrl, rendererIndex: '/app/web/index.html', getMainWindow: () => main, getSettingsWindow: () => settings, getDisplay: () => ({ id: 2 }) });
  const capture = async overrides => { let result; await handlers.display({ frame, audioRequested: true, userGesture: true, ...overrides }, value => { result = value; }); return result; };
  return { api: context.module.exports, handlers, contents, mainContents, frame, calls, capture, destroy: () => { destroyed = true; }, sources: fn => { getSources = fn; } };
}

test('system audio capability requires a supported native runtime and operating system', () => {
  for (const options of [{release:'22.0.0'}, {release:'23.1.0'}, {electron:'33.4.11'}, {platform:'linux'}]) {
    assert.equal(fixture(options).api.audioCapabilities().systemAudioSupported, false);
  }
  assert.equal(fixture({release:'23.2.0'}).api.audioCapabilities().systemAudioSupported, true);
  assert.equal(fixture({platform:'win32'}).api.audioCapabilities().systemAudioSupported, true);
});

test('only owned trusted main-frame pages receive microphone permission', () => {
  const f = fixture();
  assert.equal(f.handlers.check(f.contents, 'media', 'http://127.0.0.1:9958', {}), true);
  assert.equal(f.handlers.check(f.contents, 'display-capture', 'http://127.0.0.1:9958', {}), true);
  assert.equal(f.handlers.check(f.mainContents, 'display-capture', 'file://', {}), false);
  assert.equal(f.handlers.check(f.contents, 'media', 'http://127.0.0.1:9958', {mediaType:'video'}), false);
  assert.equal(f.handlers.check(f.mainContents, 'media', 'file://', {}), true);
  assert.equal(f.handlers.check(f.contents, 'media', 'https://external.test', {}), false);
  assert.equal(f.handlers.check(f.contents, 'media', 'http://127.0.0.1:9958', {isMainFrame:false}), false);
  assert.equal(f.handlers.check({getURL:()=>f.frame.url}, 'media', 'http://127.0.0.1:9958', {}), false);
  assert.equal(f.handlers.check(f.contents, 'notifications', 'http://127.0.0.1:9958', {}), false);
  let allowed;
  f.handlers.permission(f.contents, 'media', value => { allowed=value; }, {requestingUrl:'https://external.test/'});
  assert.equal(allowed, false);
});

test('permission checks normalize Chromium origins without accepting other sites', () => {
  const f=fixture();
  assert.equal(f.handlers.check(f.contents,'media','http://127.0.0.1:9958/',{mediaType:'audio'}),true);
  assert.equal(f.handlers.check(f.contents,'display-capture','http://127.0.0.1:9958/',{}),true);
  for(const origin of ['http://127.0.0.1:9959/','http://127.0.0.1:9958.external.test/','http://127.0.0.1:9958@external.test/','invalid']) {
    assert.equal(f.handlers.check(f.contents,'media',origin,{mediaType:'audio'}),false);
  }
});

test('Mac audio capture does not enumerate screens or require screen recording', async () => {
  const f=fixture();f.sources(async()=>{throw Error('Screen recording denied');});
  const streams=await f.capture();
  assert.equal(streams.video,f.frame);
  assert.equal(streams.audio,'loopback');
  assert.equal(f.calls.length,0);
  f.destroy();
  assert.equal(await f.capture(),null);
});

test('Windows system capture selects the actual running display without thumbnails or muted playback', async () => {
  const f=fixture({platform:'win32'});
  const streams=await f.capture();
  assert.equal(streams.video.id,'right');
  assert.equal(streams.audio,'loopback');
  assert.equal(f.calls[0].thumbnailSize.width,0);
  assert.equal(f.calls[0].thumbnailSize.height,0);
  assert.equal(f.handlers.options.useSystemPicker,false);
});

test('capture rejects subframes, non-audio requests, missing gestures, and remote settings', async () => {
  const f=fixture();
  for (const overrides of [{frame:{url:f.frame.url}}, {audioRequested:false}, {userGesture:false}]) assert.equal(await f.capture(overrides),null);
  const remote=fixture({gatewayUrl:'https://external.test'});
  assert.equal(await remote.capture(),null);
  assert.equal(remote.handlers.check(remote.contents,'media','https://external.test',{}),false);
  assert.equal(f.calls.length,0);
});

test('late capture enumeration cannot grant a closed settings window', async () => {
  const f=fixture({platform:'win32'});let resolve;
  f.sources(()=>new Promise(done=>{resolve=done;}));
  const result=f.capture();f.destroy();resolve([{id:'right',display_id:'2'}]);
  assert.equal(await result,null);
});

test('source failure or an unavailable display is denied without leaking source details', async () => {
  const f=fixture({platform:'win32'});f.sources(async()=>{throw Error('private source information');});
  assert.equal(await f.capture(),null);
  f.sources(async()=>[{id:'wrong',display_id:'1'}]);
  assert.equal(await f.capture(),null);
});
