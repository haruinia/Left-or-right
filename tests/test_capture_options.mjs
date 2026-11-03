import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startupDisplay, validateCaptureOptions, captureWindowDisplay } = require('../desktop/main/capture-options.js');
const displays = [{ id: 1 }, { id: 2 }];

test('only one running display may be chosen, and multi-selection is rejected', () => {
  assert.doesNotThrow(() => validateCaptureOptions({ mode: 'full', displayId: '2' }, displays));
  assert.throws(() => validateCaptureOptions({ displayIds: ['1', '2'] }, displays), /只能选择一个/);
  assert.throws(() => validateCaptureOptions({ displayId: 'lost' }, displays), /断开/);
  assert.throws(() => validateCaptureOptions({ mode: 'invalid' }, displays), /模式/);
});

test('startup restores the running display and falls back if it disconnected', () => {
  assert.equal(startupDisplay({ windowDisplayId: '2' }, displays, displays[0]), displays[1]);
  assert.equal(startupDisplay({ windowDisplayId: 'lost' }, displays, displays[0]), displays[0]);
  assert.equal(startupDisplay({ captureDisplayId: '2' }, displays, displays[0]), displays[1]);
  assert.equal(startupDisplay({ captureDisplayIds: ['2', '1'] }, displays, displays[0]), displays[1]);
});

test('full-screen capture takes exactly one image from the app running display', async () => {
  const calls = [];
  const shot = await captureWindowDisplay({
    displays, display: displays[1], interactive: false,
    selectRegion: async () => { throw Error('should not select a region'); },
    captureScreenshot: async options => { calls.push(options); return { mime: 'image/png', data: Buffer.from(String(options.displayIndex)) }; },
  });
  assert.deepEqual(calls.map(c => c.displayIndex), [2]);
  assert.equal(calls[0].displayId, '2');
  assert.equal(calls[0].scaleFactor, 1);
  assert.equal(Buffer.from(shot.data, 'base64').toString(), '2');
});

test('capture forwards the Electron display identity and a separate geometry snapshot', async () => {
  const display = { id: 42, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 };
  let forwarded;
  await captureWindowDisplay({
    displays: [{ id: 7 }, display], display, interactive: false,
    selectRegion: async () => { throw Error('not used'); },
    captureScreenshot: async options => { forwarded = options; return { mime: 'image/png', data: Buffer.from('image') }; },
  });
  assert.equal(forwarded.displayId, '42');
  assert.equal(forwarded.displayIndex, 2);
  assert.equal(forwarded.scaleFactor, 1.5);
  assert.deepEqual(forwarded.displayBounds, display.bounds);
  assert.notEqual(forwarded.displayBounds, display.bounds);
});

test('a disappeared running display is not replaced by another display', async () => {
  await assert.rejects(captureWindowDisplay({
    displays: [displays[0]], display: displays[1], interactive: false,
    selectRegion: async () => null,
    captureScreenshot: async () => { throw Error('must not capture'); },
  }), /断开/);
});

test('region selection and capture use the same single display', async () => {
  const events = [];
  await captureWindowDisplay({
    displays, display: displays[1], interactive: true,
    selectRegion: async display => { events.push(`select-${display.id}`); return { width: 10, height: 10 }; },
    captureScreenshot: async options => { events.push(`capture-${options.displayIndex}`); return { mime: 'image/png', data: Buffer.from('image') }; },
  });
  assert.deepEqual(events, ['select-2', 'capture-2']);
});

test('cancelling a region does not capture or enqueue an image', async () => {
  const shot = await captureWindowDisplay({
    displays, display: displays[0], interactive: true,
    selectRegion: async () => null,
    captureScreenshot: async () => { throw Error('should not capture'); },
  });
  assert.equal(shot, null);
});
