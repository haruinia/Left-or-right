import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../desktop/main/command-key.js', import.meta.url), 'utf8');
function monitor(platform = 'win32', { packaged = true, binaryExists = false } = {}) {
  let now = 0;
  let timerId = 0;
  const intervals = new Map();
  const timeouts = new Map();
  const calls = [];
  const children = [];
  const events = [];
  const module = { exports: {} };
  const process = { platform, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: '/resources' };
  const spawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.writes = [];
    child.stdin.write = text => child.writes.push(text);
    child.killed = 0;
    child.kill = () => { child.killed += 1; };
    children.push(child);
    return child;
  };
  const sandbox = {
    module, process, __dirname: '/project/desktop/main',
    console: { error() {}, warn() {} },
    setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = ++timerId; timeouts.set(id, fn); return id; },
    clearTimeout: id => timeouts.delete(id),
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:perf_hooks') return { performance: { now: () => now } };
      if (name === 'node:fs') return { existsSync: name => binaryExists && name.endsWith('windows-interaction.exe'), mkdirSync() {} };
      if (name === 'electron') return { app: { isPackaged: packaged, getPath: () => '/user' } };
      if (name === 'node:child_process') return { spawn, execFile: (_cmd, _args, _options, done) => done?.(new Error('unavailable'), '') };
      throw Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  const stop = module.exports.startCommandKeyMonitor(held => events.push(held));
  return {
    api: module.exports, calls, children, events, intervals, timeouts, stop,
    heartbeat(held, foreground = '456', child = children.at(-1)) { child.stdout.emit('data', JSON.stringify({ held, foreground }) + '\n'); },
    advance(ms) { now += ms; for (const fn of [...intervals.values()]) fn(); },
    restart() { const [id, fn] = timeouts.entries().next().value || []; if (fn) { timeouts.delete(id); fn(); } },
  };
}

test('Windows packages launch the hidden native helper without using PowerShell', () => {
  const m = monitor();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0][0], '/resources/native/windows-interaction.exe');
  assert.deepEqual([...m.calls[0][1]], []);
  assert.equal(m.calls[0][2].windowsHide, true);
  assert.equal(m.calls[0][2].shell, undefined);
  assert.deepEqual(m.events, [false]);
  m.stop();
});

