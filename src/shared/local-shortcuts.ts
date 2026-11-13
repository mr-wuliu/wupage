import { t } from "./i18n";
import { canonicalShortcutChord, orderedShortcutModifiers, shortcutFromEvent, shortcutKeyLabel, SHORTCUT_MODIFIERS } from "./shortcut-keys";
export const LOCAL_BINDINGS = [
  { name: "paragraph-click", get label() { return t("paragraphClick"); }, toggle: "paragraph-click" },
  { name: "selection-submit", get label() { return t("submitSelectedText"); }, toggle: "selection-submit" },
  { name: "dismiss-overlays", get label() { return t("closeCardCollapseMenu"); }, toggle: "dismiss-overlays" },
  { name: "floating-activate", get label() { return t("translateWithFloatingButton"); }, toggle: "floating-controls" },
  { name: "floating-menu", get label() { return t("openFloatingMenu"); }, toggle: "floating-controls" }
] as const;
export type LocalBinding = typeof LOCAL_BINDINGS[number]["name"];
export type LocalShortcutSettings = Record<LocalBinding, string>;
export const DEFAULT_LOCAL_SHORTCUTS: LocalShortcutSettings = {
  "paragraph-click": "Ctrl", "selection-submit": "Primary+Enter", "dismiss-overlays": "Escape",
  "floating-activate": "Enter|Space", "floating-menu": "ArrowDown"
};
const LOCAL_MODIFIERS = [...SHORTCUT_MODIFIERS, "Primary"];

export function canonicalLocalShortcut(value: unknown, pointer = false): string | undefined {
  if (value === "") return "";
  if (typeof value !== "string") return;
  if (pointer) return orderedShortcutModifiers(value.split("+"))?.join("+");
  const alternatives = value.split("|");
  if (alternatives.length > 3) return;
  const result: string[] = [];
  for (const alternative of alternatives) {
    const binding = canonicalShortcutChord(alternative, LOCAL_MODIFIERS);
    if (!binding || (binding.includes("Primary+") && /(?:Ctrl|Meta)\+/.test(binding))) return;
    if (!result.includes(binding)) result.push(binding);
  }
  return result.join("|");
}

export function normalizeLocalShortcuts(value: unknown): LocalShortcutSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(LOCAL_BINDINGS.map(({ name }) => [name,
    canonicalLocalShortcut(input[name], name === "paragraph-click") ?? DEFAULT_LOCAL_SHORTCUTS[name]
  ])) as LocalShortcutSettings;
}

export function localShortcutVariants(value: string): string[] {
  return value.split("|").filter(Boolean).flatMap(binding => binding.includes("Primary")
    ? [binding.replace("Primary", "Ctrl"), binding.replace("Primary", "Meta")] : [binding])
    .map(binding => canonicalShortcutChord(binding)).filter((binding): binding is string => !!binding)
    // Existing local Enter bindings also match keypad Enter.
    .flatMap(binding => /(^|\+)Enter$/.test(binding) ? [binding, binding.replace(/Enter$/, "NumpadEnter")] : [binding]);
}

export function matchesLocalShortcut(event: KeyboardEvent, value: string): boolean {
  const actual = shortcutFromEvent(event);
  return !!actual && localShortcutVariants(value).includes(actual);
}

export function matchesParagraphClick(event: MouseEvent, value: string): boolean {
  if (!value || event.button !== 0 || event.defaultPrevented) return false;
  const binding = canonicalLocalShortcut(value, true);
  return !!binding && [["Ctrl", event.ctrlKey], ["Alt", event.altKey], ["Shift", event.shiftKey], ["Meta", event.metaKey]]
    .every(([modifier, pressed]) => binding.split("+").includes(modifier as string) === pressed);
}

export function formatLocalShortcut(value: string, mac = /Mac/.test(globalThis.navigator?.platform ?? "")): string {
  return value.split("|").map(binding => binding.replace("Primary", mac ? "Meta" : "Ctrl").split("+")
    .map(key => {
      switch (key) {
        case "Meta": return mac ? "Command" : "Win";
        case "Alt": return mac ? "Option" : key;
        case "Space": return t("space");
        case "ArrowDown": return t("downArrow");
        case "ArrowUp": return t("upArrow");
        case "ArrowLeft": return t("leftArrow");
        case "ArrowRight": return t("rightArrow");
        default: return shortcutKeyLabel(key);
      }
    }).join("＋")).join(" / ");
}

export function paragraphClickHint(value: unknown, enabled = true): string {
  const binding = normalizeLocalShortcuts(value)["paragraph-click"];
  return !binding ? t("setAParagraphClickShortcutInSettingsKeyboard") : !enabled ? t("theParagraphClickShortcutIsOffEnableIt")
    : t("onAnyPageHoldAndClickAParagraph", formatLocalShortcut(binding));
}
