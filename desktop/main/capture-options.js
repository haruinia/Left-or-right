'use strict';

function startupDisplay(config, displays, primary) {
  const id = config.windowDisplayId || config.captureDisplayId || config.captureDisplayIds?.[0];
  return displays.find((display) => String(display.id) === String(id)) || primary;
}

function validateCaptureOptions(patch, displays) {
  if (patch.displayIds !== undefined) throw new Error('运行显示器只能选择一个');
  if (patch.displayId !== undefined && !displays.some((display) => String(display.id) === String(patch.displayId))) {
    throw new Error('显示器已断开，请重新选择');
  }
  if (patch.mode !== undefined && !['area', 'full'].includes(patch.mode)) throw new Error('无效的截图模式');
}

async function captureWindowDisplay({ displays, display, interactive, selectRegion, captureScreenshot }) {
  const rect = interactive ? await selectRegion(display) : null;
  if (interactive && !rect) return null;
  const displayIndex = displays.findIndex((item) => item.id === display.id) + 1;
  if (displayIndex < 1) throw new Error('运行显示器已断开，请重新截图');
  const shot = await captureScreenshot({
    interactive: false,
    rect,
    displayIndex,
    displayId: String(display.id),
    displayBounds: display.bounds ? { ...display.bounds } : undefined,
    scaleFactor: display.scaleFactor || 1,
  });
  return { mime: shot.mime, data: shot.data.toString('base64') };
}

module.exports = { startupDisplay, validateCaptureOptions, captureWindowDisplay };
