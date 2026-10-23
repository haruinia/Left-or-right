'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // Include stderr: without screen-recording permission `screencapture` exits 0-less
    // with "could not create image from display" only on stderr, which is the signal
    // used upstream to explain the permission fix.
    execFile(cmd, args, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr || '').trim();
      error.message = detail ? `${error.message}: ${detail}` : error.message;
      reject(error);
    });
  });
}

function tempPngPath() {
  const name = `liuwa-shot-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  return path.join(os.tmpdir(), name);
}

// Uses the macOS `screencapture` binary rather than desktopCapturer: it gives the
// native crosshair, correct Retina scale, and never needs a renderer media stream.
//
// 矩形截图不用 `screencapture -R`：macOS 26 上它稳定报 could not create image
// from rect，而全屏截图正常。改成先整屏抓、再用 sips 裁，两段都稳定。
async function captureScreenshot({ interactive = true, rect = null, displayIndex = 1 } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('截图目前只支持 macOS');
  }
  const file = tempPngPath();
  // 传了 rect 就不要再走 -i：两点框选的坐标已经拿到了，交互模式反而会再弹一次十字。
  const args = interactive && !rect ? ['-x', '-i', '-t', 'png', file] : ['-x', '-t', 'png', file];
  if (!Number.isSafeInteger(displayIndex) || displayIndex < 1) throw new Error('显示器编号无效');
  args.splice(args.length - 1, 0, '-D', String(displayIndex));
  await run('/usr/sbin/screencapture', args);

  if (rect) {
    const cropped = file.replace(/\.png$/, '-crop.png');
    await run('/usr/bin/sips', [
      '--cropToHeightWidth',
      String(rect.height),
      String(rect.width),
      '--cropOffset',
      String(rect.y),
      String(rect.x),
      file,
      '--out',
      cropped,
    ]);
    fs.unlinkSync(file);
    fs.renameSync(cropped, file);
  }
  if (!fs.existsSync(file)) {
    throw new Error('截图已取消');
  }
  const data = fs.readFileSync(file);
  let mime = 'image/png';
  let bytes = data;
  if (data.length > 1_400_000) {
    const jpg = file.replace(/\.png$/, '.jpg');
    try {
      await run('/usr/bin/sips', [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '72',
        '-Z',
        '1920',
        file,
        '--out',
        jpg,
      ]);
      bytes = fs.readFileSync(jpg);
      mime = 'image/jpeg';
      fs.unlinkSync(jpg);
    } catch {
      bytes = data;
      mime = 'image/png';
    }
  }
  fs.unlinkSync(file);
  if (!bytes.length) {
    throw new Error('截图为空，可能缺少屏幕录制权限');
  }
  return { mime, data: bytes };
}

async function solveExamScreenshot(config, data, { questionHint = '' } = {}) {
  const params = new URLSearchParams({ filename: 'exam.png' });
  if (questionHint) params.set('question_hint', questionHint);
  const headers = { 'content-type': 'image/png' };
  // The gateway reads x-api-key / Authorization: Bearer / ?api_key — a plain
  // `api_key` header is not one of them and would 401.
  if (config.gatewayApiKey) headers['x-api-key'] = config.gatewayApiKey;
  const response = await fetch(`${config.gatewayUrl}/api/exam/solve?${params}`, {
    method: 'POST',
    headers,
    body: data,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`出题失败 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

module.exports = { captureScreenshot, solveExamScreenshot };
