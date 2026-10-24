'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { repoRoot } = require('./config');

let child = null;

async function waitForHealth(gatewayUrl, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gatewayUrl}/health`);
      if (response.ok) return true;
    } catch {
      // gateway not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function backendArgs(config) {
  const url = new URL(config.gatewayUrl);
  return ['scripts/run_gateway.py', '--host', url.hostname, '--port', url.port || '9958'];
}

function startBackend(config) {
  if (child) return child;
  const root = repoRoot();
  const python = path.isAbsolute(config.pythonPath)
    ? config.pythonPath
    : path.join(root, config.pythonPath);
  child = spawn(python, backendArgs(config), {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', () => {
    child = null;
  });
  return child;
}

function stopBackend() {
  if (!child) return;
  child.kill('SIGTERM');
  child = null;
}

module.exports = { backendArgs, startBackend, stopBackend, waitForHealth };
