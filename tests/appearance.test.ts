// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { accentForeground, applyColorScheme, BUILT_IN_SCHEMES, COLOR_FIELDS, DEFAULT_APPEARANCE, getColorScheme, normalizeAppearance, schemeColor } from "../src/shared/appearance";
import { setupAppearance } from "../src/shared/appearance-runtime";
import { SETTINGS_KEY } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.wupageTheme;
  vi.unstubAllGlobals();
});

describe("appearance settings", () => {
  it("adds independent defaults to older settings", () => {
    const first = normalizeSettings({});
    expect(first.appearance).toEqual(DEFAULT_APPEARANCE);
    first.appearance!.customSchemes.push({ ...BUILT_IN_SCHEMES[0], id: "custom-test" });
    expect(normalizeSettings({}).appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it("validates saved palettes and rejects invalid CSS and conflicting IDs", () => {
    const result = normalizeAppearance({ mode: "invalid", lightSchemeId: "custom-ink", darkSchemeId: "paper", customSchemes: [
      { id: "paper", tone: "light" }, { id: "custom-ink", tone: "light", name: "  墨色  ", colors: {
        accent: "#AABBCC", surface: "red; color: transparent", foreground: "#123" } },
      { id: "custom-ink", tone: "dark" }, { id: "custom-bad", tone: "other" }, null
    ] });
    expect(result.mode).toBe("system");
    expect(result.customSchemes).toHaveLength(1);
    expect(result.customSchemes[0]).toMatchObject({ name: "墨色", colors: { accent: "#aabbcc", surface: "#ffffff", foreground: "#172026" } });
    expect(getColorScheme(result, "light").id).toBe("custom-ink");
    expect(result.darkSchemeId).toBe(DEFAULT_APPEARANCE.darkSchemeId);
    expect(normalizeAppearance({ customSchemes: Array.from({ length: 40 }, (_, n) => ({
      id: `custom-${n}`, tone: "light", name: "a".repeat(90)
    })) }).customSchemes).toHaveLength(32);
  });

  it("chooses readable button labels for bright and dark accents", () => {
    expect(accentForeground("#ffffff")).toBe("#000000");
    expect(accentForeground("#83d2c5")).toBe("#000000");
    expect(accentForeground("#116466")).toBe("#ffffff");
  });

  it("migrates older custom schemes and keeps widget colors independent", () => {
    const legacy = normalizeAppearance({ customSchemes: [{ id: "custom-old", tone: "light", colors: {
      accent: "#b83468", surface: "#fffaf0", foreground: "#332211"
    } }] }).customSchemes[0];
    expect(legacy.colors).toMatchObject({ "floating-background": "#b83468", "selection-background": "#fffaf0", "selection-foreground": "#332211" });
    const current = normalizeAppearance({ customSchemes: [{ ...legacy, colors: {
      ...legacy.colors, accent: "#336699", "floating-background": "#123456", "translation-light": "#aa3344", "translation-dark": "#f3c97a"
    } }] }).customSchemes[0];
    expect(current.colors).toMatchObject({ accent: "#336699", "floating-background": "#123456", "translation-light": "#aa3344", "translation-dark": "#f3c97a" });
  });

  it("keeps opacity compatible with old settings and validates imported percentages", () => {
    expect(normalizeAppearance(undefined).floatingOpacity).toBe(100);
    for (const [value, expected] of [[0, 0], [45, 45], [100, 100], [-10, 0], [150, 100], [45.6, 46], [NaN, 100], [Infinity, 100], ["45", 100]]) {
      expect(normalizeAppearance({ floatingOpacity: value }).floatingOpacity).toBe(expected);
    }
    expect(normalizeSettings({ appearance: { floatingOpacity: 0 } }).appearance?.floatingOpacity).toBe(0);
  });

  it("defaults every color to opaque and validates per-color opacity without changing legacy colors", () => {
    for (const scheme of BUILT_IN_SCHEMES) {
      for (const { key } of COLOR_FIELDS) expect(schemeColor(scheme, key)).toBe(scheme.colors[key]);
    }
    const source = { ...BUILT_IN_SCHEMES[0], id: "custom-opacity", opacities: {
      "floating-background": 45.6, "translation-light": 0, accent: -10, surface: 150,
      muted: "45", border: NaN, foreground: Infinity, unknown: 40
    } };
    const scheme = normalizeAppearance({ customSchemes: [source] }).customSchemes[0];
    expect(scheme.opacities).toEqual({ "floating-background": 46, "translation-light": 0, accent: 0 });
    expect(scheme.colors).toEqual(source.colors);
    applyColorScheme(document.documentElement, scheme);
    expect(document.documentElement.style.getPropertyValue("--wp-floating-background")).toBe("rgba(17, 100, 102, 0.46)");
    expect(document.documentElement.style.getPropertyValue("--wp-translation-light")).toBe("rgba(15, 118, 110, 0)");
    expect(normalizeAppearance({ customSchemes: [{ ...source, opacities: { accent: 100 } }] }).customSchemes[0].opacities).toBeUndefined();
  });
});

describe("appearance updates", () => {
  it("follows the system, honors explicit modes, syncs saved changes and cleans up", () => {
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = false;
    const removeMedia = vi.spyOn(media, "removeEventListener");
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    const addListener = vi.fn(), removeListener = vi.fn();
    vi.stubGlobal("chrome", { storage: { onChanged: { addListener, removeListener } } });
    const theme = setupAppearance(undefined);
    expect(document.documentElement.style.getPropertyValue("--wp-floating-opacity")).toBe("1");
    expect(document.documentElement.style.colorScheme).toBe("light");
    media.matches = true; media.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.wupageTheme).toBe("dark");
    theme.update({ mode: "light", lightSchemeId: "paper" });
    expect(document.documentElement.style.getPropertyValue("--wp-background")).toBe("#f5f1e8");
    media.dispatchEvent(new Event("change"));
    expect(document.documentElement.style.colorScheme).toBe("light");
    const changed = addListener.mock.calls[0][0];
    changed({ [SETTINGS_KEY]: { newValue: { appearance: { mode: "dark", darkSchemeId: "midnight", floatingOpacity: 35 } } } }, "local");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--wp-accent")).toBe("#9cbcff");
    expect(document.documentElement.style.getPropertyValue("--wp-floating-opacity")).toBe("0.35");
    theme.dispose();
    expect(removeListener).toHaveBeenCalledWith(changed);
    expect(removeMedia).toHaveBeenCalled();
  });

  it("does not change a host website's native color scheme", () => {
    document.documentElement.style.colorScheme = "light";
    const theme = setupAppearance({ mode: "dark" }, { extensionPage: false, live: false });
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--wp-color-scheme")).toBe("dark");
    theme.dispose();
  });
});
