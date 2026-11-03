export function installProtectedControls() {
  let active = null;
  let menuId = 0;
  const protectedWindow = () => Boolean(window.__APP_SETTINGS__ || document.documentElement.classList.contains("liuwa-host"));
  const canOpen = () => protectedWindow() && !document.body.inert && (!document.documentElement.classList.contains("liuwa-host") || document.body.classList.contains("liuwa-armed"));
  const dropdown = (target) => {
    const select = target instanceof Element ? target.closest("select") : null;
    return select && !select.multiple && select.size <= 1 ? select : null;
  };

  function close(restoreFocus = false) {
    if (!active) return;
    const { select, menu, observer, attributes } = active;
    active = null;
    observer.disconnect();
    menu.remove();
    for (const [name, value] of attributes) {
      if (value === null) select.removeAttribute(name);
      else select.setAttribute(name, value);
    }
    if (restoreFocus && select.isConnected && !select.disabled && !document.body.inert) select.focus({ preventScroll: true });
  }

  function focusOption(index) {
    if (!active) return;
    const buttons = active.buttons;
    if (!buttons.length) return;
    const next = ((index % buttons.length) + buttons.length) % buttons.length;
    active.index = next;
    buttons[next].focus({ preventScroll: true });
    buttons[next].scrollIntoView({ block: "nearest" });
  }

  function choose(option) {
    if (!active || option.disabled || option.parentElement?.disabled) return;
    const select = active.select;
    const changed = select.selectedIndex !== option.index;
    select.selectedIndex = option.index;
    close(true);
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function open(select) {
    if (select.disabled || !canOpen()) return;
    if (active?.select === select) { close(true); return; }
    close();
    const rect = select.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return;
    const menu = document.createElement("div");
    menu.className = "protected-select-menu";
    menu.id = `protected-select-${++menuId}`;
    menu.setAttribute("role", "listbox");
    const label = select.labels?.[0]?.cloneNode(true);
    label?.querySelectorAll("select, input, textarea, datalist").forEach((field) => field.remove());
    menu.setAttribute("aria-label", select.getAttribute("aria-label") || label?.textContent.trim() || "选项");
    const buttons = [];
    const attributes = ["aria-expanded", "aria-controls", "aria-haspopup"].map((name) => [name, select.getAttribute(name)]);
    for (const child of select.children) {
      if (child.hidden) continue;
      const grouped = child.tagName === "OPTGROUP";
      let parent = menu;
      if (grouped) {
        parent = document.createElement("div");
        parent.setAttribute("role", "group");
        parent.setAttribute("aria-label", child.label);
        const label = document.createElement("div");
        label.className = "protected-select-group";
        label.textContent = child.label;
        parent.append(label);
        menu.append(parent);
      }
      for (const option of grouped ? child.children : [child]) {
        if (option.tagName !== "OPTION" || option.hidden) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "protected-select-option";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(option.selected));
        button.tabIndex = -1;
        button.textContent = option.label;
        button.disabled = option.disabled || Boolean(grouped && child.disabled);
        button.addEventListener("click", () => choose(option));
        if (!button.disabled) buttons.push(button);
        parent.append(button);
      }
    }
    if (!buttons.length) return;
    const observer = new MutationObserver(() => close(true));
    observer.observe(select, { attributes: true, childList: true, subtree: true, attributeFilter: ["disabled", "hidden", "label", "selected", "value"] });
    active = { select, menu, buttons, observer, attributes, index: -1, search: "", searchedAt: 0 };
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", menu.id);
    select.setAttribute("aria-haspopup", "listbox");
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    menu.addEventListener("mousedown", (event) => event.stopPropagation());
    document.body.append(menu);
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 180), innerWidth - margin * 2);
    menu.style.width = `${width}px`;
    const height = Math.min(menu.scrollHeight, 360, innerHeight - margin * 2);
    const below = innerHeight - rect.bottom - margin - 4;
    const above = rect.top - margin - 4;
    const placeAbove = below < Math.min(height, 180) && above > below;
    const maxHeight = Math.max(1, Math.min(height, placeAbove ? above : below));
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, placeAbove ? rect.top - maxHeight - 4 : rect.bottom + 4)}px`;
    focusOption(Math.max(0, buttons.findIndex((button) => button.getAttribute("aria-selected") === "true")));
  }

  function pointerDown(event) {
    if (active?.menu.contains(event.target)) return;
    const select = dropdown(event.target);
    if (select && protectedWindow()) {
      event.preventDefault();
      if (event.button === 0) open(select);
      return;
    }
    close();
  }
  function suppressNative(event) {
    if (dropdown(event.target) && protectedWindow()) event.preventDefault();
  }
  function keyDown(event) {
    if (active) {
      const keys = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
      if (event.key === "Tab") { close(true); return; }
      if (event.key in keys) {
        event.preventDefault(); event.stopPropagation();
        focusOption(Math.max(0, Math.min(active.buttons.length - 1, active.index + keys[event.key])));
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); event.stopPropagation();
        focusOption(event.key === "Home" ? 0 : active.buttons.length - 1);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation();
        active.buttons[active.index]?.click();
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        const now = Date.now();
        active.search = now - active.searchedAt > 700 ? event.key : active.search + event.key;
        active.searchedAt = now;
        const text = active.search.toLocaleLowerCase();
        const index = active.buttons.findIndex((button) => button.textContent.trim().toLocaleLowerCase().startsWith(text));
        if (index >= 0) focusOption(index);
      }
      return;
    }
    const select = dropdown(event.target);
    if (select && protectedWindow() && ([" ", "Enter", "F4"].includes(event.key) || (event.altKey && ["ArrowDown", "ArrowUp"].includes(event.key)))) {
      event.preventDefault(); event.stopPropagation(); open(select);
    }
  }
  function scroll(event) { if (active && !active.menu.contains(event.target)) close(); }
  function dismiss() { close(); }
  function changed(event) { if (active?.select === event.target) close(); }
  function focusChanged(event) {
    // Datalist suggestions use a separate system popup rather than this window's DOM.
    if (protectedWindow() && event.target instanceof HTMLInputElement) event.target.removeAttribute("list");
    if (active && event.target !== active.select && !active.menu.contains(event.target)) close();
  }
  const release = new MutationObserver(() => { if (active && !canOpen()) close(); });
  release.observe(document.body, { attributes: true, attributeFilter: ["class", "inert"] });
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("mousedown", suppressNative, true);
  document.addEventListener("click", suppressNative, true);
  document.addEventListener("keydown", keyDown, true);
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("change", changed, true);
  document.addEventListener("focusin", focusChanged, true);
  document.addEventListener("visibilitychange", dismiss);
  for (const type of ["blur", "resize", "hashchange", "popstate", "app:privacy-hidden"]) window.addEventListener(type, dismiss);
  return () => {
    close(); release.disconnect();
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("mousedown", suppressNative, true);
    document.removeEventListener("click", suppressNative, true);
    document.removeEventListener("keydown", keyDown, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("change", changed, true);
    document.removeEventListener("focusin", focusChanged, true);
    document.removeEventListener("visibilitychange", dismiss);
    for (const type of ["blur", "resize", "hashchange", "popstate", "app:privacy-hidden"]) window.removeEventListener(type, dismiss);
  };
}

if (typeof document !== "undefined") installProtectedControls();
