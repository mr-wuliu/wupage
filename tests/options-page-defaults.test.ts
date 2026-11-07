// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { mergeSettingsChanges } from "../src/shared/settings-changes";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

let stored: ExtensionSettings;
const send = vi.fn();
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const navigate = (id: string) => query<HTMLAnchorElement>(`.settings-nav a[aria-controls='${id}']`).click();
const restore = () => query<HTMLButtonElement>("#restorePageDefaults").click();
const writes = () => send.mock.calls.filter(([request]) => ["SAVE_SETTINGS", "RESET_SETTINGS", "CLEAR_STATISTICS"].includes(request.type));

beforeEach(async () => {
  vi.resetModules(); history.replaceState(null, "", "/options.html");
  document.open(); document.write(readFileSync("options.html", "utf8")); document.close();
  stored = normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), activeProviderId: "deepseek",
    sourceLang: "en", targetLang: "ja", cacheEnabled: false, floatingBallEnabled: false, translateCodeComments: false,
    translationDisplayMode: "replace", frameTranslation: { enabled: false, excludeMatches: ["example.com"] },
    selectionTranslation: { enabled: true, provider: "bing", style: "underline" },
    autoTranslation: { enabled: true, nonTargetLanguage: true, presetSites: ["github.com"], customSites: [] },
    elementExclusions: [{ id: "private-rule", enabled: true, pattern: "example.com", selectors: [".sidebar"] }],
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, "toggle-page-translation": "Alt+Shift+J" },
    localShortcuts: { ...DEFAULT_SETTINGS.localShortcuts, "paragraph-click": "Alt" },
    shortcutEnabled: { ...DEFAULT_SETTINGS.shortcutEnabled, "translate-selection": false },
    appearance: { ...DEFAULT_SETTINGS.appearance, mode: "dark" }, statisticsEnabled: true,
    chunkSize: 2200, concurrency: 6, pdfTranslationPageRadius: null, contextMenuTranslationEnabled: true });
  Object.assign(stored.providers.find(provider => provider.id === "deepseek")!, {
    apiKey: "private-key", baseURL: "https://private.example/v1", systemPrompt: "Private prompt",
    performanceMode: "custom", chunkSize: 2400, concurrency: 5 });
  Object.assign(stored.providers.find(provider => provider.id === "zhipu-glm")!, {
    apiKey: "other-private-key", baseURL: "https://other.example/v1" });
  stored.providers.push({ type: "http-template", id: "custom-private", label: "Private service", method: "POST",
    url: "https://example.com?token=private", headers: { Authorization: "private-header" }, bodyTemplate: "{{texts}}",
    responsePath: "translations", performanceMode: "custom", chunkSize: 2300, concurrency: 4 });
  stored = normalizeSettings(stored);
  send.mockReset().mockImplementation(async (request: RuntimeRequest) => {
    if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
    if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "missing", total: 100, downloaded: 0 } };
    if (request.type === "GET_STATISTICS") return { ok: true, data: { version: 1, days: [] } };
    if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.previousSettings
      ? mergeSettingsChanges(stored, request.settings, request.previousSettings) : request.settings);
    return { ok: true, data: null };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  await import("../src/options/index");
  await vi.waitFor(() => expect(query("#providerTriggerLabel").textContent).toBe("DeepSeek"));
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.documentElement.removeAttribute("style"); document.documentElement.replaceChildren();
});

async function save(): Promise<void> {
  query<HTMLButtonElement>("#save").click();
  await vi.waitFor(() => expect(query("#status").textContent).toBe("已保存。"));
}

it.each<[string, (keyof ExtensionSettings)[]]>([
  ["generalSettings", ["sourceLang", "targetLang", "translationDisplayMode", "imageTranslationEnabled", "cacheEnabled", "floatingBallEnabled", "translateCodeComments", "frameTranslation"]],
  ["selectionTranslationSettings", ["selectionTranslation"]],
  ["autoTranslationSettings", ["autoTranslation"]],
  ["elementExclusionSettings", ["elementExclusions"]],
  ["shortcutSettings", ["shortcuts", "localShortcuts", "shortcutEnabled"]],
  ["appearanceSettings", ["appearance"]],
  ["statisticsSettings", ["statisticsEnabled"]]
])("restores only %s, waits for save and leaves all other settings and credentials intact", async (panel, keys) => {
  const before = structuredClone(stored);
  navigate(panel); restore();
  expect(writes()).toHaveLength(0); expect(stored).toEqual(before);
  expect(query("#status").textContent).toContain("保存后生效");
  await save();
  const expected = { ...before, ...Object.fromEntries(keys.map(key => [key, structuredClone(DEFAULT_SETTINGS[key])])) };
  expect(stored).toEqual(normalizeSettings(expected));
  expect(document.querySelector("#shortcutSettings #resetShortcuts")).toBeNull();
});

