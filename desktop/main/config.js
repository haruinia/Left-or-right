'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8001',
  gatewayApiKey: '',
  spawnBackend: true,
  pythonPath: '.venv/bin/python',
};

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig() {
  const fromFile = readJson(path.join(__dirname, '..', 'config.json'));
  const merged = { ...DEFAULTS, ...fromFile };
  if (process.env.GATEWAY_URL) merged.gatewayUrl = process.env.GATEWAY_URL;
  if (process.env.GATEWAY_API_KEY) merged.gatewayApiKey = process.env.GATEWAY_API_KEY;
  if (process.env.SPAWN_BACKEND) merged.spawnBackend = process.env.SPAWN_BACKEND === 'true';
  merged.gatewayUrl = String(merged.gatewayUrl).replace(/\/+$/, '');
  merged.gatewayApiKey = String(merged.gatewayApiKey || '');
  return merged;
}

// 持久化运行时可改的配置（如低调模式开关）到 config.json。
function saveConfig(patch) {
  const file = path.join(__dirname, '..', 'config.json');
  const current = readJson(file);
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadConfig, saveConfig, repoRoot, DEFAULTS };
