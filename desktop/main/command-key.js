'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { app } = require('electron');

const APPLE_SCRIPT = [
  'ObjC.import("CoreGraphics");',
  'const flags = $.CGEventSourceFlagsState($.kCGEventSourceStateCombinedSessionState);',
  'console.log((flags & $.kCGEventFlagMaskCommand) ? "1" : "0");',
].join(' ');

function sourcePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'command-key-monitor.swift')
    : path.resolve(__dirname, '..', 'native', 'command-key-monitor.swift');
}

function binaryPath() {
  return path.join(app.getPath('userData'), 'native', 'command-key-monitor');
}

function ensureBinary() {
  if (process.platform !== 'darwin') return Promise.resolve('');
  const source = sourcePath();
  const target = binaryPath();
  try {
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) {
      return Promise.resolve(target);
    }
    fs.mkdirSync(path.dirname(target), {recursive:true});
    return new Promise((resolve) => {
      execFile('swiftc', ['-O', '-o', target, source], {timeout:30000}, (error) => {
        resolve(error ? '' : target);
      });
    });
  } catch {
    return Promise.resolve('');
  }
}

function startCommandKeyMonitor(onChange) {
  if (process.platform !== 'darwin' || typeof onChange !== 'function') return () => {};
  let stopped = false;
  let child = null;
  let fallbackTimer = null;
  let polling = false;
  let last = false;

  const emit = (held) => {
    const next = Boolean(held);
    if (next === last) return;
    last = next;
    onChange(next);
  };

  const pollFallback = () => {
    if (stopped || polling) return;
    polling = true;
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', APPLE_SCRIPT],
      {encoding:'utf8', timeout:600},
      (error, stdout) => {
        polling = false;
        if (!error && !stopped) emit(String(stdout).trim() === '1');
      },
    );
  };

  // Compilation can take a moment on the first launch. The lighter AppleScript
  // poll keeps the interaction working during that window, then the native
  // helper takes over and removes the repeated subprocess cost.
  fallbackTimer = setInterval(pollFallback, 100);
  pollFallback();

  ensureBinary().then((binary) => {
    if (stopped || !binary) return;
    clearInterval(fallbackTimer);
    fallbackTimer = null;
    child = spawn(binary, [], {stdio:['ignore','pipe','ignore']});
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        if (line === '0' || line === '1') emit(line === '1');
      }
    });
    child.on('error', () => {
      child = null;
      if (!stopped && !fallbackTimer) {
        fallbackTimer = setInterval(pollFallback, 100);
        pollFallback();
      }
    });
    child.on('exit', () => {
      child = null;
      if (!stopped && !fallbackTimer) {
        fallbackTimer = setInterval(pollFallback, 100);
        pollFallback();
      }
    });
  });

  return () => {
    stopped = true;
    if (fallbackTimer) clearInterval(fallbackTimer);
    fallbackTimer = null;
    if (child) child.kill();
    child = null;
  };
}

module.exports = { startCommandKeyMonitor, sourcePath, binaryPath };