it("keeps invalid drafts on other pages untouched and does not validate them during a local reset", () => {
  navigate("elementExclusionSettings");
  const invalid = query<HTMLTextAreaElement>("[data-field='selectors']"); invalid.value = "div..invalid";
  query<HTMLInputElement>("#chunkSize").value = "1777";
  query<HTMLInputElement>("#providerForm [data-field='apiKey']").value = "unsaved-key";
  navigate("generalSettings"); restore();
  expect(invalid.value).toBe("div..invalid");
  expect(query<HTMLInputElement>("#chunkSize").value).toBe("1777");
  expect(query<HTMLInputElement>("#providerForm [data-field='apiKey']").value).toBe("unsaved-key");
  expect(query(".settings-panel:not([hidden])").id).toBe("generalSettings");
  expect(writes()).toHaveLength(0);
});

it("restores built-in service parameters while keeping dirty keys, custom requests and performance drafts", async () => {
  const deepseekDefaults = DEFAULT_SETTINGS.providers.find(provider => provider.type === "deepseek")!;
  const custom = structuredClone(stored.providers.find(provider => provider.id === "custom-private"));
  const otherPages = { ...structuredClone(stored), providers: [] };
  query<HTMLInputElement>("#providerForm [data-field='apiKey']").value = "unsaved-private-key";
  query<HTMLInputElement>("#providerPerformance [data-field='chunkSize']").value = "1800";
  navigate("providerSettings"); restore();
  expect(query<HTMLInputElement>("#providerForm [data-field='apiKey']").value).toBe("unsaved-private-key");
  expect(query<HTMLInputElement>("#providerPerformance [data-field='chunkSize']").value).toBe("1800");
  expect(writes()).toHaveLength(0);
  await save();
  expect(stored.providers.find(provider => provider.id === "deepseek")).toMatchObject({
    apiKey: "unsaved-private-key", baseURL: "https://api.deepseek.com", chunkSize: 1800, concurrency: 5,
    systemPrompt: deepseekDefaults.systemPrompt });
  expect(stored.providers.find(provider => provider.id === "zhipu-glm")).toMatchObject({
    apiKey: "other-private-key", baseURL: "https://open.bigmodel.cn/api/paas/v4" });
  expect(stored.providers.find(provider => provider.id === "custom-private")).toEqual(custom);
  expect({ ...stored, providers: [] }).toEqual(otherPages);
});

it("restores global and per-provider performance without replacing provider edits or other drafts", async () => {
  const before = structuredClone(stored);
  query<HTMLInputElement>("#providerForm [data-field='apiKey']").value = "dirty-key";
  query<HTMLInputElement>("#providerForm [data-field='baseURL']").value = "https://draft.example/v1";
  query<HTMLSelectElement>("#targetLang").value = "fr";
  navigate("performanceSettings"); restore();
  expect(writes()).toHaveLength(0);
  expect(query<HTMLInputElement>("#providerForm [data-field='baseURL']").value).toBe("https://draft.example/v1");
  await save();
  expect(stored).toMatchObject({ chunkSize: 1200, concurrency: 5, pdfTranslationPageRadius: 5, targetLang: "fr",
    appearance: before.appearance, autoTranslation: before.autoTranslation, shortcuts: before.shortcuts });
  expect(stored.providers.find(provider => provider.id === "deepseek")).toMatchObject({
    apiKey: "dirty-key", baseURL: "https://draft.example/v1", performanceMode: "custom", chunkSize: 3200, concurrency: 5 });
  expect(stored.providers.find(provider => provider.id === "custom-private")).toMatchObject({
    url: "https://example.com?token=private", headers: { Authorization: "private-header" }, performanceMode: "inherit" });
});

it("does not offer a scoped reset on backup and does not write when invoked there", () => {
  navigate("backupSettings"); restore();
  expect(writes()).toHaveLength(0);
  expect(query("#status").textContent).toBe("");
});

it("preserves an external key update while saving restored parameters", async () => {
  Object.assign(stored.providers.find(provider => provider.id === "deepseek")!, { apiKey: "externally-updated-key" });
  navigate("providerSettings"); restore(); await save();
  expect(stored.providers.find(provider => provider.id === "deepseek")).toMatchObject({
    apiKey: "externally-updated-key", baseURL: "https://api.deepseek.com" });
});

it("keeps an unfinished HTTP request intact when restoring other service parameters", async () => {
  query<HTMLButtonElement>("[data-action='select'][data-provider-id='http-template']").click();
  await vi.waitFor(() => expect(query("#providerForm").dataset.providerId).toBe("http-template"));
  const headers = query<HTMLTextAreaElement>("#providerForm [data-field='headers']"); headers.value = "unfinished private headers";
  const count = writes().length;
  navigate("providerSettings"); restore();
  expect(headers.isConnected).toBe(true); expect(headers.value).toBe("unfinished private headers");
  expect(writes()).toHaveLength(count);
  expect(query(".settings-panel:not([hidden])").id).toBe("providerSettings");
});
