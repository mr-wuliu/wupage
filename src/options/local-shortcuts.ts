import { DEFAULT_LOCAL_SHORTCUTS, LOCAL_BINDINGS, canonicalLocalShortcut, formatLocalShortcut, localShortcutFromEvent,
  localShortcutVariants, normalizeLocalShortcuts, type LocalBinding, type LocalShortcutSettings } from "../shared/local-shortcuts";
import { LOCAL_SHORTCUTS, TRANSLATION_SHORTCUTS, shortcutWarning, type LocalShortcut, type ShortcutSettings } from "../shared/shortcuts";
import { showActionStatus } from "./action-feedback";

interface Callbacks {
  status: HTMLElement;
  createSwitch: (name: LocalShortcut, label: string, row: HTMLElement) => HTMLButtonElement;
  getGlobal: () => ShortcutSettings;
  setEnabled: (name: LocalShortcut, enabled: boolean) => void;
  changed: () => void;
  signal: AbortSignal;
}
export function setupLocalShortcutSettings(root: HTMLElement, callbacks: Callbacks) {
  const mac = /Mac/.test(navigator.platform), container = root.querySelector("#localShortcutBindings")!;
  let values = normalizeLocalShortcuts(undefined), ready = false, recording: LocalBinding | undefined;
  const fields = new Map<LocalBinding, { input: HTMLInputElement | HTMLSelectElement; error: HTMLElement; reset: HTMLButtonElement; escape?: HTMLButtonElement }>();
  const overlap = (a: string, b: string) => localShortcutVariants(a).some(value => localShortcutVariants(b).includes(value));
  function conflict(value: string, exclude?: LocalBinding): string | undefined {
    if (!value) return;
    return LOCAL_BINDINGS.find(item => item.name !== "paragraph-click" && item.name !== exclude && overlap(values[item.name], value))?.label;
  }
  function empty(name: LocalShortcut): boolean {
    return name === "floating-controls" ? !values["floating-activate"] && !values["floating-menu"] : !values[name];
  }
  function refresh(enabled: boolean): void {
    ready = enabled;
    for (const [name, field] of fields) {
      field.input.disabled = !ready;
      if (field.input instanceof HTMLInputElement) {
        field.input.value = recording === name ? "" : formatLocalShortcut(values[name], mac);
        field.input.placeholder = recording === name ? "请按下按键…" : "未设置";
        field.input.dataset.recording = String(recording === name);
        field.input.parentElement!.style.setProperty("--shortcut-width", `${Math.max(10, field.input.value.length + 1)}ch`);
      } else field.input.value = values[name];
      field.reset.disabled = !ready || values[name] === DEFAULT_LOCAL_SHORTCUTS[name];
      if (field.escape) field.escape.hidden = recording !== name;
      if (!field.input.hasAttribute("aria-invalid")) field.error.textContent = shortcutWarning(values[name]) ?? "";
    }
  }
  function apply(name: LocalBinding, value: string): boolean {
    const field = fields.get(name)!;
    const global = callbacks.getGlobal();
    const duplicate = name === "paragraph-click" ? undefined : conflict(value, name)
      ?? TRANSLATION_SHORTCUTS.find(item => overlap(global[item.name], value))?.label;
    if (duplicate) {
      field.error.textContent = `已用于「${duplicate}」，请换一个组合。`;
      field.input.setAttribute("aria-invalid", "true"); callbacks.status.textContent = field.error.textContent; return false;
    }
    const previous = values[name]; values[name] = value; recording = undefined;
    const toggle = LOCAL_BINDINGS.find(item => item.name === name)!.toggle;
    if (empty(toggle)) callbacks.setEnabled(toggle, false);
    else if (!previous && value) callbacks.setEnabled(toggle, true);
    field.input.removeAttribute("aria-invalid");
    refresh(ready); callbacks.changed(); callbacks.status.textContent = "局部快捷键已修改，点击「保存」后生效。";
    return true;
  }
  for (const item of LOCAL_SHORTCUTS) {
    const row = document.createElement("div"); row.className = "shortcut-row shortcut-local-row";
    const title = document.createElement("dt"); title.textContent = item.label;
    const actions = document.createElement("dd"); actions.className = "shortcut-editor shortcut-local-editor";
    for (const binding of LOCAL_BINDINGS.filter(binding => binding.toggle === item.name)) {
      const group = document.createElement("div"); group.className = "shortcut-local-binding";
      const field = document.createElement("div"); field.className = "shortcut-field";
      if (item.name === "floating-controls") {
        const caption = document.createElement("label"); caption.htmlFor = `shortcut-local-${binding.name}`;
        caption.textContent = binding.name === "floating-activate" ? "翻译" : "进入菜单"; field.append(caption);
      }
      const input = document.createElement(binding.name === "paragraph-click" ? "select" : "input");
      input.id = `shortcut-local-${binding.name}`; input.dataset.localCommand = binding.name;
      input.setAttribute("aria-label", `${binding.label}快捷键`);
      input.setAttribute("aria-describedby", `shortcut-error-${binding.name} shortcutRecorderHelp`);
      if (input instanceof HTMLInputElement) {
        input.type = "text"; input.readOnly = true; input.autocomplete = "off"; input.spellcheck = false;
        input.title = "点击后按下快捷键；Esc 取消，Delete 清空；也可点击「使用 Esc」绑定 Esc";
        input.addEventListener("focus", () => { recording = binding.name; refresh(ready); callbacks.status.textContent = "按下快捷键，Esc 取消，Delete 清空。绑定 Esc 可点击旁边的「使用 Esc」。"; }, { signal: callbacks.signal });
        input.addEventListener("blur", event => { if (event.relatedTarget === fields.get(binding.name)?.escape) return; if (recording === binding.name) { recording = undefined; refresh(ready); } }, { signal: callbacks.signal });
        input.addEventListener("keydown", event => {
          if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
          if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          event.preventDefault(); event.stopPropagation();
          if (event.repeat || ["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key)) return;
          const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
          if (plain && event.key === "Escape") {
            recording = undefined; input.removeAttribute("aria-invalid"); refresh(ready); input.blur(); callbacks.status.textContent = "已取消录入，原绑定保持不变。"; return;
          }
          const value = plain && ["Delete", "Backspace"].includes(event.key) ? "" : localShortcutFromEvent(event);
          if (value === undefined) {
            fieldError.textContent = "请使用功能键，或 Ctrl、Alt、Command 加字母等组合键。";
            input.setAttribute("aria-invalid", "true"); return;
          }
          if (apply(binding.name, value)) input.blur();
        }, { signal: callbacks.signal });
      } else {
        const modifiers = ["Ctrl", "Alt", "Shift", "Meta"];
        const choices = ["", ...Array.from({ length: 15 }, (_, index) => modifiers.filter((_, bit) => (index + 1) & (1 << bit)).join("+"))];
        for (const value of choices) { const option = document.createElement("option"); option.value = value; option.textContent = value ? `${formatLocalShortcut(value, mac)} + 点击段落` : "未设置"; input.append(option); }
        input.addEventListener("change", () => { const value = canonicalLocalShortcut(input.value, true); if (value !== undefined) apply(binding.name, value); }, { signal: callbacks.signal });
      }
      const fieldError = document.createElement("span"); fieldError.id = `shortcut-error-${binding.name}`; fieldError.className = "shortcut-error"; fieldError.setAttribute("role", "status");
      field.append(input, fieldError); group.append(field);
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "shortcut-small-button"; reset.textContent = "默认";
      reset.dataset.settingsFeedback = "";
      reset.setAttribute("aria-label", `恢复${binding.label}默认快捷键`); group.append(reset); actions.append(group);
      const entry: { input: typeof input; error: HTMLElement; reset: HTMLButtonElement; escape?: HTMLButtonElement } = { input, error: fieldError, reset };
      if (input instanceof HTMLInputElement) {
        const escape = document.createElement("button"); escape.type = "button"; escape.textContent = "使用 Esc"; escape.className = "shortcut-small-button"; escape.hidden = true;
        escape.dataset.localEscape = binding.name;
        // Keep the recorder active while clicking this explicit special-key binding.
        escape.addEventListener("pointerdown", event => event.preventDefault(), { signal: callbacks.signal });
        escape.addEventListener("click", () => apply(binding.name, "Escape"), { signal: callbacks.signal });
        field.append(escape); entry.escape = escape;
      }
      reset.addEventListener("click", () => {
        if (apply(binding.name, DEFAULT_LOCAL_SHORTCUTS[binding.name])) showActionStatus(callbacks.status, callbacks.status.textContent ?? "");
      }, { signal: callbacks.signal });
      fields.set(binding.name, entry);
    }
    actions.append(callbacks.createSwitch(item.name, item.label, row)); row.append(title, actions); container.append(row);
  }
  return {
    render(value: unknown) { values = normalizeLocalShortcuts(value); recording = undefined; for (const field of fields.values()) field.input.removeAttribute("aria-invalid"); refresh(ready); },
    read: (): LocalShortcutSettings => ({ ...values }), refresh, isEmpty: empty, conflict,
    reset() { values = normalizeLocalShortcuts(undefined); recording = undefined; for (const field of fields.values()) field.input.removeAttribute("aria-invalid"); refresh(ready); }
  };
}
