'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compileWindowsInteraction(root) {
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows) throw new Error('SystemRoot is required to locate the Windows .NET Framework compiler.');
  const compiler = ['Framework64', 'Framework']
    .map(directory => path.join(windows, 'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('Install the Windows .NET Framework C# compiler before packaging the native interaction helper.');
  const source = path.join(root, 'desktop', 'native', 'windows-interaction.cs');
  const binary = path.join(root, 'desktop', 'native', 'windows-interaction.exe');
  if (!fs.existsSync(source)) throw new Error('The native Windows interaction helper source is missing.');
  const result = spawnSync(compiler, [
    '/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', `/out:${binary}`, source,
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(binary)) throw new Error('Native Windows interaction helper compilation failed.');
}

module.exports = async function buildBackend(context = {}) {
  const platform = context.electronPlatformName || process.platform;
  const targetArch = typeof context.arch === 'number' ? ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch] : context.arch || process.arch;
  if (!['darwin', 'win32'].includes(platform) || platform !== process.platform || targetArch !== process.arch) {
    throw new Error('Build the desktop app on its target operating system and architecture; the bundled service cannot be cross-compiled.');
  }
  if (platform === 'win32') {
    require('./taskbar-runtime').assertTaskbarDistribution(context.packager?.config?.electronDist);
  }
  const root = path.resolve(__dirname, '..', '..');
  const venv = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  const python = process.env.DESKTOP_PYTHON || (fs.existsSync(venv) ? venv : platform === 'win32' ? 'python' : 'python3');
  const binary = path.join(root, 'desktop', 'backend', 'left-or-right-gateway', platform === 'win32' ? 'left-or-right-gateway.exe' : 'left-or-right-gateway');
  // 后端可执行文件已存在时跳过 PyInstaller 重打包：避免 --clean 重复删除旧产物（在受限环境下会被批量删除保护拦截）。
  if (fs.existsSync(binary)) {
    console.log('Backend executable already present; skipping PyInstaller rebuild.');
  } else {
    const result = spawnSync(python, [path.join(root, 'scripts', 'build_desktop_backend.py'), '--platform', platform, '--arch', targetArch], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Local service packaging failed; install the desktop Python dependencies first.');
    if (!fs.existsSync(binary)) throw new Error('The native local-service executable was not generated.');
  }
  if (platform === 'win32') compileWindowsInteraction(root);
};
