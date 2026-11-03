'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { repoRoot } = require('./config');

let child = null;

async function waitForHealth(gatewayUrl, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).service === 'shuihuo-killer-gateway') return true;
    } catch {}
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

function backendArgs(config, packaged = app.isPackaged) {
  const url = new URL(config.gatewayUrl);
  const args = ['--host', url.hostname, '--port', url.port || '9958'];
  return packaged ? args : ['scripts/run_gateway.py', '--no-reload', ...args];
}

function backendLaunch(config) {
  const root = repoRoot();
  const packaged = app.isPackaged;
  const dataDir = path.join(app.getPath('userData'), 'data');
  return {
    command: packaged
      ? path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'left-or-right-gateway.exe' : 'left-or-right-gateway')
      : path.isAbsolute(config.pythonPath) ? config.pythonPath : path.join(root, config.pythonPath),
    args: backendArgs(config, packaged),
    cwd: packaged ? dataDir : root,
    env: {
      ...process.env,
      ZUOYOU_WEB_ROOT: packaged ? path.join(process.resourcesPath, 'web') : path.join(root, 'web'),
      ...(packaged ? {
        DATABASE_URL: `sqlite:///${path.join(dataDir, 'shuihuo_killer.db').replace(/\\/g, '/')}`,
        REPORT_DIR: path.join(dataDir, 'reports'),
        LLM_PROFILES_PATH: path.join(dataDir, 'model_profiles.json'),
      } : {}),
    },
  };
}

function startBackend(config) {
  if (child) return child;
  const launch = backendLaunch(config);
  fs.mkdirSync(launch.cwd, { recursive: true });
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'gateway.log'), 'a');
  try {
    child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['ignore', log, log], windowsHide: true });
  } finally { fs.closeSync(log); }
  const current = child;
  const clear = () => { if (child === current) child = null; };
  current.on('error', (error) => { console.error('Local service failed to start:', error.code || 'unknown'); clear(); });
  current.on('exit', clear);
  return current;
}

async function ensureBackend(config) {
  if (await waitForHealth(config.gatewayUrl, { timeoutMs: 1200, intervalMs: 200 })) return true;
  const url = new URL(config.gatewayUrl);
  if (!config.spawnBackend || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return false;
  try { startBackend(config); }
  catch (error) { console.error('Local service launch error:', error.code || 'unknown'); return false; }
  return waitForHealth(config.gatewayUrl);
}

function stopBackend() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill('SIGTERM');
}

module.exports = { backendArgs, backendLaunch, ensureBackend, startBackend, stopBackend, waitForHealth };
