'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { app } = require('electron');
const { performance } = require('node:perf_hooks');

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

let windowsChild = null;
let windowsForeground = '';

function windowsSourcePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'windows-interaction.ps1')
    : path.resolve(__dirname, '..', 'native', 'windows-interaction.ps1');
}

function windowsBinaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'windows-interaction.exe')
    : path.resolve(__dirname, '..', 'native', 'windows-interaction.exe');
}

function windowsLaunch() {
  const binary = windowsBinaryPath();
  if (app.isPackaged || fs.existsSync(binary)) return { executable: binary, args: [] };
  return {
    executable: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsSourcePath()],
  };
}

function getWindowsForegroundWindow() {
  return windowsForeground;
}

function restoreWindowsForegroundWindow(target, expected) {
  if (!windowsChild?.stdin?.writable || !/^\d{1,20}$/.test(target) || !/^\d{1,20}$/.test(expected)) return;
  try { windowsChild.stdin.write(`${JSON.stringify({ restore: target, expected })}\n`); } catch {}
}

function startWindowsMonitor(onChange) {
  let stopped = false;
  let child = null;
  let last = false;
  let heartbeat = 0;
  let attempts = 0;
  let restart = null;
  let watchdog = null;

  const release = () => {
    last = false;
    onChange(false);
  };
  const clearChild = (current) => {
    if (child !== current) return;
    if (!stopped) console.warn('Windows Ctrl interaction monitor unavailable; the overlay remains click-through.');
    child = null;
    if (windowsChild === current) windowsChild = null;
    windowsForeground = '';
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    release();
    current.kill();
    if (!stopped && attempts < 3) restart = setTimeout(launch, 1000);
  };
  const launch = () => {
    if (stopped) return;
    restart = null;
    attempts += 1;
    const launch = windowsLaunch();
    let current;
    try {
      current = spawn(launch.executable, launch.args, {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch {
      console.warn('Windows Ctrl interaction monitor could not start; the overlay remains click-through.');
      release();
      if (!stopped && attempts < 3) restart = setTimeout(launch, 1000);
      return;
    }
    child = current;
    windowsChild = current;
    heartbeat = performance.now();
    let buffered = '';
    let ready = false;
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', (chunk) => {
      if (stopped || child !== current) return;
      buffered += chunk;
      if (buffered.length > 8192) {
        clearChild(current);
        return;
      }
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        let state;
        try { state = JSON.parse(line); } catch { continue; }
        if (!state || typeof state.held !== 'boolean' || !/^\d{1,20}$/.test(state.foreground || '')) continue;
        heartbeat = performance.now();
        ready = true;
        windowsForeground = state.foreground;
        if (state.held !== last) {
          last = state.held;
          onChange(last);
        }
      }
    });
    current.stdin.on('error', () => clearChild(current));
    current.on('error', () => clearChild(current));
    current.on('exit', () => clearChild(current));
    watchdog = setInterval(() => {
      if (performance.now() - heartbeat <= (ready ? 1500 : 10000)) return;
      clearChild(current);
    }, 250);
  };

  release();
  launch();
  return () => {
    stopped = true;
    if (restart) clearTimeout(restart);
    if (watchdog) clearInterval(watchdog);
    const current = child;
    child = null;
    if (windowsChild === current) windowsChild = null;
    windowsForeground = '';
    release();
    current?.kill();
  };
}

function startCommandKeyMonitor(onChange) {
  if (typeof onChange !== 'function') return () => {};
  if (process.platform === 'win32') return startWindowsMonitor(onChange);
  if (process.platform !== 'darwin') return () => {};
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

module.exports = { startCommandKeyMonitor, sourcePath, binaryPath, windowsSourcePath, windowsBinaryPath, getWindowsForegroundWindow, restoreWindowsForegroundWindow };
