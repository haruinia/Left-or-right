'use strict';

function createWindowVisibility({ getMainWindow, getWindows, setInteractive }) {
  let held = false;
  let capturing = false;
  let revision = 0;
  let privacyHidden = false;
  let hidden = [];
  let captureWindows = [];
  const alive = window => window && !window.isDestroyed();
  const owned = () => getWindows().filter(alive);
  const applyInteraction = () => {
    const main = getMainWindow();
    setInteractive(Boolean(held && !capturing && alive(main) && main.isVisible()));
  };
  const show = windows => windows.filter(alive).forEach(window => window.showInactive());
  const hide = window => { window.webContents?.send('app:privacy-hidden'); window.hide(); };
  function hideAll() {
    revision += 1;
    if (!privacyHidden) hidden = capturing ? captureWindows.filter(alive) : owned().filter(window => window.isVisible());
    privacyHidden = true;
    setInteractive(false);
    owned().forEach(hide);
  }
  return {
    version() { return revision; },
    canShow(version) { return !capturing && !privacyHidden && version === revision; },
    canCapture(snapshot) { return capturing && snapshot.revision === revision; },
    showMain() {
      if (capturing || privacyHidden) return;
      setInteractive(false);
      show([getMainWindow()]);
    },
    modifierChanged(value) { held = Boolean(value); applyInteraction(); },
    toggle() {
      if (capturing || !privacyHidden) hideAll();
      else {
        privacyHidden = false;
        show(hidden.length ? hidden : [getMainWindow()]);
        hidden = [];
        applyInteraction();
      }
    },
    hideAll,
    beginCapture() {
      capturing = true;
      captureWindows = owned().filter(window => window.isVisible());
      const snapshot = { windows: [...captureWindows], revision };
      setInteractive(false);
      captureWindows.forEach(hide);
      return snapshot;
    },
    endCapture(snapshot) {
      capturing = false;
      if (snapshot.revision === revision) show(snapshot.windows);
      captureWindows = [];
      applyInteraction();
    },
  };
}

module.exports = { createWindowVisibility };
