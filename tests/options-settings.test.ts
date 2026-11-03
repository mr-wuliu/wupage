// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { mergeSettingsChanges } from "../src/shared/settings-changes";
import { normalizeVideoTranslation } from "../src/shared/video";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); vi.resetModules(); document.documentElement.replaceChildren(); });

it.each(["switch", "test"])("preserves external settings across a service %s and another save", async action => {
  document.open(); document.write(readFileSync("options.html", "utf8")); document.close();
  let stored: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
  stored.activeProviderId = "deepseek";
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: async (request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
      if (request.type === "SAVE_SETTINGS") {
        stored = normalizeSettings(request.previousSettings
          ? mergeSettingsChanges(stored, request.settings, request.previousSettings) : request.settings);
        return { ok: true };
      }
      if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "missing", downloaded: 0, total: 100 } };
      if (request.type === "TEST_PROVIDER") return { ok: true, data: { translation: "成功" } };
      return { ok: true };
    } },
    storage: { onChanged: { addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.add(listener), removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.delete(listener) } }
  });
  await import("../src/options/index");
  await vi.waitFor(() => expect(document.querySelector("#providerForm")?.getAttribute("data-provider-id")).toBe("deepseek"));
  document.querySelector<HTMLInputElement>("#cacheEnabled")!.checked = false;
  stored = { ...stored, targetLang: "fr", videoTranslation: normalizeVideoTranslation({ enabled: false }) };
  const provider = stored.providers.find(provider => provider.type === "deepseek")!;
  if (provider.type === "deepseek") provider.apiKey = "externally-updated-key";
  for (const listener of listeners) listener({ [SETTINGS_KEY]: { newValue: structuredClone(stored) } }, "local");
  if (action === "switch") {
    document.querySelector<HTMLButtonElement>("#providerTrigger")!.click();
    document.querySelector<HTMLButtonElement>('[data-action="select"][data-provider-id="google-web-translate"]')!.click();
  } else document.querySelector<HTMLButtonElement>("#test")!.click();
  await vi.waitFor(() => expect(document.querySelector("#status")?.textContent)
    .toBe(action === "switch" ? "已切换当前服务。" : "测试通过：成功"));
  expect(document.querySelector<HTMLSelectElement>("#targetLang")!.value).toBe("fr");
  document.querySelector<HTMLButtonElement>("#save")!.click();
  await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("已保存。"));
  expect(normalizeVideoTranslation(stored.videoTranslation).enabled).toBe(false);
  expect(stored).toMatchObject({ cacheEnabled: false, targetLang: "fr" });
  expect(stored.providers.find(provider => provider.id === "deepseek"))
    .toMatchObject({ apiKey: "externally-updated-key" });
});
