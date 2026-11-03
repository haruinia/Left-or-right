import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../desktop/main/capture.js', import.meta.url), 'utf8');

function captureModule({ scaleFactor = 1.5, width = 1600, height = 900, actualWidth, actualHeight, pngLength = 16 } = {}) {
  const display = { id: 42, bounds: { x: -1600, y: -200, width, height }, scaleFactor };
  let displays = [display, { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const calls = [];
  class Image {
    constructor(w, h, marker = 'target') { this.width = w; this.height = h; this.marker = marker; }
    isEmpty() { return false; }
    getSize() { return { width: this.width, height: this.height }; }
    crop(rect) { calls.push({ crop: rect }); return new Image(rect.width, rect.height, this.marker); }
    resize(size) { calls.push({ resize: size }); return new Image(size.width, size.height, this.marker); }
    toPNG() { return pngLength > 100 ? Buffer.alloc(pngLength) : Buffer.from(this.marker); }
    toJPEG(quality) { calls.push({ quality }); return Buffer.from('jpeg'); }
  }
  const image = new Image(actualWidth ?? Math.round(width * scaleFactor), actualHeight ?? Math.round(height * scaleFactor));
  let sources = [{ display_id: '7', thumbnail: new Image(1920, 1080, 'wrong-screen') }, { display_id: '42', thumbnail: image }];
  const electron = {
    screen: { getAllDisplays: () => displays },
    desktopCapturer: { getSources: async options => { calls.push({ sources: options }); return sources; } },
  };
  const sandbox = { module: { exports: {} }, process: { platform: 'win32' }, Buffer, URLSearchParams,
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:child_process') return { execFile() { throw Error('Windows must not execute a macOS command'); } };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  const options = { interactive: false, displayId: '42', displayBounds: { ...display.bounds }, scaleFactor };
  return { api: sandbox.module.exports, options, calls, image, electron,
    setSources: value => { sources = value; },
    setDisplays: value => { displays = value; },
    display,
  };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('Windows capture matches the display id, not source order or one-based index', async () => {
  const { api, options, calls } = captureModule();
  const result = await api.captureScreenshot({ ...options, displayIndex: 1 });
  assert.equal(result.mime, 'image/png');
  assert.equal(result.data.toString(), 'target');
  assert.deepEqual(plain(calls[0].sources), { types: ['screen'], thumbnailSize: { width: 2400, height: 1350 }, fetchWindowIcons: false });
  assert.equal(calls.filter(call => call.crop).length, 0);
});

for (const scale of [1.25, 1.5, 2]) {
  test(`Windows region capture respects ${scale * 100}% DPI and actual thumbnail resolution`, async () => {
    const actualWidth = Math.round(1600 * scale / 2);
    const actualHeight = Math.round(900 * scale / 2);
    const { api, options, calls } = captureModule({ scaleFactor: scale, actualWidth, actualHeight });
    const rect = { x: Math.round(10 * scale), y: Math.round(20 * scale), width: Math.round(100 * scale), height: Math.round(80 * scale) };
    await api.captureScreenshot({ ...options, rect });
    const expectedWidth = Math.round(1600 * scale), expectedHeight = Math.round(900 * scale);
    const x = Math.floor(rect.x * actualWidth / expectedWidth), y = Math.floor(rect.y * actualHeight / expectedHeight);
    assert.deepEqual(plain(calls.find(call => call.crop).crop), {
      x, y,
      width: Math.ceil((rect.x + rect.width) * actualWidth / expectedWidth) - x,
      height: Math.ceil((rect.y + rect.height) * actualHeight / expectedHeight) - y,
    });
    assert.ok(x >= 0 && y >= 0, 'negative desktop origin must not be added to local crop coordinates');
  });
}

test('regions partially outside the display are clipped to image bounds', async () => {
  const { api, options, calls } = captureModule({ scaleFactor: 1, width: 100, height: 80 });
  await api.captureScreenshot({ ...options, rect: { x: -10, y: 60, width: 150, height: 30 } });
  assert.deepEqual(plain(calls.find(call => call.crop).crop), { x: 0, y: 60, width: 100, height: 20 });
});

for (const rect of [
  { x: 0, y: 0, width: 0, height: 10 },
  { x: 0, y: 0, width: -1, height: 10 },
  { x: NaN, y: 0, width: 20, height: 20 },
  { x: 0, y: Infinity, width: 20, height: 20 },
  { x: 9000, y: 0, width: 20, height: 20 },
]) {
  test(`invalid Windows crop does not return a wrong-screen image (${JSON.stringify(rect)})`, async () => {
    const { api, options } = captureModule();
    await assert.rejects(api.captureScreenshot({ ...options, rect }), /截图区域/);
  });
}

test('a missing or disconnected target is rejected without capturing another source', async () => {
  const { api, options, setSources, setDisplays, calls } = captureModule();
  setSources([{ display_id: '7', thumbnail: {} }]);
  await assert.rejects(api.captureScreenshot(options), /运行显示器/);
  setDisplays([]);
  const count = calls.length;
  await assert.rejects(api.captureScreenshot(options), /断开/);
  assert.equal(calls.length, count);
});

test('disconnecting or changing DPI while capture sources are loading cancels safely', async () => {
  for (const change of ['disconnect', 'dpi', 'bounds']) {
    const { api, options, electron, setDisplays, display } = captureModule();
    electron.desktopCapturer.getSources = async () => {
      if (change === 'disconnect') setDisplays([]);
      if (change === 'dpi') display.scaleFactor = 2;
      if (change === 'bounds') display.bounds = { ...display.bounds, width: 1200 };
      return [{ display_id: '42', thumbnail: {} }];
    };
    await assert.rejects(api.captureScreenshot(options), /断开|配置已变化/);
  }
});

test('Windows capture errors propagate without macOS tools or a primary-display fallback', async () => {
  const { api, options, electron } = captureModule();
  electron.desktopCapturer.getSources = async () => { throw new Error('capture permission denied'); };
  await assert.rejects(api.captureScreenshot(options), /permission denied/);
});

test('empty Windows thumbnails or output are rejected', async () => {
  const { api, options, image } = captureModule();
  image.isEmpty = () => true;
  await assert.rejects(api.captureScreenshot(options), /截图为空/);
  image.isEmpty = () => false;
  image.toPNG = () => Buffer.alloc(0);
  await assert.rejects(api.captureScreenshot(options), /截图为空/);
});

test('large Windows images are resized without upscaling and encoded as JPEG', async () => {
  const { api, options, calls } = captureModule({ width: 1920, height: 1080, scaleFactor: 2, pngLength: 1_500_000 });
  const result = await api.captureScreenshot(options);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.data.toString(), 'jpeg');
  assert.deepEqual(plain(calls.find(call => call.resize).resize), { width: 1920, height: 1080, quality: 'good' });
  assert.equal(calls.find(call => call.quality).quality, 72);
  const small = captureModule({ width: 800, height: 600, scaleFactor: 1, pngLength: 1_500_000 });
  await small.api.captureScreenshot(small.options);
  assert.equal(small.calls.some(call => call.resize), false);
});

test('JPEG conversion failure preserves the PNG and its matching MIME type', async () => {
  const { api, options, image } = captureModule({ scaleFactor: 1, width: 800, height: 600, pngLength: 1_500_000 });
  image.toJPEG = () => { throw new Error('encoder unavailable'); };
  const result = await api.captureScreenshot(options);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.data.length, 1_500_000);
});

test('interactive Windows requests require a committed region instead of silently taking the full screen', async () => {
  const { api, options, calls } = captureModule();
  await assert.rejects(api.captureScreenshot({ ...options, interactive: true }), /选择截图区域/);
  assert.equal(calls.length, 0);
});
