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

// On macOS, `screencapture` rather than desktopCapturer gives the
// native crosshair, correct Retina scale, and never needs a renderer media stream.
//
// 矩形截图不用 `screencapture -R`：macOS 26 上它稳定报 could not create image
// from rect，而全屏截图正常。改成先整屏抓、再用 sips 裁，两段都稳定。
async function captureScreenshot({ interactive = true, rect = null, displayIndex = 1, displayId, displayBounds, scaleFactor } = {}) {
  if (process.platform === 'win32') {
    if (interactive && !rect) throw new Error('请先选择截图区域');
    return captureWindowsDisplay({ rect, displayId, displayBounds, scaleFactor });
  }
  if (process.platform !== 'darwin') throw new Error('截图目前支持 macOS 和 Windows');
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

function checkedDisplay(screen, displayId, bounds, scaleFactor) {
  const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
  if (displayId === undefined || displayId === null || !display) throw new Error('运行显示器已断开，请重新截图');
  if (!bounds || !Number.isFinite(scaleFactor) || scaleFactor <= 0
      || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
      || bounds.width <= 0 || bounds.height <= 0) throw new Error('显示器参数无效');
  if (display.scaleFactor !== scaleFactor
      || ['x', 'y', 'width', 'height'].some((key) => display.bounds[key] !== bounds[key])) {
    throw new Error('显示器配置已变化，请重新截图');
  }
  return display;
}

function thumbnailCrop(rect, expected, actual) {
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
      || rect.width <= 0 || rect.height <= 0) throw new Error('截图区域无效');
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(expected.width, rect.x + rect.width);
  const bottom = Math.min(expected.height, rect.y + rect.height);
  if (right <= left || bottom <= top) throw new Error('截图区域不在运行显示器内');
  // Native thumbnails can be smaller than the requested physical resolution.
  const x = Math.floor(left * actual.width / expected.width);
  const y = Math.floor(top * actual.height / expected.height);
  return {
    x,
    y,
    width: Math.min(actual.width, Math.ceil(right * actual.width / expected.width)) - x,
    height: Math.min(actual.height, Math.ceil(bottom * actual.height / expected.height)) - y,
  };
}

function encodeWindowsImage(image) {
  const png = image.toPNG();
  if (!png.length) throw new Error('截图为空，请检查屏幕捕获权限');
  if (png.length <= 1_400_000) return { mime: 'image/png', data: png };
  try {
    const size = image.getSize();
    const ratio = Math.min(1, 1920 / Math.max(size.width, size.height));
    const resized = ratio < 1 ? image.resize({
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)),
      quality: 'good',
    }) : image;
    const jpeg = resized.toJPEG(72);
    if (jpeg.length) return { mime: 'image/jpeg', data: jpeg };
  } catch {}
  return { mime: 'image/png', data: png };
}

async function captureWindowsDisplay({ rect, displayId, displayBounds, scaleFactor }) {
  const { desktopCapturer, screen } = require('electron');
  checkedDisplay(screen, displayId, displayBounds, scaleFactor);
  const expected = {
    width: Math.max(1, Math.round(displayBounds.width * scaleFactor)),
    height: Math.max(1, Math.round(displayBounds.height * scaleFactor)),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: expected, fetchWindowIcons: false });
  checkedDisplay(screen, displayId, displayBounds, scaleFactor);
  const source = sources.find((item) => String(item.display_id) === String(displayId));
  if (!source) throw new Error('无法获取运行显示器的截图，请检查屏幕捕获权限');
  let image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error('截图为空，请检查屏幕捕获权限');
  const actual = image.getSize();
  if (!Number.isFinite(actual.width) || !Number.isFinite(actual.height)
      || actual.width <= 0 || actual.height <= 0) throw new Error('截图尺寸无效');
  if (rect) image = image.crop(thumbnailCrop(rect, expected, actual));
  return encodeWindowsImage(image);
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
