import { t } from "./i18n";
import { normalizeLocalShortcuts } from "./local-shortcuts";

export const TRANSLATION_SHORTCUTS = [
  { name: "toggle-page-translation", get label() { return t("translatePageRestoreOriginal"); } },
  { name: "translate-selection", get label() { return t("paragraphTranslation"); } },
  { name: "toggle-paragraph-mode", get label() { return t("toggleParagraphMode"); } },
  { name: "cycle-display-mode", get label() { return t("cycleTranslationDisplayMode"); } }
] as const;

export type TranslationShortcut = typeof TRANSLATION_SHORTCUTS[number]["name"];

export const LOCAL_SHORTCUTS = [
  { name: "paragraph-click", get label() { return t("translateRestoreCurrentParagraphInParagraphMode"); }, get keys() { return ["Ctrl", t("paragraphClickShortcut")] as const; } },
  { name: "selection-submit", get label() { return t("submitEditedSourceInSelectionCard"); }, keys: ["Ctrl", "Enter"] },
  { name: "dismiss-overlays", get label() { return t("closeSelectionCardCollapseFloatingMenu"); }, keys: ["Esc"] },
  { name: "floating-controls", get label() { return t("translateWithFloatingButtonOpenMenu"); }, get keys() { return [t("enterSpace"), "↓"] as const; } }
] as const;
export type LocalShortcut = typeof LOCAL_SHORTCUTS[number]["name"];
export type ShortcutEnabledSettings = Record<TranslationShortcut | LocalShortcut, boolean>;
export const DEFAULT_SHORTCUT_ENABLED = Object.fromEntries(
  [...TRANSLATION_SHORTCUTS, ...LOCAL_SHORTCUTS].map(({ name }) => [name, true])
) as ShortcutEnabledSettings;

export type ShortcutSettings = Record<TranslationShortcut, string>;

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  "toggle-page-translation": "Alt+Shift+Y",
  "translate-selection": "Alt+Shift+Q",
  "toggle-paragraph-mode": "Alt+Shift+L",
  "cycle-display-mode": "Alt+Shift+M"
};

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];
const KEYS = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Enter|Space)$/;

export function canonicalShortcut(value: unknown): string | undefined {
  if (value === "") return "";
  if (typeof value !== "string") return;
  const parts = value.split("+");
  const key = parts.pop()!;
  if (!KEYS.test(key) || !parts.length || new Set(parts).size !== parts.length
    || parts.some(part => !MODIFIERS.includes(part)) || !parts.some(part => part !== "Shift")) return;
  return [...MODIFIERS.filter(modifier => parts.includes(modifier)), key].join("+");
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
  const code = event.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5)
    : code === "Space" ? "Space" : code || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return canonicalShortcut([
    ...(event.ctrlKey ? ["Ctrl"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? ["Meta"] : []), key
  ].join("+"));
}

export function shortcutWarning(value: string): string | undefined {
  if (!value) return;
  const shortcut = canonicalShortcut(value);
  if (!shortcut) return;
  if (shortcut.includes("Ctrl+") && shortcut.includes("Alt+")) return t("thisCombinationMayConflictWithAltgrInput");
  const parts = shortcut.split("+");
  const key = parts.at(-1)!;
  const platformModifier = parts.includes("Ctrl") || parts.includes("Meta");
  const browserOrEditing = platformModifier && !parts.includes("Alt") && (
    (!parts.includes("Shift") && /^[A-Z0-9]$/.test(key))
    || (parts.includes("Shift") && /^[ABCDEGHIJKLMNOPQRSTVWZ]$/.test(key))
    || ["Tab", "Enter", "PageUp", "PageDown"].includes(key));
  const altBrowser = shortcut === "Alt+F4" || /^Alt\+(?:D|E|F|Home|ArrowLeft|ArrowRight)$/.test(shortcut)
    || /^Alt\+Shift\+[ABCINPRTWXZ]$/.test(shortcut);
  if (browserOrEditing || altBrowser) return t("thisCombinationMayConflictWithABrowserOr");
}

export function normalizeShortcuts(value: unknown): ShortcutSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const used = new Set<string>();
  return Object.fromEntries(TRANSLATION_SHORTCUTS.map(({ name }) => {
    const parsed = canonicalShortcut(input[name]);
    let binding = parsed !== undefined ? parsed : DEFAULT_SHORTCUTS[name];
    if (binding && used.has(binding)) binding = "";
    if (binding) used.add(binding);
    return [name, binding];
  })) as ShortcutSettings;
}

export function formatShortcut(value: string, mac = false): string {
  return value.split("+").map(key => key === "Meta" ? (mac ? "Command" : "Win") : key === "Alt" && mac ? "Option" : key).join("＋");
}

export function normalizeShortcutEnabled(value: unknown, bindings?: unknown, localBindings?: unknown): ShortcutEnabledSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const shortcuts = normalizeShortcuts(bindings);
  const local = normalizeLocalShortcuts(localBindings);
  return Object.fromEntries([...TRANSLATION_SHORTCUTS, ...LOCAL_SHORTCUTS].map(({ name }) => [
    name, input[name] !== false && (name in shortcuts ? Boolean(shortcuts[name as TranslationShortcut])
      : name === "floating-controls" ? Boolean(local["floating-activate"] || local["floating-menu"]) : Boolean(local[name as Exclude<LocalShortcut, "floating-controls">]))
  ])) as ShortcutEnabledSettings;
}
