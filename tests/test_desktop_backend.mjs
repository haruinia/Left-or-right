import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../desktop/main/backend.js', import.meta.url), 'utf8');
function load(packaged, platform = 'darwin') {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resources = platform === 'win32' ? 'C:\\应用\\resources' : '/installed/resources';
  const project = platform === 'win32' ? 'C:\\project' : '/project';
  const calls = [];
  const child = new EventEmitter();
  child.kill = signal => calls.push({ kill: signal });
  const sandbox = {
    module: { exports: {} },
    process: { resourcesPath: resources, platform, env: {} },
    AbortSignal,
    URL,
    Date,
    console,
    setTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ service: 'shuihuo-killer-gateway' }) }),
    require(name) {
      if (name === 'node:path') return paths;
      if (name === 'node:fs') return { mkdirSync() {}, openSync() { return 3; }, closeSync() {} };
      if (name === 'node:child_process') return { spawn: (...args) => { calls.push({ spawn: args }); return child; } };
      if (name === 'electron') return { app: { isPackaged: packaged, getPath: key => platform === 'win32' ? `C:\\用户\\${key}` : `/user/${key}` } };
      if (name === './config') return { repoRoot: () => project };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.module.exports, sandbox, calls, child };
}
const config = { gatewayUrl: 'http://127.0.0.1:9958', pythonPath: '.venv/bin/python', spawnBackend: true };

test('installed apps launch a bundled executable using writable private data', () => {
  const { api } = load(true);
  const launch = api.backendLaunch(config);
  assert.equal(launch.command, '/installed/resources/backend/left-or-right-gateway');
  assert.equal(launch.cwd, '/user/userData/data');
  assert.equal(launch.env.ZUOYOU_WEB_ROOT, '/installed/resources/web');
  assert.equal(launch.env.LLM_PROFILES_PATH, '/user/userData/data/model_profiles.json');
  assert.deepEqual([...launch.args], ['--host', '127.0.0.1', '--port', '9958']);
  assert.ok(!JSON.stringify(launch).includes('/project'));
});

test('development launch keeps the source runtime but disables reloader children', () => {
  const { api } = load(false);
  const launch = api.backendLaunch(config);
  assert.equal(launch.command, '/project/.venv/bin/python');
  assert.equal(launch.cwd, '/project');
  assert.ok(launch.args.includes('--no-reload'));
});

test('Windows packages launch a hidden native exe with a normalized writable SQLite path', () => {
  const { api, calls } = load(true, 'win32');
  const launch = api.backendLaunch(config);
  assert.equal(launch.command, 'C:\\应用\\resources\\backend\\left-or-right-gateway.exe');
  assert.equal(launch.cwd, 'C:\\用户\\userData\\data');
  assert.equal(launch.env.DATABASE_URL, 'sqlite:///C:/用户/userData/data/shuihuo_killer.db');
  assert.equal(launch.env.LLM_PROFILES_PATH, 'C:\\用户\\userData\\data\\model_profiles.json');
  api.startBackend(config);
  const options = calls.find(call => call.spawn).spawn[2];
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio[0], 'ignore');
});

test('Windows development resolves the Scripts virtual-environment interpreter', () => {
  const { api } = load(false, 'win32');
  const launch = api.backendLaunch({ ...config, pythonPath: '.venv/Scripts/python.exe' });
  assert.equal(launch.command, 'C:\\project\\.venv\\Scripts\\python.exe');
  assert.ok(launch.args.includes('--no-reload'));
});

test('an already running service is reused instead of spawning another process', async () => {
  const { api, calls } = load(true);
  assert.equal(await api.ensureBackend(config), true);
  assert.equal(calls.length, 0);
});

test('health checks require our service identity, not just an HTTP 200', async () => {
  const { api, sandbox } = load(true);
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ service: 'another-app' }) });
  assert.equal(await api.waitForHealth(config.gatewayUrl, { timeoutMs: 0 }), false);
});

test('only the child owned by the desktop app is stopped', () => {
  const { api, calls } = load(true);
  api.stopBackend();
  assert.equal(calls.length, 0);
  api.startBackend(config);
  api.startBackend(config);
  assert.equal(calls.filter(c => c.spawn).length, 1);
  api.stopBackend();
  assert.equal(calls.at(-1).kill, 'SIGTERM');
});
