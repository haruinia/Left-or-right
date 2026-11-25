'use strict';

const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const validId = id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);

function registerInterviewSocket({ ipcMain, getMainWindow, gatewayUrl, rendererIndex }) {
  const renderer = pathToFileURL(rendererIndex).href;
  let gateway;
  try {
    const url = new URL(gatewayUrl);
    if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password) gateway = url;
  } catch {}
  const watched = new WeakSet();
  let current = null;

  function trusted(window) {
    if (!window || window.isDestroyed() || window !== getMainWindow()) return false;
    const contents = window.webContents;
    return !contents.isDestroyed() && contents.getURL().split(/[?#]/)[0] === renderer;
  }

  function owned(event) {
    const window = getMainWindow();
    return trusted(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  }

  function emit(record, event) {
    if (trusted(record.window)) record.window.webContents.send('interview:socket-event', { id: record.id, ...event });
  }

  function finish(record, code = 1006) {
    if (record.closed) return;
    record.closed = true;
    clearTimeout(record.timer);
    if (current === record) current = null;
    emit(record, { type: 'close', code });
  }

  function close(record) {
    if (record.closed || record.closing) return;
    record.closing = true;
    record.timer = setTimeout(() => {
      try { record.socket.terminate(); } catch {}
      finish(record);
    }, 5000);
    record.timer.unref?.();
    try { record.socket.close(1000); } catch {
      try { record.socket.terminate(); } catch {}
      finish(record);
    }
  }

  function fail(record) {
    if (record.closed || record.closing) return;
    emit(record, { type: 'error', data: '无法连接语音转写服务。' });
    close(record);
  }

  function watch(window) {
    if (watched.has(window)) return;
    watched.add(window);
    const stop = () => { if (current?.window === window) close(current); };
    window.once('closed', stop);
    window.webContents.on('did-navigate', stop);
    window.webContents.on('render-process-gone', stop);
  }

  ipcMain.handle('interview:socket-open', (event, id) => {
    if (!owned(event) || !gateway || !validId(id) || current) return false;
    const window = getMainWindow();
    const url = new URL('/ws/transcription', gateway);
    url.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(url.href, { origin: gateway.origin, headers: { 'User-Agent': 'LeftOrRight' }, maxPayload: MAX_MESSAGE_BYTES });
    } catch { return false; }
    const record = { id, window, socket, closing: false, closed: false, timer: null };
    current = record;
    watch(window);
    socket.on('open', () => { if (!record.closing && !record.closed) emit(record, { type: 'open' }); });
    socket.on('message', (data, binary) => {
      if (record.closing || record.closed) return;
      if (binary) return fail(record);
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) return fail(record);
      emit(record, { type: 'message', data: text });
    });
    socket.on('error', () => fail(record));
    socket.on('close', code => finish(record, code));
    return true;
  });

  ipcMain.on('interview:socket-send', (event, id, data) => {
    const record = current;
    if (!owned(event) || !record || record.id !== id || record.closing || record.closed) return;
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_MESSAGE_BYTES || record.socket.readyState !== WebSocket.OPEN || record.socket.bufferedAmount > MAX_BUFFERED_BYTES) return fail(record);
    try { record.socket.send(data); } catch { fail(record); }
  });

  ipcMain.on('interview:socket-close', (event, id) => {
    if (owned(event) && current?.id === id) close(current);
  });
}

module.exports = { registerInterviewSocket };
