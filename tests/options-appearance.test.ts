// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_SCHEMES, DEFAULT_APPEARANCE } from "../src/shared/appearance";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("appearance editor", () => {
  let stored: ExtensionSettings;
  let sendMessage: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, "", "/options.html#appearanceSettings");
    document.open(); document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8")); document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: stored };
      if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "not-installed" } };
      if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
      if (request.type === "RESET_SETTINGS") {
        stored = normalizeSettings(structuredClone(DEFAULT_SETTINGS));
        return { ok: true, data: structuredClone(stored) };
      }
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const resetDialog = document.querySelector<HTMLDialogElement>("#settingsResetDialog")!;
    resetDialog.showModal = function () { this.open = true; };
    resetDialog.close = function () { this.open = false; };
  });
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); vi.restoreAllMocks();
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.wupageTheme;
    document.documentElement.replaceChildren(); history.replaceState(null, "", "/");
  });
  async function mount(): Promise<void> {
    await import("../src/options/index");
    await vi.waitFor(() => expect(query("#providerTriggerLabel").textContent).toBe("Microsoft 翻译"));
  }

  it("previews, reorders and saves selected menu functions without changing feature switches", async () => {
    await mount();
    query<HTMLButtonElement>("#appearanceMenuTab").click();
    expect(query<HTMLElement>("#appearanceMenuPanel").hidden).toBe(false);
    query<HTMLButtonElement>('#popupMenuPreview [data-popup-menu-item="videoTranslation"]').click();
    query<HTMLButtonElement>('#popupMenuPreview [data-popup-menu-item="floatingBall"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }));
    expect(query('#popupMenuPreview [data-popup-menu-item="videoTranslation"]').hasAttribute("data-popup-menu-hidden")).toBe(true);
    const features = query('#popupMenuPreview [data-popup-menu-grid]');
    expect((features.firstElementChild as HTMLElement).dataset.popupMenuItem).toBe("floatingBall");
    expect(query<HTMLButtonElement>('[data-menu-add="videoTranslation"]').hidden).toBe(false);
    query<HTMLButtonElement>('#popupMenuPreview [data-popup-menu-item="debug"]').click();
    query<HTMLButtonElement>('[data-menu-add="debug"]').click();
    expect(query<HTMLButtonElement>('[data-menu-add="debug"]').hidden).toBe(true);
    expect([...features.querySelectorAll<HTMLElement>("[data-popup-menu-item]")].filter(node => !node.hasAttribute("data-popup-menu-hidden")).at(-1)?.dataset.popupMenuItem).toBe("debug");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.popupMenu.hidden).toContain("videoTranslation"));
    expect(stored.appearance!.popupMenu.order.indexOf("floatingBall")).toBeLessThan(stored.appearance!.popupMenu.order.indexOf("contextMenuTranslation"));
    expect(stored.floatingBallEnabled).toBe(true);
    expect(stored.videoTranslation).toBeUndefined();
  });

  it("resets only the menu draft and supports keyboard navigation between appearance tabs", async () => {
    stored.appearance = { ...structuredClone(DEFAULT_APPEARANCE), lightSchemeId: "paper", floatingOpacity: 61 };
    await mount();
    const colors = query<HTMLButtonElement>("#appearanceColorsTab"); colors.focus();
    colors.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(query("#appearanceMenuTab"));
    expect(query<HTMLElement>("#appearanceMenuPanel").hidden).toBe(false);
    query<HTMLButtonElement>('#popupMenuPreview [data-popup-menu-item="debug"]').click();
    query<HTMLButtonElement>("#resetPopupMenu").click();
    expect(query<HTMLButtonElement>('[data-menu-add="debug"]').hidden).toBe(true);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toBe("已保存。"));
    expect(stored.appearance?.popupMenu.hidden).toEqual([]);
    expect(stored.appearance?.lightSchemeId).toBe("paper");
    expect(stored.appearance?.floatingOpacity).toBe(61);
  });

  it("copies, previews and saves a custom palette together with drafts in other categories", async () => {
    await mount();
    expect(query<HTMLElement>("#appearanceSettings").hidden).toBe(false);
    expect(query<HTMLInputElement>("#appearance-color-accent").disabled).toBe(true);
    query<HTMLInputElement>("[name='appearanceMode'][value='light']").click();
    query<HTMLButtonElement>("#duplicateScheme").click();
    const name = query<HTMLInputElement>("#appearanceSchemeName");
    name.value = "我的配色"; name.dispatchEvent(new Event("input"));
    const hex = query<HTMLInputElement>("[data-color-hex='accent']");
    hex.value = "#cc5533"; hex.dispatchEvent(new Event("input"));
    expect(query<HTMLElement>("#appearancePreview").style.getPropertyValue("--wp-accent")).toBe("#cc5533");
    expect(document.documentElement.style.getPropertyValue("--wp-accent")).toBe("#cc5533");
    query<HTMLAnchorElement>("a[aria-controls='providerSettings']").click();
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLSelectElement>("#sourceLang").value = "en";
    query<HTMLAnchorElement>("a[aria-controls='appearanceSettings']").click();
    expect(query<HTMLInputElement>("#appearanceSchemeName").value).toBe("我的配色");
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes[0]).toMatchObject({ name: "我的配色", colors: { accent: "#cc5533" } }));
    expect(stored.appearance?.lightSchemeId).toBe(stored.appearance?.customSchemes[0].id);
    expect(stored.sourceLang).toBe("en");
    expect(BUILT_IN_SCHEMES[0].colors.accent).toBe("#116466");
  });

  it("explains locked built-in colors and offers an explicit copy before editing", async () => {
    await mount();
    const notice = query<HTMLElement>("#appearanceCopyNotice");
    expect(notice.hidden).toBe(true);
    query<HTMLButtonElement>('[data-color-group="floating"] .appearance-locked-color').click();
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("请先复制方案");
    expect(document.activeElement).toBe(query("#copySchemeToEdit"));
    expect(query<HTMLSelectElement>("#appearanceScheme").value).toBe("wupage-light");
    query<HTMLButtonElement>("#copySchemeToEdit").click();
    expect(notice.hidden).toBe(true);
    expect(query<HTMLElement>("#customSchemeName").hidden).toBe(false);
    expect(document.activeElement).toBe(query("#appearanceSchemeName"));
    expect(query<HTMLInputElement>("#appearance-color-floating-background").disabled).toBe(false);
    expect(document.querySelector(".appearance-locked-color")).toBeNull();
  });

  it("renames an existing custom scheme without changing its identity or colors", async () => {
    stored.appearance = { ...structuredClone(DEFAULT_APPEARANCE), lightSchemeId: "custom-saved",
      customSchemes: [{ ...BUILT_IN_SCHEMES[0], id: "custom-saved", name: "旧名称" }] };
    await mount();
    const name = query<HTMLInputElement>("#appearanceSchemeName");
    expect(query<HTMLElement>("#customSchemeName").hidden).toBe(false);
    name.value = "  阅读配色  "; name.dispatchEvent(new Event("input"));
    expect(query<HTMLSelectElement>("#appearanceScheme").selectedOptions[0].textContent).toBe("阅读配色");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes[0].name).toBe("阅读配色"));
    expect(stored.appearance?.customSchemes).toHaveLength(1);
    expect(stored.appearance?.customSchemes[0]).toMatchObject({ id: "custom-saved", colors: BUILT_IN_SCHEMES[0].colors });
  });

  it("previews and saves independent color opacities, retaining alpha when the color changes", async () => {
    await mount();
    query<HTMLButtonElement>("#duplicateScheme").click();
    const toggle = query<HTMLButtonElement>('[data-color-opacity="floating-background"]');
    expect(toggle.textContent).toBe("100%"); toggle.click();
    const range = query<HTMLInputElement>("#appearance-opacity-floating-background-range");
    expect(document.activeElement).toBe(range);
    range.value = "35"; range.dispatchEvent(new Event("input"));
    expect(query<HTMLInputElement>('[data-color-opacity-number="floating-background"]').value).toBe("35");
    const hex = query<HTMLInputElement>('[data-color-hex="floating-background"]');
    hex.value = "#aa3344"; hex.dispatchEvent(new Event("input"));
    expect(query<HTMLElement>("#appearancePreview").style.getPropertyValue("--wp-floating-background")).toBe("rgba(170, 51, 68, 0.35)");
    query<HTMLButtonElement>('[data-color-opacity="translation-light"]').click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const number = query<HTMLInputElement>('[data-color-opacity-number="translation-light"]');
    number.value = "25"; number.dispatchEvent(new Event("input"));
    expect(query<HTMLElement>(".appearance-preview-translation-light").style.color).toBe("rgba(15, 118, 110, 0.25)");
    number.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(query<HTMLElement>("#appearance-opacity-translation-light").hidden).toBe(true);
    expect(document.activeElement).toBe(query('[data-color-opacity="translation-light"]'));
    query<HTMLButtonElement>("[data-appearance-tone='dark']").click();
    query<HTMLButtonElement>("[data-appearance-tone='light']").click();
    expect(query<HTMLInputElement>('[data-color-opacity-number="floating-background"]').value).toBe("35");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes[0].opacities).toEqual({ "floating-background": 35, "translation-light": 25 }));
    expect(stored.appearance?.floatingOpacity).toBe(100);
    query<HTMLButtonElement>("#duplicateScheme").click();
    query<HTMLButtonElement>("#resetSchemeColors").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes).toHaveLength(2));
    expect(stored.appearance?.customSchemes[0].opacities).toEqual({ "floating-background": 35, "translation-light": 25 });
    expect(stored.appearance?.customSchemes[1].opacities).toBeUndefined();
  });

  it("reopens a collapsed color opacity editor when its value prevents saving", async () => {
    await mount(); query<HTMLButtonElement>("#duplicateScheme").click();
    query<HTMLButtonElement>('[data-color-opacity="selection-background"]').click();
    const number = query<HTMLInputElement>('[data-color-opacity-number="selection-background"]');
    number.value = "101"; number.dispatchEvent(new Event("input"));
    query<HTMLButtonElement>('[data-color-opacity="selection-background"]').click();
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("整数透明度"));
    expect(query<HTMLElement>("#appearance-opacity-selection-background").hidden).toBe(false);
    expect(query<HTMLDetailsElement>('[data-color-group="selection"]').open).toBe(true);
    expect(document.activeElement).toBe(number);
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    number.value = "0"; number.dispatchEvent(new Event("input"));
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes[0].opacities?.["selection-background"]).toBe(0));
  });

  it("configures light and dark palettes independently and recovers after deleting a custom scheme", async () => {
    await mount();
    query<HTMLSelectElement>("#appearanceScheme").value = "paper";
    query("#appearanceScheme").dispatchEvent(new Event("change"));
    query<HTMLButtonElement>("[data-appearance-tone='dark']").click();
    query<HTMLSelectElement>("#appearanceScheme").value = "midnight";
    query("#appearanceScheme").dispatchEvent(new Event("change"));
    query<HTMLButtonElement>("#duplicateScheme").click();
    query<HTMLInputElement>("#appearance-color-accent").value = "#fefefe";
    query("#appearance-color-accent").dispatchEvent(new Event("input"));
    expect(query<HTMLElement>("#appearancePreview").style.getPropertyValue("--wp-on-accent")).toBe("#000000");
    query<HTMLButtonElement>("#resetSchemeColors").click();
    expect(query<HTMLInputElement>("#appearance-color-accent").value).toBe("#83d2c5");
    query<HTMLButtonElement>("#deleteScheme").click();
    expect(query<HTMLSelectElement>("#appearanceScheme").value).toBe(DEFAULT_APPEARANCE.darkSchemeId);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance).toMatchObject({ mode: "system", lightSchemeId: "paper", darkSchemeId: "wupage-dark", customSchemes: [] }));
    query<HTMLButtonElement>("#restore").click();
    query<HTMLButtonElement>("#confirmSettingsReset").click();
    await vi.waitFor(() => expect(stored.appearance).toEqual(DEFAULT_APPEARANCE));
  });

  it("reveals invalid colors when saving from another category", async () => {
    await mount();
    query<HTMLButtonElement>("#duplicateScheme").click();
    const hex = query<HTMLInputElement>("[data-color-hex='accent']");
    hex.value = "#123"; hex.dispatchEvent(new Event("input"));
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("十六进制"));
    expect(query<HTMLElement>("#appearanceSettings").hidden).toBe(false);
    expect(document.activeElement).toBe(hex);
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    hex.value = "#123456"; hex.dispatchEvent(new Event("input"));
    query<HTMLInputElement>("#appearanceSchemeName").value = " ";
    query("#appearanceSchemeName").dispatchEvent(new Event("input"));
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("方案名称"));
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
  });

  it("saves independent component colors and previews both webpage backgrounds", async () => {
    await mount();
    query<HTMLButtonElement>("#duplicateScheme").click();
    const updates = { "floating-background": "#b83468", "floating-foreground": "#ffffff", "floating-hover": "#91274e",
      "translation-light": "#aa3344", "translation-dark": "#f3c97a", "selection-background": "#fffaf0", "image-button-background": "#202c2e" };
    for (const [key, value] of Object.entries(updates)) {
      const field = query<HTMLInputElement>(`[data-color-hex='${key}']`);
      field.value = value; field.dispatchEvent(new Event("input"));
    }
    expect(query<HTMLElement>("#appearancePreview").style.getPropertyValue("--wp-floating-background")).toBe("#b83468");
    expect(query<HTMLElement>(".appearance-preview-translation-light").style.color).toBe("rgb(170, 51, 68)");
    expect(query<HTMLElement>(".appearance-preview-translation-dark").style.color).toBe("rgb(243, 201, 122)");
    expect(query<HTMLInputElement>("[data-color-hex='accent']").value).toBe("#116466");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.customSchemes[0].colors).toMatchObject(updates));
  });

  it("links the opacity slider and numeric field, retains the draft and saves without copying a palette", async () => {
    await mount();
    const range = query<HTMLInputElement>("#floatingOpacityRange");
    const number = query<HTMLInputElement>("#floatingOpacityNumber");
    expect(range.disabled).toBe(false); expect(range.value).toBe("100");
    range.value = "35"; range.dispatchEvent(new Event("input"));
    expect(number.value).toBe("35");
    expect(document.documentElement.style.getPropertyValue("--wp-floating-opacity")).toBe("0.35");
    number.value = "0"; number.dispatchEvent(new Event("input"));
    expect(range.value).toBe("0");
    number.value = "62"; number.dispatchEvent(new Event("input"));
    expect(range.value).toBe("62");
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    query<HTMLButtonElement>("[data-appearance-tone='dark']").click();
    expect(query<HTMLInputElement>("#floatingOpacityNumber").value).toBe("62");
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLAnchorElement>("a[aria-controls='appearanceSettings']").click();
    expect(query<HTMLInputElement>("#floatingOpacityRange").value).toBe("62");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.floatingOpacity).toBe(62));
    expect(stored.appearance?.customSchemes).toEqual([]);
    query<HTMLButtonElement>("#restore").click();
    query<HTMLButtonElement>("#confirmSettingsReset").click();
    await vi.waitFor(() => {
      expect(stored.appearance?.floatingOpacity).toBe(100);
      expect(query<HTMLInputElement>("#floatingOpacityNumber").value).toBe("100");
    });
  });

  it("reveals an invalid opacity percentage when saving from another category and allows correction", async () => {
    await mount();
    const number = query<HTMLInputElement>("#floatingOpacityNumber");
    number.value = "101"; number.dispatchEvent(new Event("input"));
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("整数透明度"));
    expect(query<HTMLElement>("#appearanceSettings").hidden).toBe(false);
    expect(document.activeElement).toBe(number);
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    number.value = "45"; number.dispatchEvent(new Event("input"));
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.appearance?.floatingOpacity).toBe(45));
  });
});

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
