import { describe, expect, it } from "vitest";
import { normalizeSelectionTranslation, normalizeSelectionShortcut, shortcutFromEvent } from "../src/shared/selection-translation";
import { normalizeSettings } from "../src/shared/settings";

function event(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return { code: "KeyE", key: "e", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false,
    isComposing: false, repeat: false, getModifierState: () => false, ...overrides } as KeyboardEvent;
}

describe("selection shortcut normalization", () => {
  it("migrates old settings with defaults and preserves explicit disable", () => {
    expect(normalizeSettings({}).selectionTranslation).toEqual({ showIcon: true, shortcut: "Alt+Shift+T" });
    expect(normalizeSettings({ selectionTranslation: { showIcon: false, shortcut: "" } }).selectionTranslation)
      .toEqual({ showIcon: false, shortcut: "" });
    expect(normalizeSelectionTranslation({ showIcon: "no", shortcut: "malformed" }))
      .toEqual({ showIcon: true, shortcut: "Alt+Shift+T" });
  });
  it("canonicalizes modifier order", () => {
    expect(normalizeSelectionShortcut("Shift+Ctrl+E")).toBe("Ctrl+Shift+E");
  });
  it.each(["A", "Shift+A", "Ctrl+Ctrl+E", "Ctrl+V", "Meta+C", "Ctrl+T", "Ctrl+Shift+T", "Alt+F", "Ctrl+Enter", "Alt+F4"])
    ("rejects unsupported or common reserved shortcut %s", shortcut => {
      expect(normalizeSelectionShortcut(shortcut)).toBeNull();
    });
  it("matches physical keys with Option symbols but rejects repeats, composition and AltGraph", () => {
    expect(shortcutFromEvent(event({ key: "´", altKey: true, ctrlKey: false }))).toBe("Alt+Shift+E");
    expect(shortcutFromEvent(event({ repeat: true }))).toBeNull();
    expect(shortcutFromEvent(event({ isComposing: true }))).toBeNull();
    expect(shortcutFromEvent(event({ getModifierState: () => true }))).toBeNull();
    expect(shortcutFromEvent(event({ code: "ShiftLeft", key: "Shift" }))).toBeNull();
  });
});
