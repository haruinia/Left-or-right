'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { _electron } = require('../desktop/node_modules/playwright-core');

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const uiOnly = args.includes('--ui-only');
const binary = option('--binary');
if (!binary) throw Error('--binary must name the packaged application executable');
const executable = path.resolve(binary);
const webRoot = path.resolve(option('--web-root') || path.join(path.dirname(executable), process.platform === 'darwin' ? '../Resources/web' : 'resources/web'));
const reportDir = path.resolve(option('--report-dir') || 'output/native-privacy');
fs.mkdirSync(reportDir, { recursive: true });
const report = {
  result: 'running', platform: process.platform, checks: {}, observations: [],
  notVerified: ['all_meeting_software_and_capture_methods', 'taskbar_membership_and_transient_flash', 'physical_modifier_key_input', 'OS_file_chooser_capture_protection'],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw Error(`Timed out: ${description}`);
}
function nativeProbe(extra = []) {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const run = spawnSync(python, [path.join(__dirname, 'probe_windows_privacy.py'), ...extra], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (run.error) throw run.error;
  let value;
  try { value = JSON.parse(run.stdout); } catch { throw Error(`Native probe returned no valid JSON (exit ${run.status})`); }
  if (run.status !== 0 || value.status !== 'observed') {
    const error = new Error(`Native probe unavailable: ${(value.reasons || []).join('; ')}`);
    error.inconclusive = true;
    error.observation = value;
    throw error;
  }
  return value;
}

function fixtureServer() {
  const prefs = { study_specialty: '', study_language: '', answer_language: 'zh-CN', assistant_role: 'candidate', study_answer_style: 'solution', study_goal: '', study_instructions: '', jd_text: '', resume_text: '', long_term_memory_consent: false };
  return http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400).end(); return; }
    response.setHeader('Cache-Control', 'no-store');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (pathname === '/health') return json({ status: 'ok', service: 'shuihuo-killer-gateway' });
    if (pathname === '/api/ui/settings') return json(prefs);
    if (pathname === '/api/config/status') return json({ llm_provider: 'mock', llm_model: '', llm_api_key_configured: false });
    if (pathname === '/api/config/llm/profiles') return json({ profiles: [], presets: [], active_profile_id: '' });
    if (pathname.startsWith('/api/learning-assets/')) return json({ items: [] });
    const relative = pathname === '/' ? 'index.html' : pathname === '/settings' ? 'settings.html' : pathname.slice(1);
    const file = path.resolve(webRoot, relative);
    const inside = path.relative(webRoot, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, content) => {
      if (error) { response.writeHead(404).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      response.end(content);
    });
  });
}

