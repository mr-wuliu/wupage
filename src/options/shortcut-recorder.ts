import { t } from "../shared/i18n";
import { ignoresShortcutEvent, shortcutFromEvent } from "../shared/shortcut-keys";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

export function setupShortcutRecorder(input: HTMLInputElement, callbacks: {
  start: () => void;
  stop: (canceled: boolean) => void;
  apply: (value: string) => boolean;
  invalid: () => void;
  status: HTMLElement;
  signal: AbortSignal;
}): (recording: boolean) => void {
  const specialKeys = document.createElement("button");
  specialKeys.type = "button";
  specialKeys.className = "shortcut-small-button shortcut-special-keys";
  specialKeys.textContent = t("shortcutSpecialKeys");
  input.after(specialKeys);
  input.title = t("pressAShortcutEscCancelsAndDeleteClears");
  let captureSpecialKey = false;
  const { signal } = callbacks;
  input.addEventListener("focus", callbacks.start, { signal });
  input.addEventListener("blur", event => {
    if (event.relatedTarget !== specialKeys) callbacks.stop(false);
  }, { signal });
  specialKeys.addEventListener("blur", event => {
    if (event.relatedTarget !== input) callbacks.stop(false);
  }, { signal });
  specialKeys.addEventListener("click", () => {
    input.focus();
    captureSpecialKey = true;
    callbacks.status.textContent = t("pressSpecialShortcutKey");
  }, { signal });
  input.addEventListener("keydown", event => {
    if (ignoresShortcutEvent(event)) return;
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (!captureSpecialKey && event.key === "Tab" && !modified) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || MODIFIER_KEYS.has(event.key)) return;
    const key = event.code && event.code !== "Unidentified" ? event.code : event.key;
    const plain = !captureSpecialKey && !modified && !event.shiftKey;
    captureSpecialKey = false;
    if (plain && key === "Escape") {
      callbacks.stop(true);
      input.blur();
      return;
    }
    const value = plain && (key === "Backspace" || key === "Delete") ? "" : shortcutFromEvent(event);
    if (value === undefined) callbacks.invalid();
    else if (callbacks.apply(value)) input.blur();
  }, { signal });
  return recording => {
    specialKeys.hidden = !recording;
    if (!recording) captureSpecialKey = false;
  };
}
