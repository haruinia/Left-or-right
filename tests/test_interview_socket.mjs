import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const source = fs.readFileSync(new URL('../desktop/main/interview-socket.js', import.meta.url), 'utf8');

function fixture({ gatewayUrl = 'http://127.0.0.1:9958', constructorFails = false } = {}) {
  const handlers = new Map(), listeners = new Map(), sockets = [], timers = new Map(), events = [];
  let url = 'file:///app/web/index.html', destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, getURL: () => url, isDestroyed: () => destroyed,
    send: (channel, event) => events.push({ channel, ...JSON.parse(JSON.stringify(event)) }),
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed });
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor(target, options) {
      super();
      if (constructorFails) throw Error('private upstream credentials');
      Object.assign(this, { target, options, readyState: 0, bufferedAmount: 0, sent: [], closeCodes: [], terminated: false });
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close(code) { this.closeCodes.push(code); }
    terminate() { this.terminated = true; }
  }
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) };
  const sandbox = {
    module: { exports: {} }, URL, Buffer,
    require: name => name === 'ws' ? Socket : { pathToFileURL },
    setTimeout(fn, delay) { const handle = { unref() {} }; timers.set(handle, { fn, delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
  };
  vm.runInNewContext(source, sandbox);
  sandbox.module.exports.registerInterviewSocket({ ipcMain, getMainWindow: () => window, gatewayUrl, rendererIndex: '/app/web/index.html' });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return {
    window, contents, event, sockets, timers, events,
    open: (id = 'run-1', who = event) => handlers.get('interview:socket-open')(who, id),
    send: (id, data, who = event) => listeners.get('interview:socket-send')(who, id, data),
    close: (id = 'run-1', who = event) => listeners.get('interview:socket-close')(who, id),
    navigate(value) { url = value; contents.emit('did-navigate'); },
    destroy() { destroyed = true; window.emit('closed'); },
    crash() { contents.emit('render-process-gone'); },
  };
}

function openSocket(f, id = 'run-1') {
  assert.equal(f.open(id), true);
  const socket = f.sockets.at(-1);
  socket.readyState = 1; socket.emit('open');
  return socket;
}

test('native interview transport connects only to the configured loopback endpoint with same origin and ASCII headers', () => {
  for (const [gatewayUrl, target, origin] of [
    ['http://127.0.0.1:9958/path?not=forwarded', 'ws://127.0.0.1:9958/ws/transcription', 'http://127.0.0.1:9958'],
    ['https://localhost:8443/', 'wss://localhost:8443/ws/transcription', 'https://localhost:8443'],
    ['http://[::1]:9958/', 'ws://[::1]:9958/ws/transcription', 'http://[::1]:9958'],
  ]) {
    const f = fixture({ gatewayUrl });
    const socket = openSocket(f);
    assert.equal(socket.target, target);
    assert.equal(socket.options.origin, origin);
    assert.equal(socket.options.headers['User-Agent'], 'LeftOrRight');
    assert.equal(socket.options.maxPayload, 128 * 1024);
    assert.deepEqual(f.events, [{ channel: 'interview:socket-event', id: 'run-1', type: 'open' }]);
  }
});

test('remote gateways, non-HTTP protocols and credentials in gateway URLs cannot create sockets', () => {
  for (const gatewayUrl of ['https://external.test', 'ws://127.0.0.1:9958', 'file:///app/web/index.html', 'http://user:secret@localhost:9958', 'invalid']) {
    const f = fixture({ gatewayUrl });
    assert.equal(f.open(), false);
    assert.equal(f.sockets.length, 0);
  }
});

test('only the exact owned main renderer may open, send or close a socket', () => {
  const f = fixture();
  const wrongEvents = [{ sender: f.contents, senderFrame: {} }, { sender: {}, senderFrame: f.contents.mainFrame }, { sender: {}, senderFrame: {} }];
  for (const event of wrongEvents) assert.equal(f.open('bad', event), false);
  const socket = openSocket(f);
  for (const event of wrongEvents) { f.send('run-1', 'private data', event); f.close('run-1', event); }
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closeCodes.length, 0);
  for (const url of ['http://127.0.0.1:9958/settings', 'https://external.test', 'file:///app/web/index.html-evil', 'file:///app/web/other.html']) {
    const other = fixture(); other.navigate(url);
    assert.equal(other.open(), false);
    assert.equal(other.sockets.length, 0);
  }
});

test('query and hash do not change the owned renderer identity', () => {
  const f = fixture(); f.navigate('file:///app/web/index.html?test=1#interview');
  assert.equal(f.open('owned_1'), true);
});

test('socket ids are bounded and only one connection can exist at a time', () => {
  const f = fixture();
  for (const id of ['', 'x'.repeat(81), '../socket', 'run:1', {}, null]) assert.equal(f.open(id), false);
  const socket = openSocket(f);
  assert.equal(f.open('another'), false);
  assert.equal(f.open('run-1'), false);
  f.send('wrong-id', '{}'); f.close('wrong-id');
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closeCodes.length, 0);
  socket.emit('close', 1000);
  assert.equal(f.open('another'), true);
});

