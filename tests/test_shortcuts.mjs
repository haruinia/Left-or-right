import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_HOTKEYS, acceleratorFromEvent, shortcutConflict } from '../web/modules/shortcuts.js';

test('records physical keys and rejects incomplete chords', () => {
  assert.equal(acceleratorFromEvent({ code: 'KeyK', metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+K');
  assert.equal(acceleratorFromEvent({ code: 'KeyK', ctrlKey: true }, false), 'CommandOrControl+K');
  assert.equal(acceleratorFromEvent({ code: 'KeyA' }), null);
  assert.equal(acceleratorFromEvent({ code: 'MetaLeft', metaKey: true }), null);
  assert.equal(acceleratorFromEvent({ code: 'KeyA', metaKey: true, isComposing: true }), null);
});

test('detects duplicate reordered or aliased shortcuts', () => {
  assert.equal(shortcutConflict(DEFAULT_HOTKEYS), null);
  assert.deepEqual(shortcutConflict({a:'CommandOrControl+Shift+A', b:'Shift+Command+A'}), ['a','b']);
  assert.deepEqual(shortcutConflict({a:'Control+A', b:'CommandOrControl+A'}), ['a','b']);
  assert.deepEqual(shortcutConflict({a:'Control+Shift+D', b:'CommandOrControl+Shift+D'}), ['a','b']);
  assert.deepEqual(shortcutConflict({a:'Alt+Shift+K', b:'Option+Shift+K'}), ['a','b']);
});

test('all desktop actions survive registration failures', () => {
  const callbacks = new Map();
  const failedActions = ['toggleWindow', 'quitApp'];
  const sandbox = { module: { exports: {} }, process, require: () => ({ globalShortcut: {
    unregisterAll() {},
    register(accelerator, handler) {
      if (accelerator === DEFAULT_HOTKEYS.toggleWindow) return false;
      if (accelerator === DEFAULT_HOTKEYS.quitApp) throw new Error('unavailable');
      callbacks.set(accelerator, handler);
      return true;
    },
  }}) };
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/hotkeys.js', import.meta.url), 'utf8'), sandbox);
  const { BINDINGS, registerHotkeys } = sandbox.module.exports;
  assert.deepEqual(Array.from(BINDINGS, b => b.action).sort(), Object.keys(DEFAULT_HOTKEYS).sort());
  const invoked = [];
  const handlers = Object.fromEntries(BINDINGS.map(b => [b.action, () => invoked.push(b.action)]));
  assert.deepEqual(Array.from(registerHotkeys(handlers), b => b.action), failedActions);
  for (const callback of callbacks.values()) callback();
  assert.equal(invoked.length, Object.keys(DEFAULT_HOTKEYS).length - 2);
  assert.ok(invoked.includes('captureRegion') && invoked.includes('sendChat'));
});

test('window movement steps in four directions and stays on screen', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let bounds = { x: 100, y: 100, width: 440, height: 720 };
  const sandbox = { module: { exports: {} }, __dirname: '/tmp/desktop/main', process,
    require: name => name === 'electron' ? { app: { isPackaged: false }, screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } }),
    }} : name === './capture-options' ? require('../desktop/main/capture-options.js') : require(name),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/window.js', import.meta.url), 'utf8'), sandbox);
  const { moveWindow } = sandbox.module.exports;
  const win = { isDestroyed: () => false, getBounds: () => bounds,
    setPosition: (x, y) => { bounds = {...bounds, x, y}; },
  };
  for (const [dx, dy] of [[0,-32],[0,32],[-32,0],[32,0]]) {
    bounds = { ...bounds, x: 100, y: 100 };
    moveWindow(win, dx, dy);
    assert.equal(bounds.x, 100 + dx);
    assert.equal(bounds.y, 100 + dy);
  }
  moveWindow(win, -10000, -10000);
  assert.deepEqual([bounds.x, bounds.y], [0,24]);
  moveWindow(win, 10000, 10000);
  assert.deepEqual([bounds.x, bounds.y], [1000,180]);
  moveWindow(null, 32, 0);
});
