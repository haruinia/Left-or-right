import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../desktop/main/build-backend.js', import.meta.url), 'utf8');
function hook(platform = 'darwin', arch = 'arm64', options = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const calls = [];
  const runtimeChecks = [];
  let backendBuilt = Boolean(options.cachedBackend);
  const sandbox = {
    module: { exports: {} },
    __dirname: platform === 'win32' ? 'C:\\project\\desktop\\main' : '/project/desktop/main',
    process: { platform, arch, env: { ...(platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}), ...options.env } },
    require(name) {
      if (name === 'node:path') return paths;
      if (name === './taskbar-runtime') return {assertTaskbarDistribution: directory => {
        runtimeChecks.push(directory);
        if (options.invalidRuntime) throw Error('custom Electron runtime required');
      }};
      if (name === 'node:fs') return { existsSync: name => {
        if (options.missingCompiler && name.endsWith('csc.exe')) return false;
        if (options.framework32Only && name.includes('Framework64')) return false;
        if (options.missingHelperSource && name.endsWith('windows-interaction.cs')) return false;
        if (options.missingHelperBinary && name.endsWith('windows-interaction.exe')) return false;
        if (name.includes(`${paths.sep}backend${paths.sep}`)) return !options.missingBinary && backendBuilt;
        return options.noVenv ? !name.includes('.venv') : true;
      } };
      if (name === 'node:child_process') return { spawnSync: (...args) => {
        calls.push(args);
        if (!args[0].endsWith('csc.exe')) backendBuilt = true;
        return { status: args[0].endsWith('csc.exe') ? options.compilerStatus ?? 0 : options.status ?? 0 };
      } };
      throw Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return { run: sandbox.module.exports, calls, runtimeChecks };
}

test('build hooks select a native interpreter and explicitly forward the target platform and arch', async () => {
  const win = hook('win32', 'x64');
  await win.run({ electronPlatformName: 'win32', arch: 1 });
  assert.equal(win.calls[0][0], 'C:\\project\\.venv\\Scripts\\python.exe');
  assert.deepEqual([...win.calls[0][1]].slice(-4), ['--platform', 'win32', '--arch', 'x64']);
  assert.equal(win.calls[0][2].windowsHide, true);
  const mac = hook();
  await mac.run({ electronPlatformName: 'darwin', arch: 3 });
  assert.equal(mac.calls[0][0], '/project/.venv/bin/python');
});

test('cross-platform, cross-architecture, and unsupported host builds fail before spawning', async () => {
  const { run, calls } = hook();
  await assert.rejects(run({ electronPlatformName: 'win32', arch: 1 }), /cannot be cross-compiled/);
  await assert.rejects(run({ electronPlatformName: 'darwin', arch: 1 }), /cannot be cross-compiled/);
  await assert.rejects(hook('linux', 'x64').run(), /cannot be cross-compiled/);
  assert.equal(calls.length, 0);
});

test('Windows packaging checks the selected runtime before building and supports an existing backend', async () => {
  const rejected=hook('win32','x64',{invalidRuntime:true});
  await assert.rejects(rejected.run(),/custom Electron/);
  assert.equal(rejected.calls.length,0);
  const cached=hook('win32','x64',{cachedBackend:true});
  await cached.run({packager:{config:{electronDist:'C:\\runtime'}}});
  assert.deepEqual(cached.runtimeChecks,['C:\\runtime']);
  assert.equal(cached.calls.length,1);
  assert.ok(cached.calls[0][0].endsWith('csc.exe'));
});

test('explicit interpreters are used and missing native service output fails the build', async () => {
  const configured = hook('win32', 'x64', { env: { DESKTOP_PYTHON: 'D:\\Python\\python.exe' } });
  await configured.run();
  assert.equal(configured.calls[0][0], 'D:\\Python\\python.exe');
  await assert.rejects(hook('win32', 'x64', { missingBinary: true }).run(), /not generated/);
  await assert.rejects(hook('darwin', 'arm64', { status: 1 }).run(), /packaging failed/);
});

test('Windows build compiles a native interaction exe without invoking PowerShell or changing policy', async () => {
  const win = hook('win32', 'x64', { env: { SystemRoot: 'D:\\Windows' } });
  await win.run();
  const compile = win.calls.find(([command]) => command.endsWith('csc.exe'));
  assert.equal(compile[0], 'D:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  assert.deepEqual([...compile[1]], ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', '/out:C:\\project\\desktop\\native\\windows-interaction.exe', 'C:\\project\\desktop\\native\\windows-interaction.cs']);
  assert.equal(compile[2].windowsHide, true);
  assert.ok(win.calls.every(call => !JSON.stringify(call).toLowerCase().includes('powershell')));
  assert.ok(win.calls.every(call => !JSON.stringify(call).toLowerCase().includes('executionpolicy')));
  const mac = hook();
  await mac.run();
  assert.equal(mac.calls.length, 1);
});

test('Windows compilation falls back to the installed Framework compiler and fails closed on missing tools or output', async () => {
  const fallback = hook('win32', 'x64', { framework32Only: true, env: { SystemRoot: '', WINDIR: 'D:\\OS' } });
  await fallback.run();
  assert.match(fallback.calls.at(-1)[0], /D:\\OS\\Microsoft\.NET\\Framework\\v4\.0\.30319\\csc\.exe/);
  await assert.rejects(hook('win32', 'x64', { env: { SystemRoot: '' } }).run(), /SystemRoot is required/);
  await assert.rejects(hook('win32', 'x64', { missingCompiler: true }).run(), /compiler before packaging/);
  await assert.rejects(hook('win32', 'x64', { missingHelperSource: true }).run(), /source is missing/);
  await assert.rejects(hook('win32', 'x64', { missingHelperBinary: true }).run(), /compilation failed/);
  await assert.rejects(hook('win32', 'x64', { compilerStatus: 1 }).run(), /compilation failed/);
});

test('Windows installer is native x64, non-elevated and preserves user data on uninstall', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.dist, 'electron-builder');
  assert.equal(pkg.scripts['dist:win'], 'node main/windows-runtime.js');
  assert.equal(pkg.scripts['start:win'], 'node main/windows-runtime.js start');
  assert.equal(pkg.scripts['dist:mac'], 'electron-builder --mac');
  assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
});

test('native-build workflow runs only on manual dispatch and publishes only installer artifacts', () => {
  const yaml = fs.readFileSync(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /^\s+(push|pull_request|schedule):/m);
  assert.match(yaml, /contents: read/);
  assert.match(yaml, /windows-latest/);
  assert.match(yaml, /macos-latest/);
  assert.match(yaml, /smoke_desktop_bundle\.py/);
  assert.match(yaml, /smoke_windows_interaction\.py/);
  assert.match(yaml, /if: runner\.os == 'Windows'/);
  assert.doesNotMatch(yaml, /secrets\.|contents: write|desktop\/backend\/\*\*|data\/\*\*/);
});
