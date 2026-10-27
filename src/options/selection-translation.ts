import {
  DEFAULT_SELECTION_TRANSLATION,
  formatSelectionShortcut,
  normalizeSelectionTranslation,
  shortcutFromEvent
} from "../shared/selection-translation";
import type { SelectionTranslationSettings } from "../shared/types";

export function setupSelectionTranslationControls(container: HTMLElement): {
  render(value: unknown): void;
  read(): SelectionTranslationSettings;
} {
  const query = <T extends Element>(selector: string): T => {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  };
  const showIcon = query<HTMLInputElement>("#selectionTranslationShowIcon");
  const input = query<HTMLInputElement>("#selectionTranslationShortcut");
  const clear = query<HTMLButtonElement>("#clearSelectionTranslationShortcut");
  const reset = query<HTMLButtonElement>("#resetSelectionTranslationShortcut");
  const status = query<HTMLElement>("#selectionTranslationStatus");
  let shortcut = DEFAULT_SELECTION_TRANSLATION.shortcut;
  let loaded = false;

  input.readOnly = true;
  for (const control of [showIcon, input, clear, reset]) control.disabled = true;
  container.setAttribute("aria-busy", "true");
  container.setAttribute("data-loading", "");

  function updateShortcut(value: string, message = ""): void {
    shortcut = value;
    input.value = formatSelectionShortcut(value);
    input.removeAttribute("aria-invalid");
    status.textContent = message;
  }

  input.addEventListener("keydown", (event) => {
    if (!loaded || input.ownerDocument.activeElement !== input) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      input.blur();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      updateShortcut("", "已清除快捷键，点击页面底部“保存”生效。");
      return;
    }
    // A modifier is only the beginning of a chord, not an invalid shortcut.
    if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(event.key)) return;
    const next = shortcutFromEvent(event);
    if (next === null) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = "此快捷键不可用。请使用包含 Ctrl、Alt 或 Meta 的字母或数字组合键，并避开浏览器或系统保留的快捷键。";
      return;
    }
    updateShortcut(next, "已记录快捷键，点击页面底部“保存”生效。");
  });
  clear.addEventListener("click", () => {
    if (loaded) updateShortcut("", "已清除快捷键，点击页面底部“保存”生效。");
  });
  reset.addEventListener("click", () => {
    if (loaded) updateShortcut(DEFAULT_SELECTION_TRANSLATION.shortcut, "已恢复默认快捷键，点击页面底部“保存”生效。");
  });

  return {
    render(value): void {
      const settings = normalizeSelectionTranslation(value);
      showIcon.checked = settings.showIcon;
      updateShortcut(settings.shortcut);
      loaded = true;
      for (const control of [showIcon, input, clear, reset]) control.disabled = false;
      container.removeAttribute("data-loading");
      container.setAttribute("aria-busy", "false");
    },
    read(): SelectionTranslationSettings {
      return normalizeSelectionTranslation({
        showIcon: loaded ? showIcon.checked : DEFAULT_SELECTION_TRANSLATION.showIcon,
        shortcut
      });
    }
  };
}
