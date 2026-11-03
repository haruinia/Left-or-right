'use strict';

const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { desktopCapturer, session } = require('electron');

function audioCapabilities() {
  const [major, minor] = os.release().split('.').map(Number);
  const electron = Number(process.versions.electron?.split('.')[0] || 0);
  const supportedMac = process.platform === 'darwin' && electron >= 39 && (major > 23 || (major === 23 && minor >= 2));
  return { platform: process.platform, systemAudioSupported: process.platform === 'win32' || supportedMac };
}

function configureAudioCapture({ gatewayUrl, rendererIndex, getMainWindow, getSettingsWindow, getDisplay }) {
  const gateway = new URL(gatewayUrl);
  const origin = gateway.origin;
  const localGateway = ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname);
  const rendererUrl = pathToFileURL(rendererIndex).href;
  const live = window => window && !window.isDestroyed();
  function trustedUrl(url, settings) {
    try {
      const parsed = new URL(url);
      return settings ? localGateway && parsed.origin === origin && ['/settings', '/settings.html'].includes(parsed.pathname)
        : parsed.href.split(/[?#]/)[0] === rendererUrl;
    } catch { return false; }
  }
  function allowMedia(contents, permission, details = {}) {
    if (!['media', 'display-capture'].includes(permission) || !contents || details.isMainFrame === false) return false;
    if (permission === 'media' && (details.mediaType === 'video' || details.mediaTypes?.includes('video'))) return false;
    const settings = getSettingsWindow();
    const main = getMainWindow();
    const isSettings = live(settings) && settings.webContents === contents;
    if (permission === 'display-capture' && (!isSettings || !audioCapabilities().systemAudioSupported)) return false;
    if (!isSettings && !(live(main) && main.webContents === contents)) return false;
    return trustedUrl(contents.getURL(), isSettings) && (!details.requestingUrl || trustedUrl(details.requestingUrl, isSettings));
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowMedia(contents, permission, details)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (requestingOrigin && !['file://', 'null'].includes(requestingOrigin)) {
      try { if (new URL(requestingOrigin).origin !== origin) return false; }
      catch { return false; }
    }
    return allowMedia(contents, permission, details);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let responded = false;
    const respond = streams => { if (!responded) { responded = true; callback(streams); } };
    const trusted = () => {
      const window = getSettingsWindow();
      return live(window) && request.frame === window.webContents.mainFrame && trustedUrl(request.frame.url, true);
    };
    try {
      if (!audioCapabilities().systemAudioSupported || request.userGesture === false || !request.audioRequested || !trusted()) return respond(null);
      // getDisplayMedia requires video, but audio-only capture does not need a physical screen.
      if (process.platform === 'darwin') return respond({ video: request.frame, audio: 'loopback' });
      const displayId = String(getDisplay().id);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      const source = sources.find(item => String(item.display_id) === displayId);
      if (!source || !trusted()) return respond(null);
      respond({ video: source, audio: 'loopback' });
    } catch { respond(null); }
  }, { useSystemPicker: false });
}

module.exports = { audioCapabilities, configureAudioCapture };
