import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

let stored: ExtensionSettings;
let receive: (request: RuntimeRequest, sender: object, respond: (response: RuntimeResponse) => void) => void;
async function request(message: RuntimeRequest): Promise<unknown> {
  const response = await new Promise<RuntimeResponse>(resolve => receive(message, {}, resolve));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

beforeEach(async () => {
  vi.resetModules();
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.doMock("../src/ocr/model-store", async () => ({
    ...await vi.importActual("../src/ocr/model-store"), installedRevision: async () => undefined
  }));
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: (listener: typeof receive) => { receive ??= listener; } } },
    storage: { local: {
      get: async () => ({ [SETTINGS_KEY]: structuredClone(stored) }),
      set: async (value: Record<string, ExtensionSettings>) => { await Promise.resolve(); stored = structuredClone(value[SETTINGS_KEY]); }
    } }
  });
  await import("../src/background/index");
});
afterEach(() => {
  receive = undefined!;
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock("../src/ocr/model-store");
});

describe("background settings writes", () => {
  it("serializes simultaneous changes from two pages without losing either edit", async () => {
    const previousSettings = await request({ type: "GET_SETTINGS" }) as ExtensionSettings;
    await Promise.all([
      request({ type: "SAVE_SETTINGS", previousSettings, settings: { ...previousSettings, targetLang: "ja" } }),
      request({ type: "SAVE_SETTINGS", previousSettings, settings: { ...previousSettings, cacheEnabled: false } })
    ]);
    expect(stored).toMatchObject({ targetLang: "ja", cacheEnabled: false });
  });

  it("continues saving after an invalid OCR opt-in fails", async () => {
    const previousSettings = await request({ type: "GET_SETTINGS" }) as ExtensionSettings;
    await expect(request({ type: "SAVE_SETTINGS", previousSettings,
      settings: { ...previousSettings, imageTranslationEnabled: true } })).rejects.toThrow("安装 OCR");
    await request({ type: "SAVE_SETTINGS", previousSettings, settings: { ...previousSettings, targetLang: "fr" } });
    expect(stored).toMatchObject({ targetLang: "fr", imageTranslationEnabled: false });
  });

  it("supports an explicit full reset without retaining the old configuration", async () => {
    stored.targetLang = "ja";
    stored.videoTranslation = { enabled: false, showOriginal: false, fontSize: 26, background: "none", preferredSource: "en", enabledSites: [] };
    await request({ type: "SAVE_SETTINGS", settings: structuredClone(DEFAULT_SETTINGS) });
    expect(stored.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    expect(stored.videoTranslation).toBeUndefined();
  });
});
