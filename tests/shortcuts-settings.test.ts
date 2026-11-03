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
      "cycle-display-mode": "Ctrl+C", "translate-input": "Alt+Shift+K"
    });
    for (const value of [null, [], 123, "invalid"]) expect(normalizeShortcuts(value)).toEqual(DEFAULT_SHORTCUTS);
  });
  it("rejects incomplete and repeated modifiers and preserves physical-key names", () => {
    expect(canonicalShortcut("Shift+Alt+7")).toBe("Alt+Shift+7");
    expect(canonicalShortcut("Ctrl+F8")).toBe("Ctrl+F8");
    for (const value of ["Shift+Y", "Y", "Alt+Alt+Y", "Alt+KeyY", "Alt+Escape", "Alt+Plus", false]) {
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
  it("adds the input translation key to older settings unless the user already bound it elsewhere", () => {
    const old = { "toggle-page-translation": "Alt+Shift+Y", "translate-selection": "Alt+Shift+Q",
      "toggle-paragraph-mode": "Alt+Shift+L", "cycle-display-mode": "Alt+Shift+M" };
    expect(normalizeSettings({ shortcuts: old }).shortcuts?.["translate-input"]).toBe("Alt+Shift+K");
    expect(normalizeSettings({ shortcuts: old }).shortcutEnabled?.["translate-input"]).toBe(true);
    const taken = normalizeSettings({ shortcuts: { ...old, "cycle-display-mode": "Alt+Shift+K" } });
    expect(taken.shortcuts).toMatchObject({ "cycle-display-mode": "Alt+Shift+K", "translate-input": "" });
    expect(taken.shortcutEnabled?.["translate-input"]).toBe(false);
    expect(normalizeSettings({}).inputTranslation).toMatchObject({ enabled: true, providerId: "" });
  });
  it("removes native commands so browser bindings cannot steal or duplicate custom page shortcuts", () => {
    expect(manifest).not.toHaveProperty("commands");
  });
});
