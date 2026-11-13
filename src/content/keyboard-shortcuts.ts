import { SETTINGS_KEY } from "../shared/defaults";
import { normalizeShortcutEnabled, normalizeShortcuts, TRANSLATION_SHORTCUTS, type ShortcutEnabledSettings, type ShortcutSettings, type TranslationShortcut } from "../shared/shortcuts";
import { shortcutFromEvent } from "../shared/shortcut-keys";
import type { ExtensionSettings } from "../shared/types";
import { sendRuntimeRequest } from "./runtime";

const EDITABLE = "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='combobox'],#wupage-selection-tools,#wupage-floating-hitbox,#wupage-floating-menu";

export class KeyboardShortcutController {
  private bindings?: ShortcutSettings;
  private enabled?: ShortcutEnabledSettings;
  constructor(private execute: (command: TranslationShortcut) => void | Promise<void>) {
    document.addEventListener("keydown", this.onKeyDown, true);
  }
  update(value: unknown, enabled?: unknown): void {
    this.bindings = normalizeShortcuts(value);
    this.enabled = normalizeShortcutEnabled(enabled, this.bindings);
  }
  dispose(): void { document.removeEventListener("keydown", this.onKeyDown, true); }
  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.bindings || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.composedPath().some(node => node instanceof Element && (node.matches(EDITABLE)
      || (node instanceof HTMLElement && node.isContentEditable)))) return;
    const shortcut = shortcutFromEvent(event);
    if (!shortcut) return;
    const command = TRANSLATION_SHORTCUTS.find(({ name }) => this.enabled?.[name] && this.bindings![name] === shortcut)?.name;
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void Promise.resolve(this.execute(command)).catch(error => console.warn("WuPage shortcut:", error));
  };
}

export function initKeyboardShortcuts(execute: (command: TranslationShortcut) => Promise<void>): void {
  if (typeof document === "undefined" || !chrome?.runtime?.id) return;
  const controller = new KeyboardShortcutController(execute);
  let revision = 0;
  let disposed = false;
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    revision++;
    const settings = changes[SETTINGS_KEY].newValue as ExtensionSettings | undefined;
    controller.update(settings?.shortcuts, settings?.shortcutEnabled);
  };
  chrome.storage.onChanged.addListener(changed);
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => {
    if (!revision && !disposed) controller.update(settings.shortcuts, settings.shortcutEnabled);
  }).catch(() => undefined);
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    disposed = true; controller.dispose(); chrome.storage.onChanged.removeListener(changed);
  }, { once: true });
}
