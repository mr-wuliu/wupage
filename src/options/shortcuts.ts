import { DEFAULT_SHORTCUTS, DEFAULT_SHORTCUT_ENABLED, formatShortcut, normalizeShortcutEnabled, normalizeShortcuts, shortcutFromEvent, shortcutWarning,
  TRANSLATION_SHORTCUTS, type ShortcutEnabledSettings, type ShortcutSettings, type TranslationShortcut } from "../shared/shortcuts";
import { setupLocalShortcutSettings } from "./local-shortcuts";
import type { LocalShortcutSettings } from "../shared/local-shortcuts";
import { showActionStatus } from "./action-feedback";

export function setupShortcutSettings(root: HTMLElement): {
  render: (value: unknown, enabled?: unknown, local?: unknown) => void;
  read: () => ShortcutSettings;
  readEnabled: () => ShortcutEnabledSettings;
  readLocal: () => LocalShortcutSettings;
} {
  const bindings = root.querySelector<HTMLElement>("#shortcutBindings")!;
  const status = root.querySelector<HTMLElement>("#shortcutStatus")!;
  const events = new AbortController();
  const mac = /Mac/.test(navigator.platform);
  let values = { ...DEFAULT_SHORTCUTS };
  let enabled = { ...DEFAULT_SHORTCUT_ENABLED };
  let ready = false;
  let recording: TranslationShortcut | undefined;
  let localControls: ReturnType<typeof setupLocalShortcutSettings> | undefined;
  const rows = new Map<TranslationShortcut, { input: HTMLInputElement; error: HTMLElement; reset: HTMLButtonElement }>();
  const switches = new Map<keyof ShortcutEnabledSettings, { button: HTMLButtonElement; row: HTMLElement }>();

  function createSwitch(name: keyof ShortcutEnabledSettings, label: string, row: HTMLElement): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button"; button.className = "shortcut-switch";
    button.dataset.shortcutToggle = name;
    button.setAttribute("role", "switch"); button.setAttribute("aria-label", `${label}快捷键`);
    switches.set(name, { button, row });
    button.addEventListener("click", () => {
      if (!ready || (name in values ? !values[name as TranslationShortcut] : localControls?.isEmpty(name as import("../shared/shortcuts").LocalShortcut))) return;
      enabled[name] = !enabled[name];
      recording = undefined;
      refresh();
      status.textContent = enabled[name] ? "快捷键已开启，点击「保存」后生效。" : "快捷键已关闭，保留原按键；点击「保存」后生效。";
    }, { signal: events.signal });
    return button;
  }

  function refresh(): void {
    localControls?.refresh(ready);
    for (const [name, row] of rows) {
      row.input.value = recording === name ? "" : formatShortcut(values[name], mac);
      row.input.placeholder = recording === name ? "请按下组合键…" : "未设置";
      const characters = Array.from(row.input.value || row.input.placeholder)
        .reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 2 : 1), 0);
      row.input.parentElement!.style.setProperty("--shortcut-width", `${Math.max(10, characters)}ch`);
      row.input.disabled = !ready;
      row.input.dataset.recording = String(recording === name);
      row.reset.disabled = !ready || values[name] === DEFAULT_SHORTCUTS[name];
      if (!row.input.hasAttribute("aria-invalid")) row.error.textContent = shortcutWarning(values[name]) ?? "";
    }
    for (const [name, { button, row }] of switches) {
      const empty = name in values ? !values[name as TranslationShortcut] : Boolean(localControls?.isEmpty(name as import("../shared/shortcuts").LocalShortcut));
      button.disabled = !ready || empty;
      button.setAttribute("aria-checked", String(enabled[name]));
      button.title = empty ? "请先设置快捷键，再启用" : enabled[name] ? "关闭快捷键，保留当前按键" : "开启快捷键";
      row.dataset.enabled = String(enabled[name]);
    }
  }

  function apply(name: TranslationShortcut, value: string): boolean {
    const row = rows.get(name)!;
    const duplicate = value ? TRANSLATION_SHORTCUTS.find(shortcut => shortcut.name !== name && values[shortcut.name] === value) : undefined;
    const duplicateLabel = duplicate?.label ?? localControls?.conflict(value);
    const error = duplicateLabel ? `已用于「${duplicateLabel}」，请换一个组合。` : "";
    row.error.textContent = error || "";
    if (error) { row.input.setAttribute("aria-invalid", "true"); status.textContent = error; return false; }
    row.input.removeAttribute("aria-invalid");
    if (!value) enabled[name] = false;
    else if (!values[name]) enabled[name] = true;
    values[name] = value;
    recording = undefined;
    status.textContent = "快捷键已修改，点击底部「保存」后生效。";
    refresh();
    return true;
  }

  for (const shortcut of TRANSLATION_SHORTCUTS) {
    const row = document.createElement("div"); row.className = "shortcut-row";
    const title = document.createElement("dt");
    const label = document.createElement("label"); label.htmlFor = `shortcut-${shortcut.name}`; label.textContent = shortcut.label;
    title.append(label);
    const actions = document.createElement("dd"); actions.className = "shortcut-editor";
    const field = document.createElement("div"); field.className = "shortcut-field";
    const input = document.createElement("input");
    input.id = label.htmlFor; input.type = "text"; input.readOnly = true; input.disabled = true;
    input.autocomplete = "off"; input.spellcheck = false; input.dataset.command = shortcut.name;
    input.setAttribute("aria-describedby", `shortcut-error-${shortcut.name} shortcutRecorderHelp`);
    input.title = "点击后按下组合键；Esc 取消，Backspace 或 Delete 清空";
    const error = document.createElement("span"); error.id = `shortcut-error-${shortcut.name}`;
    error.className = "shortcut-error"; error.setAttribute("role", "status");
    field.append(input, error);
    const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "默认"; reset.className = "shortcut-small-button";
    reset.dataset.settingsFeedback = "";
    reset.setAttribute("aria-label", `恢复${shortcut.label}默认快捷键`);
    actions.append(field, reset, createSwitch(shortcut.name, shortcut.label, row)); row.append(title, actions); bindings.append(row);
    rows.set(shortcut.name, { input, error, reset });

    input.addEventListener("focus", () => {
      recording = shortcut.name;
      status.textContent = "按下新的组合键，Esc 取消，Backspace 或 Delete 清空。";
      refresh();
    }, { signal: events.signal });
    input.addEventListener("blur", () => {
      if (recording !== shortcut.name) return;
      recording = undefined; refresh();
      status.textContent = "点击按键框录入，修改后点击底部「保存」。";
    }, { signal: events.signal });
    input.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      if (["Control", "Shift", "Alt", "Meta", "OS"].includes(event.key)) return;
      if (event.key === "Escape") {
        recording = undefined; error.textContent = ""; input.removeAttribute("aria-invalid");
        refresh(); input.blur(); status.textContent = "已取消录入，原绑定保持不变。"; return;
      }
      const clearing = ["Backspace", "Delete"].includes(event.key) && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      const value = clearing ? "" : shortcutFromEvent(event);
      if (value === undefined) {
        error.textContent = "请使用 Ctrl、Alt 或 Command 加字母、数字等按键的组合。";
        input.setAttribute("aria-invalid", "true"); status.textContent = error.textContent; return;
      }
      if (apply(shortcut.name, value)) input.blur();
    }, { signal: events.signal });
    reset.addEventListener("click", () => {
      if (apply(shortcut.name, DEFAULT_SHORTCUTS[shortcut.name])) showActionStatus(status, status.textContent ?? "");
    }, { signal: events.signal });
  }
  localControls = setupLocalShortcutSettings(root, {
    status, createSwitch, getGlobal: () => values, signal: events.signal,
    setEnabled: (name, value) => { enabled[name] = value; },
    changed: () => { recording = undefined; refresh(); }
  });
  root.querySelector<HTMLButtonElement>("#resetShortcuts")!.addEventListener("click", () => {
    values = { ...DEFAULT_SHORTCUTS }; recording = undefined;
    enabled = { ...DEFAULT_SHORTCUT_ENABLED };
    localControls.reset();
    for (const row of rows.values()) { row.error.textContent = ""; row.input.removeAttribute("aria-invalid"); }
    refresh(); showActionStatus(status, "已恢复默认快捷键，点击底部「保存」后生效。");
  }, { signal: events.signal });
  window.addEventListener("pagehide", event => { if (!event.persisted) events.abort(); }, { signal: events.signal });
  refresh();
  return {
    render(value, activation, local) {
      values = normalizeShortcuts(value); ready = true; recording = undefined;
      localControls!.render(local);
      enabled = normalizeShortcutEnabled(activation, values, localControls!.read());
      for (const row of rows.values()) { row.error.textContent = ""; row.input.removeAttribute("aria-invalid"); }
      refresh(); status.textContent = "";
    },
    read: () => ({ ...values }),
    readEnabled: () => ({ ...enabled }),
    readLocal: () => localControls!.read()
  };
}
