import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import { canonicalShortcut, DEFAULT_SHORTCUTS, DEFAULT_SHORTCUT_ENABLED, normalizeShortcutEnabled, normalizeShortcuts, shortcutWarning } from "../src/shared/shortcuts";
import { normalizeSettings } from "../src/shared/settings";

describe("shortcut configuration", () => {
  it("adds defaults to older settings without sharing mutable defaults", () => {
    const settings = normalizeSettings({});
    expect(settings.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    settings.shortcuts!["toggle-page-translation"] = "";
    expect(normalizeSettings({}).shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });
  it("migrates older activation settings, keeps cleared keys off and retains disabled bindings", () => {
    expect(normalizeShortcutEnabled(undefined)).toEqual(DEFAULT_SHORTCUT_ENABLED);
    const old = normalizeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS, "translate-selection": "" } });
    expect(old.shortcutEnabled?.["translate-selection"]).toBe(false);
    const disabled = normalizeSettings({ shortcuts: DEFAULT_SHORTCUTS,
      shortcutEnabled: { "toggle-page-translation": false, "dismiss-overlays": false } });
    expect(disabled.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(disabled.shortcutEnabled).toMatchObject({ "toggle-page-translation": false, "translate-selection": true, "dismiss-overlays": false });
    disabled.shortcutEnabled!["selection-submit"] = false;
    expect(normalizeSettings({}).shortcutEnabled).toEqual(DEFAULT_SHORTCUT_ENABLED);
  });
  it("retains explicit empty values and custom keys while repairing invalid and duplicate settings", () => {
    expect(normalizeShortcuts({ "toggle-page-translation": "Shift+Alt+J", "translate-selection": "",
      "toggle-paragraph-mode": "Alt+Shift+J", "cycle-display-mode": "Ctrl+C" })).toEqual({
      "toggle-page-translation": "Alt+Shift+J", "translate-selection": "", "toggle-paragraph-mode": "",
      "cycle-display-mode": "Ctrl+C"
    });
    for (const value of [null, [], 123, "invalid"]) expect(normalizeShortcuts(value)).toEqual(DEFAULT_SHORTCUTS);
  });
  it("normalizes single keys and chords while rejecting malformed bindings", () => {
    for (const [input, expected] of [
      ["Y", "Y"], ["Shift+Y", "Shift+Y"], ["Ctrl+F8", "Ctrl+F8"], ["Alt+Escape", "Alt+Escape"],
      ["Shift+Alt+7", "Alt+Shift+7"], ["Meta+Shift+Alt+Ctrl+Slash", "Ctrl+Alt+Shift+Meta+Slash"],
      ["NumpadAdd", "NumpadAdd"], ["F24", "F24"]
    ]) expect(canonicalShortcut(input)).toBe(expected);
    for (const value of ["Shift", "Y+J", "Alt+Alt+Y", "Alt+KeyY", "Alt+Plus", "F25", false]) {
      expect(canonicalShortcut(value)).toBeUndefined();
    }
  });
  it("warns about possible conflicts while retaining the configured key through settings normalization", () => {
    for (const value of ["Ctrl+C", "Meta+V", "Ctrl+Shift+T", "Alt+F4", "Alt+Shift+T", "Ctrl+Alt+J"]) {
      expect(shortcutWarning(value)).toBeTruthy();
      expect(normalizeSettings({ shortcuts: { ...DEFAULT_SHORTCUTS, "toggle-page-translation": value } }).shortcuts?.["toggle-page-translation"]).toBe(value);
    }
    for (const value of Object.values(DEFAULT_SHORTCUTS)) expect(shortcutWarning(value)).toBeUndefined();
    expect(shortcutWarning("Alt+Shift+J")).toBeUndefined();
  });
  it("removes native commands so browser bindings cannot steal or duplicate custom page shortcuts", () => {
    expect(manifest).not.toHaveProperty("commands");
  });
});
