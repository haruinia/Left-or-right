// 键位对齐 Gank Interview 的实际默认值：全套 ⌘ + 单键，没有 ⌘⇧ 组合。
// 与 desktop/main/hotkeys.js、libs/schemas/models.py 的 UiHotkeys 保持一致。
export const DEFAULT_HOTKEYS = {
  captureRegion: "CommandOrControl+H",
  sendChat: "CommandOrControl+Enter",
  toggleWindow: "CommandOrControl+B",
  quitApp: "CommandOrControl+Q",
  newQuestion: "CommandOrControl+N",
  resetView: "CommandOrControl+R",
  deleteLastShot: "CommandOrControl+L",
  clearShots: "CommandOrControl+Shift+Backspace",

  toggleVisible: "CommandOrControl+Shift+Space",
  captureScreen: "CommandOrControl+Shift+Y",
  toggleCompact: "CommandOrControl+Shift+J",

  readPrev: "CommandOrControl+,",
  readNext: "CommandOrControl+.",
  scrollUp: "CommandOrControl+;",
  scrollDown: "CommandOrControl+'",

  moveUp: "CommandOrControl+Up",
  moveDown: "CommandOrControl+Down",
  moveLeft: "CommandOrControl+Left",
  moveRight: "CommandOrControl+Right",

  opacityDown: "CommandOrControl+[",
  opacityUp: "CommandOrControl+]",
  zoomOut: "CommandOrControl+-",
  zoomReset: "CommandOrControl+0",
  zoomIn: "CommandOrControl+=",
};

export function formatAccelerator(accelerator, mac = true) {
  const names = {
    CommandOrControl: mac ? "⌘" : "Ctrl", Command: "⌘", Control: mac ? "⌃" : "Ctrl",
    Ctrl: mac ? "⌃" : "Ctrl", Shift: mac ? "⇧" : "Shift", Alt: mac ? "⌥" : "Alt",
    Option: mac ? "⌥" : "Alt", Super: "⌘", Meta: "⌘", Space: "Space", Return: "Enter",
    Escape: "Esc", Backspace: "⌫", Delete: "⌦", Up: "↑", Down: "↓", Left: "←", Right: "→",
  };
  const parts = String(accelerator)
    .split("+")
    .map((token) => names[token] || token);
  return mac ? parts.join("") : parts.join("+");
}

export function acceleratorFromEvent(event, mac = true) {
  if (event.isComposing || event.repeat) return null;
  const modifiers = [];
  if (event.metaKey) modifiers.push(mac ? "CommandOrControl" : "Super");
  if (event.ctrlKey) modifiers.push(mac ? "Control" : "CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length) return null;
  const keys = {
    Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Tab: "Tab", Escape: "Escape",
    Backspace: "Backspace", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down",
    ArrowLeft: "Left", ArrowRight: "Right", Equal: "Plus",
  };
  let key = keys[event.code];
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
  return key ? [...modifiers, key].join("+") : null;
}

function acceleratorSignature(value, primary) {
  const aliases = {
    CommandOrControl: primary, Ctrl: "Control", Option: "Alt",
    Super: "Command", Meta: "Command", Return: "Enter", Esc: "Escape",
  };
  return String(value).split("+").map((part) => (aliases[part] || part).toUpperCase()).sort().join("|");
}

// Same rule as UiHotkeys.validate_unique: a chord must be unique on both macOS and Windows.
export function shortcutConflict(hotkeys) {
  for (const primary of ["Command", "Control"]) {
    const seen = new Map();
    for (const [action, value] of Object.entries(hotkeys)) {
      if (!value) continue;
      const signature = acceleratorSignature(value, primary);
      if (seen.has(signature)) return [seen.get(signature), action];
      seen.set(signature, action);
    }
  }
  return null;
}
