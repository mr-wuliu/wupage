// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("settings category navigation", () => {
  let stored: ExtensionSettings;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, "", "/options.html");
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: stored };
      if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "not-installed" } };
      if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
    document.documentElement.replaceChildren();
  });

  async function mount(): Promise<void> {
    await import("../src/options/index");
    await vi.waitFor(() => expect(query("#providerTriggerLabel").textContent).toBe("Microsoft 翻译"));
  }

  function navigate(id: string): void {
    query<HTMLAnchorElement>(`.settings-nav a[aria-controls="${id}"]`).click();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".settings-panel"))
      .filter(panel => !panel.hidden).map(panel => panel.id)).toEqual([id]);
    expect(document.querySelector(".settings-nav [aria-current='page']")?.getAttribute("aria-controls")).toBe(id);
  }

  it("retains drafts across categories and saves all categories together", async () => {
    await mount();
    expect(query<HTMLElement>("#generalSettings").hidden).toBe(false);
    query<HTMLSelectElement>("#sourceLang").value = "en";
    navigate("autoTranslationSettings");
    query<HTMLInputElement>("#autoTranslateEnabled").click();
    query<HTMLInputElement>("#autoTranslateSites input[data-preset='github.com']").click();
    navigate("providerSettings");
    navigate("performanceSettings");
    query<HTMLInputElement>("#concurrency").value = "2";
    navigate("generalSettings");
    expect(query<HTMLSelectElement>("#sourceLang").value).toBe("en");
    navigate("providerSettings");
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "SAVE_SETTINGS")).toHaveLength(0);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored).toMatchObject({
      sourceLang: "en", concurrency: 2,
      autoTranslation: { enabled: true, presetSites: ["github.com"] }
    }));
    expect(query<HTMLElement>("#providerSettings").hidden).toBe(false);
    expect(location.hash).toBe("#providerSettings");
  });

  it("opens nested PDF links and responds to history navigation", async () => {
    history.replaceState(null, "", "/options.html#pdfSettings");
    await mount();
    expect(query<HTMLElement>("#performanceSettings").hidden).toBe(false);
    navigate("autoTranslationSettings");
    history.back();
    await vi.waitFor(() => {
      expect(location.hash).toBe("#pdfSettings");
      expect(query<HTMLElement>("#performanceSettings").hidden).toBe(false);
    });
    history.forward();
    await vi.waitFor(() => expect(query<HTMLElement>("#autoTranslationSettings").hidden).toBe(false));
  });

  it("saves exclusion drafts and reveals an invalid selector from another category", async () => {
    await mount(); navigate("elementExclusionSettings");
    query<HTMLTextAreaElement>('[data-field="selectors"]').value = "div..invalid";
    navigate("generalSettings"); query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("CSS 选择器无效"));
    expect(query<HTMLElement>("#elementExclusionSettings").hidden).toBe(false);
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    const field = query<HTMLTextAreaElement>('[data-field="selectors"]');
    expect(document.activeElement).toBe(field);
    expect(query<HTMLElement>(".exclusion-rule-details").hidden).toBe(false);
    field.value = 'header[role="banner"]';
    query<HTMLInputElement>('.exclusion-rule input[type="checkbox"]').checked = false;
    navigate("providerSettings"); query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.elementExclusions?.[0]).toMatchObject({ pattern: "x.com", enabled: false }));
  });

  it("retains shortcut drafts across categories, saves them in-page and reloads them", async () => {
    await mount(); navigate("shortcutSettings");
    const input = query<HTMLInputElement>("[data-command='toggle-page-translation']");
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true, cancelable: true }));
    query<HTMLButtonElement>("[data-shortcut-toggle='toggle-page-translation']").click();
    navigate("generalSettings"); navigate("shortcutSettings");
    expect(input.value).toBe("Shift＋/");
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.shortcuts?.["toggle-page-translation"]).toBe("Shift+Slash"));
    expect(stored.shortcutEnabled?.["toggle-page-translation"]).toBe(false);
    expect(location.hash).toBe("#shortcutSettings");
    expect(document.querySelector("#manageShortcuts")).toBeNull();
  });

  it("reveals and focuses an invalid site rule when saving another category", async () => {
    await mount();
    navigate("autoTranslationSettings");
    query<HTMLButtonElement>("#addAutoTranslateSite").click();
    const draft = query<HTMLInputElement>(".auto-site-row:nth-last-child(2) .auto-site-pattern");
    draft.value = "https://";
    navigate("performanceSettings");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query("#status").textContent).toContain("请修改"));
    expect(query<HTMLElement>("#autoTranslationSettings").hidden).toBe(false);
    expect(document.activeElement).toBe(draft);
    expect(draft.getAttribute("aria-invalid")).toBe("true");
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
  });

  it("keeps image translation setup notices in the general category", async () => {
    history.replaceState(null, "", "/options.html?imageTranslationNotice=setup#providerSettings");
    await mount();
    expect(query<HTMLElement>("#generalSettings").hidden).toBe(false);
    expect(query("#status").textContent).toContain("安装 OCR 模型");
  });

  it("opens the OCR deep link in the services page with separate text and OCR sections", async () => {
    history.replaceState(null, "", "/options.html#ocrServiceSettings");
    await mount();
    expect(query<HTMLElement>("#providerSettings").hidden).toBe(false);
    expect(query("#generalSettings").contains(query("#ocrBackend"))).toBe(false);
    expect(query("#providerSettings").contains(query("#ocrBackend"))).toBe(true);
    expect([...document.querySelectorAll("#providerSettings > .service-settings-card h2")].map(title => title.textContent))
      .toEqual(["文本翻译服务", "OCR 翻译服务"]);
  });

  it("reveals the OCR service card from the image translation configuration button", async () => {
    stored.ocr = { mode: "http", endpoint: "https://ocr.example/v1/ocr", model: "my-ocr", apiKey: "private", modelRevision: "1" };
    await mount();
    query<HTMLButtonElement>("#ocrModelAction").click();
    expect(query<HTMLElement>("#providerSettings").hidden).toBe(false);
    expect(document.activeElement).toBe(query("#ocrServiceEndpoint"));
  });

  it("preserves OCR drafts and credentials when restoring general settings and saving", async () => {
    stored.ocr = { mode: "http", endpoint: "https://ocr.example/v1/ocr", model: "my-ocr", apiKey: "private", modelRevision: "1" };
    await mount(); navigate("providerSettings");
    query<HTMLInputElement>("#ocrServiceModel").value = "draft-model";
    navigate("generalSettings"); query<HTMLButtonElement>("#restorePageDefaults").click();
    expect(query<HTMLInputElement>("#ocrServiceModel").value).toBe("draft-model");
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.ocr).toMatchObject({ model: "draft-model", apiKey: "private", mode: "http" }));
  });

  it("reveals an invalid OCR draft when saving from another category", async () => {
    stored.ocr = { mode: "http", endpoint: "https://ocr.example/v1/ocr", model: "my-ocr", apiKey: "", modelRevision: "1" };
    await mount();
    query<HTMLInputElement>("#ocrServiceEndpoint").value = "invalid";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#providerSettings").hidden).toBe(false));
    expect(document.activeElement).toBe(query("#ocrServiceEndpoint"));
    expect(sendMessage.mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
  });

  it("falls back to general settings for an unknown category", async () => {
    history.replaceState(null, "", "/options.html#missing-category");
    await mount();
    expect(query<HTMLElement>("#generalSettings").hidden).toBe(false);
    expect(document.querySelector(".settings-nav [aria-current='page']")?.getAttribute("aria-controls")).toBe("generalSettings");
  });
});

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
