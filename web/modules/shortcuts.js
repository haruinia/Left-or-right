export const DEFAULT_HOTKEYS = {
  captureRegion: "CommandOrControl+Shift+U",
  sendChat: "CommandOrControl+Shift+Enter",
  toggleWindow: "CommandOrControl+Shift+H",
  quitApp: "CommandOrControl+Shift+Q",
  newQuestion: "CommandOrControl+Shift+N",
  clearShots: "CommandOrControl+Shift+Backspace",

  toggleVisible: "CommandOrControl+Shift+Space",
  captureScreen: "CommandOrControl+Shift+Y",
  toggleCompact: "CommandOrControl+Shift+J",
  moveUp: "CommandOrControl+Shift+Up",
  moveDown: "CommandOrControl+Shift+Down",
  moveLeft: "CommandOrControl+Shift+Left",
  moveRight: "CommandOrControl+Shift+Right",
};

export function formatAccelerator(accelerator, mac = true) {
  const names = {
    CommandOrControl: mac ? "⌘" : "Ctrl", Command: "⌘", Control: mac ? "⌃" : "Ctrl",
    Ctrl: mac ? "⌃" : "Ctrl", Shift: mac ? "⇧" : "Shift", Alt: mac ? "⌥" : "Alt",
    Option: mac ? "⌥" : "Alt", Super: "⌘", Meta: "⌘", Space: "Space", Return: "Enter",
    Escape: "Esc", Backspace: "⌫", Delete: "⌦", Up: "↑", Down: "↓", Left: "←", Right: "→",
  };
  return String(accelerator).split("+").map((key) => names[key] || key).join(mac ? "" : "+");
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
