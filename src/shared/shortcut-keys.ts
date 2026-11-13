export const SHORTCUT_MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];

const SYMBOL_KEYS = {
  Backquote: "`~", Backslash: "\\|", BracketLeft: "[{", BracketRight: "]}", Comma: ",<", Equal: "=+",
  Minus: "-_", Period: ".>", Quote: "'\"", Semicolon: ";:", Slash: "/?"
};
const NAMED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "Enter", "Space", "Escape", "Tab", "Backspace", "Delete", "Insert", "ContextMenu",
  "CapsLock", "NumLock", "ScrollLock", "PrintScreen", "Pause", "IntlBackslash", "IntlRo", "IntlYen",
  "Convert", "NonConvert", "KanaMode", "Lang1", "Lang2", "Lang3", "Lang4", "Lang5",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadComma", "NumpadEnter",
  "NumpadEqual", "NumpadBackspace", "NumpadClear", "NumpadClearEntry", "NumpadHash", "NumpadStar", "NumpadParenLeft", "NumpadParenRight",
  "NumpadMemoryAdd", "NumpadMemorySubtract", "NumpadMemoryStore", "NumpadMemoryRecall", "NumpadMemoryClear",
  ...Object.keys(SYMBOL_KEYS)
]);

export function orderedShortcutModifiers(parts: string[], allowed = SHORTCUT_MODIFIERS): string[] | undefined {
  const unique = new Set(parts);
  const ordered = allowed.filter(modifier => unique.has(modifier));
  return ordered.length === parts.length ? ordered : undefined;
}

export function canonicalShortcutChord(value: string, allowed = SHORTCUT_MODIFIERS): string | undefined {
  const parts = value.split("+");
  const key = parts.pop()!;
  if (!NAMED_KEYS.has(key) && !/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Numpad\d)$/.test(key)) return;
  const modifiers = orderedShortcutModifiers(parts, allowed);
  return modifiers && [...modifiers, key].join("+");
}

export function ignoresShortcutEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph");
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (ignoresShortcutEvent(event)) return;
  const { code } = event;
  let key: string;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (code && code !== "Unidentified") key = code;
  else if (event.key === " ") key = "Space";
  else if (event.key.length === 1) {
    key = Object.entries(SYMBOL_KEYS).find(([, symbols]) => symbols.includes(event.key))?.[0] ?? event.key.toUpperCase();
  } else key = event.key;
  return canonicalShortcutChord([
    ...(event.ctrlKey ? ["Ctrl"] : []), ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []), ...(event.metaKey ? ["Meta"] : []), key
  ].join("+"));
}

export function shortcutKeyLabel(key: string): string {
  if (key === "Escape") return "Esc";
  if (key.startsWith("Numpad")) return `Num ${key.slice(6)}`;
  return Object.hasOwn(SYMBOL_KEYS, key) ? SYMBOL_KEYS[key as keyof typeof SYMBOL_KEYS][0] : key;
}

export function isPrintableShortcutKey(key: string): boolean {
  return /^[A-Z0-9]$/.test(key) || Object.hasOwn(SYMBOL_KEYS, key) || /^Numpad(?:\d|Add|Subtract|Multiply|Divide|Decimal|Comma|Equal)$/.test(key);
}