test('open, text messages, outbound frames and close events preserve the connection id', () => {
  const f = fixture(), socket = openSocket(f);
  f.send('run-1', '{"type":"start"}');
  socket.emit('message', Buffer.from('{"type":"ready"}'), false);
  socket.emit('message', '{"type":"stopped"}', false);
  assert.deepEqual(socket.sent, ['{"type":"start"}']);
  assert.deepEqual(f.events.slice(1).map(({ type, data, id }) => ({ type, data, id })), [
    { id: 'run-1', type: 'message', data: '{"type":"ready"}' },
    { id: 'run-1', type: 'message', data: '{"type":"stopped"}' },
  ]);
  f.close();
  assert.deepEqual(socket.closeCodes, [1000]);
  assert.equal([...f.timers.values()][0].delay, 5000);
  socket.emit('close', 1000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.events.at(-1).type, 'close');
  assert.equal(f.events.at(-1).code, 1000);
});

test('outbound byte limits and backpressure fail closed with a fixed error', () => {
  for (const prepare of [
    (f, socket) => f.send('run-1', '字'.repeat(45000)),
    (f, socket) => f.send('run-1', new Uint8Array(3)),
    (f, socket) => { socket.bufferedAmount = 512 * 1024 + 1; f.send('run-1', '{}'); },
    (f, socket) => { socket.readyState = 0; f.send('run-1', '{}'); },
  ]) {
    const f = fixture(), socket = openSocket(f);
    prepare(f, socket);
    assert.equal(socket.sent.length, 0);
    assert.deepEqual(socket.closeCodes, [1000]);
    assert.equal(f.events.at(-1).type, 'error');
    assert.equal(f.events.at(-1).data, '无法连接语音转写服务。');
  }
  const f = fixture(), socket = openSocket(f);
  f.send('run-1', 'x'.repeat(128 * 1024));
  socket.bufferedAmount = 512 * 1024;
  f.send('run-1', '{}');
  assert.equal(socket.sent.length, 2);
});

test('binary or oversized server messages are never delivered to the renderer', () => {
  for (const [data, binary] of [[Buffer.alloc(3), true], ['x'.repeat(128 * 1024 + 1), false]]) {
    const f = fixture(), socket = openSocket(f);
    socket.emit('message', data, binary);
    assert.ok(!f.events.some(event => event.type === 'message'));
    assert.equal(f.events.at(-1).type, 'error');
    assert.deepEqual(socket.closeCodes, [1000]);
  }
});

test('upstream failures never expose raw errors or connection details', () => {
  const f = fixture(), socket = openSocket(f);
  socket.emit('error', Error('ws://127.0.0.1:9958/?token=secret upstream failed'));
  socket.emit('error', Error('second secret'));
  assert.equal(f.events.filter(event => event.type === 'error').length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /token|secret|upstream|127\.0/);
  assert.deepEqual(socket.closeCodes, [1000]);
  const bad = fixture({ constructorFails: true });
  assert.equal(bad.open(), false);
  assert.equal(bad.sockets.length, 0);
});

test('close timeout terminates the owned socket and releases the connection slot', () => {
  const f = fixture(), socket = openSocket(f);
  f.close();
  [...f.timers.values()][0].fn();
  assert.equal(socket.terminated, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.events.at(-1).type, 'close');
  assert.equal(f.open('replacement'), true);
  socket.emit('close', 1000);
  assert.equal(f.open('third'), false);
});

test('navigation, crash and window destruction close only their owned socket and reject late traffic', () => {
  for (const stop of [f => f.navigate('https://external.test'), f => f.crash(), f => f.destroy()]) {
    const f = fixture(), socket = openSocket(f);
    stop(f);
    assert.deepEqual(socket.closeCodes, [1000]);
    const count = f.events.length;
    socket.emit('message', '{"private":"later"}', false);
    socket.emit('open');
    assert.equal(f.events.length, count);
    socket.emit('close', 1000);
    assert.equal(f.timers.size, 0);
  }
});