test('development prefers a compiled helper and only falls back to permitted scripts when absent', () => {
  const native = monitor('win32', { packaged: false, binaryExists: true });
  assert.equal(native.calls[0][0], '/project/desktop/native/windows-interaction.exe');
  assert.deepEqual([...native.calls[0][1]], []);
  native.stop();

  const fallback = monitor('win32', { packaged: false });
  assert.equal(fallback.calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual([...fallback.calls[0][1]], ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', '/project/desktop/native/windows-interaction.ps1']);
  assert.ok(!fallback.calls[0][1].some(value => /executionpolicy|bypass/i.test(value)));
  fallback.stop();
});

test('a missing packaged helper fails closed and never falls back to a script', () => {
  const m = monitor();
  m.children[0].emit('error', new Error('ENOENT'));
  m.restart();
  assert.ok(m.calls.every(call => call[0] === '/resources/native/windows-interaction.exe'));
  assert.equal(m.events.at(-1), false);
  m.stop();
});

test('Ctrl down/up state is deduplicated while heartbeats update foreground state', () => {
  const m = monitor();
  m.heartbeat(true, '300');
  m.heartbeat(true, '400');
  assert.equal(m.api.getWindowsForegroundWindow(), '400');
  m.heartbeat(false, '500');
  assert.deepEqual(m.events, [false, true, false]);
  m.stop();
});

test('foreground restoration only sends validated target and expected overlay handles', () => {
  const m = monitor();
  m.api.restoreWindowsForegroundWindow('123', '456');
  assert.deepEqual(JSON.parse(m.children[0].writes[0]), { restore: '123', expected: '456' });
  m.api.restoreWindowsForegroundWindow('123; injected', '456');
  m.api.restoreWindowsForegroundWindow('123', '');
  assert.equal(m.children[0].writes.length, 1);
  m.stop();
});

test('malformed output cannot arm the overlay or reset its watchdog', () => {
  const m = monitor();
  const child = m.children[0];
  child.stdout.emit('data', '{bad json}\nnull\n{"held":"yes","foreground":"1"}\n{"held":true,"foreground":"not-a-handle"}\n');
  assert.deepEqual(m.events, [false]);
  m.advance(10001);
  assert.equal(child.killed > 0, true);
  assert.equal(m.events.at(-1), false);
  m.stop();
});

test('a stale heartbeat immediately releases Ctrl interaction and kills the hung helper', () => {
  const m = monitor();
  m.heartbeat(true);
  m.advance(1501);
  assert.equal(m.events.at(-1), false);
  assert.equal(m.children[0].killed > 0, true);
  assert.equal(m.api.getWindowsForegroundWindow(), '');
  assert.equal(m.timeouts.size, 1);
  m.stop();
});

test('helper failure releases the overlay and restarts at most three times', () => {
  const m = monitor();
  m.heartbeat(true);
  m.children[0].emit('error', new Error('blocked'));
  assert.equal(m.events.at(-1), false);
  m.restart();
  m.children[1].emit('exit', 1);
  m.restart();
  m.children[2].emit('exit', 1);
  assert.equal(m.calls.length, 3);
  assert.equal(m.timeouts.size, 0);
  m.stop();
});

test('an unusable helper input pipe releases interaction without waiting for the watchdog', () => {
  const m = monitor();
  m.heartbeat(true);
  m.children[0].stdin.emit('error', new Error('closed'));
  assert.equal(m.events.at(-1), false);
  assert.equal(m.children[0].killed > 0, true);
  m.stop();
});

test('stopping releases the overlay, clears timers, and ignores late events', () => {
  const m = monitor();
  m.heartbeat(true);
  const child = m.children[0];
  m.stop();
  assert.equal(m.events.at(-1), false);
  assert.equal(m.intervals.size, 0);
  assert.equal(m.timeouts.size, 0);
  const count = m.events.length;
  m.heartbeat(true, '456', child);
  child.emit('exit', 0);
  assert.equal(m.events.length, count);
  assert.equal(m.api.getWindowsForegroundWindow(), '');
});

test('macOS keeps its AppleScript/Swift path and does not start Windows PowerShell', async () => {
  const m = monitor('darwin');
  await Promise.resolve();
  assert.equal(m.calls.length, 0);
  assert.equal(m.api.sourcePath(), '/resources/native/command-key-monitor.swift');
  m.stop();
  assert.equal(m.intervals.size, 0);
});

test('native Windows helper uses the same modifier/heartbeat protocol and conditional restoration', () => {
  const source = fs.readFileSync(new URL('../desktop/native/windows-interaction.cs', import.meta.url), 'utf8');
  assert.match(source, /GetAsyncKeyState\(0xA2\)/);
  assert.match(source, /GetAsyncKeyState\(0xA3\)/);
  assert.match(source, /GetForegroundWindow\(\)\.ToInt64\(\) != expected/);
  assert.match(source, /ConcurrentQueue<string>/);
  assert.match(source, /JavaScriptSerializer/);
  assert.match(source, /Stopwatch\.StartNew\(\)/);
  assert.match(source, /Thread\.Sleep\(20\)/);
  assert.match(source, /lastHeartbeat >= 250/);
  assert.match(source, /\{ "held", held \}/);
  assert.ok(!/SetWindowsHookEx|GetKeyboardState|SendKeys|ExecutionPolicy|Process\.Start/.test(source));
});

test('development Windows script polls modifiers only and validates foreground before restoring', () => {
  const script = fs.readFileSync(new URL('../desktop/native/windows-interaction.ps1', import.meta.url), 'utf8');
  assert.match(script, /GetAsyncKeyState\(0xA2\)/);
  assert.match(script, /GetAsyncKeyState\(0xA3\)/);
  assert.match(script, /GetForegroundWindow\(\)\.ToInt64\(\) -eq \$expected/);
  assert.match(script, /Stopwatch/);
  assert.ok(!/SetWindowsHookEx|GetKeyboardState|SendKeys|ExecutionPolicy/.test(script));
});
