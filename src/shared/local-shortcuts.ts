import { t } from "./i18n";
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
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta", "Primary"];
const KEYS = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Enter|Space|Escape)$/;

export function canonicalLocalShortcut(value: unknown, pointer = false): string | undefined {
  if (value === "") return "";
  if (typeof value !== "string") return;
  const alternatives = value.split("|");
  if (alternatives.length > 3 || pointer && alternatives.length !== 1) return;
  const result: string[] = [];
  for (const alternative of alternatives) {
    const parts = alternative.split("+"), key = pointer ? undefined : parts.pop();
    if ((!pointer && (!key || !KEYS.test(key))) || pointer && !parts.length
      || new Set(parts).size !== parts.length || parts.some(part => !MODIFIERS.includes(part))
      || pointer && parts.includes("Primary") || parts.includes("Primary") && (parts.includes("Ctrl") || parts.includes("Meta"))
      || key && /^[A-Z0-9]$/.test(key) && !parts.some(part => part !== "Shift")) return;
    const binding = [...MODIFIERS.filter(modifier => parts.includes(modifier)), ...(key ? [key] : [])].join("+");
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
    .map(binding => canonicalLocalShortcut(binding)).filter((binding): binding is string => !!binding);
}

export function localShortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5)
    : event.code === "Space" || event.key === " " ? "Space" : event.code === "NumpadEnter" ? "Enter" : event.code || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return canonicalLocalShortcut([...(event.ctrlKey ? ["Ctrl"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? ["Meta"] : []), key].join("+"));
}

export function matchesLocalShortcut(event: KeyboardEvent, value: string): boolean {
  const actual = localShortcutFromEvent(event);
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
    .map(key => key === "Meta" ? mac ? "Command" : "Win" : key === "Alt" && mac ? "Option" : key).join("＋")
    .replace(/Escape/g, "Esc").replace(/Space/g, t("space")).replace(/ArrowDown/g, t("downArrow")).replace(/ArrowUp/g, t("upArrow"))
    .replace(/ArrowLeft/g, t("leftArrow")).replace(/ArrowRight/g, t("rightArrow"))).join(" / ");
}

export function paragraphClickHint(value: unknown, enabled = true): string {
  const binding = normalizeLocalShortcuts(value)["paragraph-click"];
  return !binding ? t("setAParagraphClickShortcutInSettingsKeyboard") : !enabled ? t("theParagraphClickShortcutIsOffEnableIt")
    : t("onAnyPageHoldAndClickAParagraph", formatLocalShortcut(binding));
}