async function verify() {
  if (!uiOnly) {
    if (process.platform !== 'win32') { const error = Error('Native Windows acceptance requires Windows; use --ui-only for shared UI checks'); error.inconclusive = true; throw error; }
    report.preflight = nativeProbe(['--preflight']);
    if (!report.preflight.environment.capture_exclusion_supported) {
      const error = Error('This Windows build cannot provide WDA_EXCLUDEFROMCAPTURE'); error.inconclusive = true; throw error;
    }
  } else report.notVerified.push('Windows_native_visibility_and_display_affinity');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zuoyou-privacy-'));
  const profile = path.join(temporary, 'profile');
  const server = fixtureServer();
  let application;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, GATEWAY_URL: origin, GATEWAY_API_KEY: '', SPAWN_BACKEND: 'false' };
    delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) if (/^(LLM_|ASR_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env, timeout: 60000 });
    const identity = await application.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid, electron: process.versions.electron, packaged: app.isPackaged }));
    assert.equal(fs.realpathSync(identity.profile), fs.realpathSync(profile), 'Test profile was not isolated');
    assert.equal(identity.packaged, true, 'Acceptance must use the packaged app');
    report.electron = identity.electron;
    report.checks.isolatedProfile = true;
    const overlay = await application.firstWindow();
    overlay.setDefaultTimeout(15000);
    await overlay.waitForFunction(() => window.cockpit && window.__liuwaState);
    const config = await overlay.evaluate(() => window.cockpit.getConfig());
    assert.equal(config.gatewayUrl, origin);
    await application.context().route('**/*', route => {
      const url = new URL(route.request().url());
      return ['file:', 'data:'].includes(url.protocol) || url.origin === origin ? route.continue() : route.abort();
    });
    const windows = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => {
      const handle = win.getNativeWindowHandle();
      return { id: win.id, hwnd: handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString(), visible: win.isVisible(), selector: win.webContents.getURL().includes('select.html'), menuVisible: process.platform === 'win32' ? win.isMenuBarVisible() : false };
    }));
    async function observe(label, { hidden = false } = {}) {
      const current = await windows();
      if (hidden) assert.ok(current.every(win => !win.visible), `${label}: Electron window remained visible`);
      if (!uiOnly) {
        const native = nativeProbe(['--pid', String(identity.pid), '--hwnds', JSON.stringify(current.map(win => win.hwnd))]);
        assert.equal(native.windows.length, current.length);
        for (const win of current) {
          const state = native.windows.find(item => item.hwnd === win.hwnd);
          assert.ok(state?.valid && state.owned && state.affinity_query_ok, `${label}: HWND ownership/query failed`);
          assert.equal(state.affinity, 0x11, `${label}: HWND does not have capture exclusion`);
          assert.equal(state.visible, win.visible, `${label}: native visibility differs from Electron`);
        }
        if (hidden) assert.ok(native.owned_windows.every(win => !win.visible), `${label}: an owned native window remained visible`);
        else assert.ok(native.owned_windows.filter(win => win.visible).every(win => current.some(item => item.hwnd === win.hwnd)), `${label}: unexpected native popup`);
        report.observations.push({ label, ...native });
      }
      return current;
    }
    await observe('startup');
    await application.evaluate(({ BrowserWindow, app }) => {
      global.__privacyFocusCalls = [];
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('file:'));
      const focusable = main.setFocusable.bind(main), skip = main.setSkipTaskbar.bind(main);
      main.setFocusable = value => { global.__privacyFocusCalls.push(['focusable', value]); return focusable(value); };
      main.setSkipTaskbar = value => { global.__privacyFocusCalls.push(['skipTaskbar', value]); return skip(value); };
      global.__privacyMain = main;
      global.__privacyWindowModule = process.mainModule.require(process.mainModule.require('node:path').join(app.getAppPath(), 'main/window.js'));
    });
    for (const held of [true, false, false, true, false]) {
      await application.evaluate((_electron, held) => global.__privacyWindowModule.setInteractive(global.__privacyMain, held, { restore: false }), held);
      await observe(`focusability-${held}`);
    }
    if (process.platform === 'win32') {
      const calls = await application.evaluate(() => global.__privacyFocusCalls);
      calls.forEach((call, index) => { if (call[0] === 'focusable') assert.deepEqual(calls[index + 1], ['skipTaskbar', true]); });
      assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
      report.checks.nativeFocusabilityCallsReassertTaskbarExclusion = true;
    }
    assert.equal(await overlay.evaluate(() => window.cockpit.openSettings('assets')), true);
    const settings = application.windows().find(page => page.url().includes('/settings'));
    assert.ok(settings);
    settings.setDefaultTimeout(15000);
    await settings.waitForFunction(() => window.__APP_SETTINGS__ === true);
    await settings.keyboard.press('Alt');
    await settings.keyboard.press('F10');
    assert.ok((await windows()).every(win => !win.menuVisible));
    report.checks.noMenuBar = true;
    await observe('settings-open');
    const scenario = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'browser/assets-navigation.js'), 'utf8'), { console, Buffer, setTimeout, URL });
    report.checks.records = await scenario(settings, { base: origin });
    await settings.setViewportSize({ width: 1000, height: 800 });
    await settings.locator('#assetRecords [data-preview-image]').click();
    await settings.locator('dialog[open]').waitFor();
    await settings.screenshot({ path: path.join(reportDir, 'synthetic-record-preview.png') });
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await observe('hide-all-with-preview', { hidden: true });
    await application.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    await observe('second-instance-stays-hidden', { hidden: true });
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await settings.waitForFunction(() => !document.querySelector('dialog'));
    await observe('explicit-restore');
    report.checks.settingsPreviewDismissedOnHide = true;
    await overlay.evaluate(async () => {
      const { openLightbox } = await import('./modules/lightbox.js');
      const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
      canvas.getContext('2d').fillRect(0, 0, 40, 40);
      openLightbox([canvas.toDataURL()]);
    });
    await overlay.locator('.liuwa-lightbox').waitFor();
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await observe('hide-main-lightbox', { hidden: true });
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await overlay.waitForFunction(() => !document.querySelector('.liuwa-lightbox'));
    report.checks.mainLightboxDismissedOnHide = true;
    await overlay.evaluate(() => { window.__pendingPrivacyCapture = window.cockpit.captureExam({ interactive: true }); window.cockpit.toggleVisible(); });
    await overlay.evaluate(() => window.__pendingPrivacyCapture);
    const delayed = await observe('capture-preparation-cancelled', { hidden: true });
    assert.ok(delayed.every(win => !win.selector));
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await overlay.evaluate(() => { window.__pendingPrivacyCapture = window.cockpit.captureExam({ interactive: true }); });
    await waitFor(async () => (await windows()).some(win => win.selector && win.visible), 'selector to become visible');
    await observe('selector-protected');
    await overlay.evaluate(() => window.cockpit.toggleVisible());
    await overlay.evaluate(() => window.__pendingPrivacyCapture);
    const cancelled = await observe('selector-cancelled', { hidden: true });
    assert.ok(cancelled.every(win => !win.selector));
    report.checks.captureCancellationAndNoReshow = true;
    report.result = uiOnly ? 'passed-ui-only' : 'passed';
  } finally {
    if (application) await application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

verify().catch(error => {
  report.result = error.inconclusive ? 'inconclusive' : 'failed';
  report.error = error.message;
  if (error.observation) report.observations.push(error.observation);
  process.exitCode = error.inconclusive ? 2 : 1;
}).finally(() => {
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
});
