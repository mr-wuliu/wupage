import { t } from "../shared/i18n";
import { DEFAULT_LOCAL_SHORTCUTS, LOCAL_BINDINGS, canonicalLocalShortcut, formatLocalShortcut,
  localShortcutVariants, normalizeLocalShortcuts, type LocalBinding, type LocalShortcutSettings } from "../shared/local-shortcuts";
import { LOCAL_SHORTCUTS, TRANSLATION_SHORTCUTS, shortcutWarning, type LocalShortcut, type ShortcutSettings } from "../shared/shortcuts";
import { showActionStatus } from "./action-feedback";
import { SHORTCUT_MODIFIERS } from "../shared/shortcut-keys";
import { setupShortcutRecorder } from "./shortcut-recorder";

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
  const fields = new Map<LocalBinding, { input: HTMLInputElement | HTMLSelectElement; error: HTMLElement; reset: HTMLButtonElement; refreshRecorder?: (active: boolean) => void }>();
  function conflict(value: string, exclude?: LocalBinding): string | undefined {
    if (!value) return;
    const variants = exclude ? localShortcutVariants(value) : [value];
    return LOCAL_BINDINGS.find(item => item.name !== "paragraph-click" && item.name !== exclude
      && localShortcutVariants(values[item.name]).some(candidate => variants.includes(candidate)))?.label;
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
        field.input.placeholder = recording === name ? t("pressKeys") : t("unassigned");
        field.input.dataset.recording = String(recording === name);
        field.input.parentElement!.style.setProperty("--shortcut-width", `${Math.max(10, field.input.value.length + 1)}ch`);
      } else field.input.value = values[name];
      field.reset.disabled = !ready || values[name] === DEFAULT_LOCAL_SHORTCUTS[name];
      field.refreshRecorder?.(recording === name);
      if (!field.input.hasAttribute("aria-invalid")) field.error.textContent = shortcutWarning(values[name]) ?? "";
    }
  }
  function apply(name: LocalBinding, value: string): boolean {
    const field = fields.get(name)!;
    const global = callbacks.getGlobal();
    const duplicate = name === "paragraph-click" ? undefined : conflict(value, name)
      ?? TRANSLATION_SHORTCUTS.find(item => localShortcutVariants(value).includes(global[item.name]))?.label;
    if (duplicate) {
      field.error.textContent = t("alreadyUsedByChooseADifferentCombination", duplicate);
      field.input.setAttribute("aria-invalid", "true"); callbacks.status.textContent = field.error.textContent; return false;
    }
    const previous = values[name]; values[name] = value; recording = undefined;
    const toggle = LOCAL_BINDINGS.find(item => item.name === name)!.toggle;
    if (empty(toggle)) callbacks.setEnabled(toggle, false);
    else if (!previous && value) callbacks.setEnabled(toggle, true);
    field.input.removeAttribute("aria-invalid");
    refresh(ready); callbacks.changed(); callbacks.status.textContent = t("featureShortcutChangedSaveToApply");
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
        caption.textContent = binding.name === "floating-activate" ? t("translate") : t("openMenu"); field.append(caption);
      }
      const input = document.createElement(binding.name === "paragraph-click" ? "select" : "input");
      input.id = `shortcut-local-${binding.name}`; input.dataset.localCommand = binding.name;
      input.setAttribute("aria-label", t("shortcut", binding.label));
      input.setAttribute("aria-describedby", `shortcut-error-${binding.name} shortcutRecorderHelp`);
      if (input instanceof HTMLSelectElement) {
        const modifiers = SHORTCUT_MODIFIERS;
        const choices = ["", ...Array.from({ length: 15 }, (_, index) => modifiers.filter((_, bit) => (index + 1) & (1 << bit)).join("+"))];
        for (const value of choices) { const option = document.createElement("option"); option.value = value; option.textContent = value ? t("clickParagraph", formatLocalShortcut(value, mac)) : t("unassigned"); input.append(option); }
        input.addEventListener("change", () => { const value = canonicalLocalShortcut(input.value, true); if (value !== undefined) apply(binding.name, value); }, { signal: callbacks.signal });
      }
      const fieldError = document.createElement("span"); fieldError.id = `shortcut-error-${binding.name}`; fieldError.className = "shortcut-error"; fieldError.setAttribute("role", "status");
      field.append(input, fieldError); group.append(field);
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "shortcut-small-button"; reset.textContent = t("default");
      reset.dataset.settingsFeedback = "";
      reset.setAttribute("aria-label", t("restoreDefaultShortcutFor", binding.label)); group.append(reset); actions.append(group);
      let refreshRecorder: ((active: boolean) => void) | undefined;
      if (input instanceof HTMLInputElement) {
        input.type = "text"; input.readOnly = true; input.autocomplete = "off"; input.spellcheck = false;
        refreshRecorder = setupShortcutRecorder(input, {
          start() {
            recording = binding.name;
            callbacks.status.textContent = t("pressAShortcutEscCancelsAndDeleteClears");
            refresh(ready);
          },
          stop(canceled) {
            if (recording !== binding.name) return;
            recording = undefined;
            if (canceled) {
              input.removeAttribute("aria-invalid");
              callbacks.status.textContent = t("recordingCanceledPreviousShortcutKept");
            }
            refresh(ready);
          },
          apply: value => apply(binding.name, value),
          invalid() {
            fieldError.textContent = t("shortcutKeyUnavailable");
            input.setAttribute("aria-invalid", "true");
            callbacks.status.textContent = fieldError.textContent;
          },
          status: callbacks.status, signal: callbacks.signal
        });
      }
      reset.addEventListener("click", () => {
        if (apply(binding.name, DEFAULT_LOCAL_SHORTCUTS[binding.name])) showActionStatus(callbacks.status, callbacks.status.textContent ?? "");
      }, { signal: callbacks.signal });
      fields.set(binding.name, { input, error: fieldError, reset, refreshRecorder });
    }
    actions.append(callbacks.createSwitch(item.name, item.label, row)); row.append(title, actions); container.append(row);
  }
  return {
    render(value: unknown) { values = normalizeLocalShortcuts(value); recording = undefined; for (const field of fields.values()) field.input.removeAttribute("aria-invalid"); refresh(ready); },
    read: (): LocalShortcutSettings => ({ ...values }), refresh, isEmpty: empty, conflict,
    reset() { values = normalizeLocalShortcuts(undefined); recording = undefined; for (const field of fields.values()) field.input.removeAttribute("aria-invalid"); refresh(ready); }
  };
}
