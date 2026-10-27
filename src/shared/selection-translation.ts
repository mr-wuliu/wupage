import type { SelectionTranslationSettings } from "./types";

export const DEFAULT_SELECTION_TRANSLATION: SelectionTranslationSettings = {
  showIcon: true,
  shortcut: "Alt+Shift+T"
};
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** Avoid common browser/editing shortcuts; OS and website conflicts cannot all be detected. */
function reserved(shortcut: string): boolean {
  return /^(Ctrl|Meta)\+(?:[ACVXZTYWNRFLOPSDHJKB]|[0-9])$/.test(shortcut)
    || /^(Ctrl|Meta)\+Shift\+[NTW]$/.test(shortcut)
    || /^Alt\+[DF]$/.test(shortcut)
    || /^Ctrl\+Alt\+[0-9]$/.test(shortcut);
}

export function normalizeSelectionShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "") return "";
  const parts = value.split("+");
  const key = parts.pop()!;
  if (!/^[A-Z0-9]$/.test(key) || !parts.length || new Set(parts).size !== parts.length
    || parts.some(part => !MODIFIERS.includes(part as typeof MODIFIERS[number]))
    || !parts.some(part => part === "Ctrl" || part === "Alt" || part === "Meta")) return null;
  const canonical = [...MODIFIERS.filter(modifier => parts.includes(modifier)), key].join("+");
  return reserved(canonical) ? null : canonical;
}

export function normalizeSelectionTranslation(value: unknown): SelectionTranslationSettings {
  const input = value && typeof value === "object" ? value as Partial<SelectionTranslationSettings> : {};
  return {
    showIcon: typeof input.showIcon === "boolean" ? input.showIcon : true,
    shortcut: normalizeSelectionShortcut(input.shortcut) ?? DEFAULT_SELECTION_TRANSLATION.shortcut
  };
}

export function shortcutFromEvent(event: KeyboardEvent): string | null {
  if (event.isComposing || event.repeat || event.getModifierState("AltGraph")) return null;
  // Prefer physical letters for Alt/Option combinations, whose key can be a symbol.
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key.toUpperCase();
  return normalizeSelectionShortcut([
    ...(event.ctrlKey ? ["Ctrl"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? ["Meta"] : []), key
  ].join("+"));
}

export function formatSelectionShortcut(shortcut: string): string {
  return shortcut ? shortcut.split("+").join(" + ") : "未设置";
}
