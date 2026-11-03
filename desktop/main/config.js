'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:9958',
  gatewayApiKey: '',
  spawnBackend: true,
  screenshotMode: 'full',
  pythonPath: process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
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
  const preferences = readJson(path.join(app.getPath('userData'), 'config.json'));
  const merged = { ...DEFAULTS, ...fromFile, ...preferences };
  if (process.env.GATEWAY_URL) merged.gatewayUrl = process.env.GATEWAY_URL;
  if (process.env.GATEWAY_API_KEY) merged.gatewayApiKey = process.env.GATEWAY_API_KEY;
  if (process.env.SPAWN_BACKEND) merged.spawnBackend = process.env.SPAWN_BACKEND === 'true';
  merged.gatewayUrl = String(merged.gatewayUrl).replace(/\/+$/, '');
  merged.gatewayApiKey = String(merged.gatewayApiKey || '');
  return merged;
}

// 持久化运行时可改的配置（如低调模式开关）到 config.json。
function saveConfig(patch) {
  // 打包后的 __dirname 在只读 app.asar 中；偏好必须写到用户数据目录。
  const directory = app.getPath('userData');
  const file = path.join(directory, 'config.json');
  const current = readJson(file);
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadConfig, saveConfig, repoRoot, DEFAULTS };
