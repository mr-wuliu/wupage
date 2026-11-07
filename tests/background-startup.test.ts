import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock("../src/ocr/model-store"); });

describe("background startup compatibility", () => {
  it("keeps ordinary settings and translation available when the OCR cache cannot be checked", async () => {
    vi.doMock("../src/ocr/model-store", async () => ({ ...await vi.importActual("../src/ocr/model-store"),
      installedRevision: vi.fn().mockRejectedValue(new Error("Cache unavailable")) }));
    const stored = { [SETTINGS_KEY]: { ...structuredClone(DEFAULT_SETTINGS), imageTranslationEnabled: true } };
    const addListener = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener }, onConnect: { addListener: vi.fn() } }, storage: { local: {
      get: async () => structuredClone(stored), set: vi.fn()
    } } });
    await import("../src/background/index");
    const response = await new Promise<RuntimeResponse>(resolve => addListener.mock.calls[0][0]({ type: "GET_SETTINGS" }, {}, resolve));
    expect(response).toMatchObject({ ok: true, data: { imageTranslationEnabled: true, targetLang: "zh-CN" } });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    const saved = await new Promise<RuntimeResponse>(resolve => addListener.mock.calls[0][0]({
      type: "SAVE_SETTINGS", settings: { ...stored[SETTINGS_KEY], targetLang: "ja" }
    }, {}, resolve));
    expect(saved.ok).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
      [SETTINGS_KEY]: expect.objectContaining({ targetLang: "ja", imageTranslationEnabled: true })
    }));
  });
  it.each(["installed", undefined])("keeps changes saved during an OCR model check (%s)", async (modelRevision) => {
    let finish!: (revision: string | undefined) => void;
    const check = vi.fn(() => new Promise<string | undefined>(resolve => { finish = resolve; }));
    vi.doMock("../src/ocr/model-store", async () => ({ ...await vi.importActual("../src/ocr/model-store"), installedRevision: check }));
    const stored: Record<string, unknown> = { [SETTINGS_KEY]: { ...structuredClone(DEFAULT_SETTINGS), imageTranslationEnabled: true } };
    const addListener = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener }, onConnect: { addListener: vi.fn() } }, storage: { local: {
      get: async () => structuredClone(stored),
      set: async (value: Record<string, unknown>) => { Object.assign(stored, structuredClone(value)); }
    } } });
    await import("../src/background/index");
    const response = new Promise<RuntimeResponse>(resolve => addListener.mock.calls[0][0]({ type: "GET_SETTINGS" }, {}, resolve));
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    stored[SETTINGS_KEY] = { ...stored[SETTINGS_KEY] as ExtensionSettings, targetLang: "ja",
      autoTranslation: { enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] } };
    finish(modelRevision);
    expect(await response).toMatchObject({ ok: true, data: { targetLang: "ja", autoTranslation: { enabled: true }, imageTranslationEnabled: Boolean(modelRevision) } });
    expect(stored[SETTINGS_KEY]).toMatchObject({ targetLang: "ja", autoTranslation: { enabled: true }, imageTranslationEnabled: Boolean(modelRevision) });
  });

  it("allows explicitly testing a disabled service while rejecting ordinary translation requests to it", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.providers.find(provider => provider.id === "openai-compatible")!, {
      enabled: false, ollamaCompatibility: false, baseURL: "https://example.com/v1", apiKey: "test-key"
    });
    const stored: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const addListener = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '["你好"]' } }] })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: { onMessage: { addListener }, onConnect: { addListener: vi.fn() } },
      storage: { local: { get: async () => stored, set: async (value: Record<string, unknown>) => { Object.assign(stored, value); } } }
    });
    await import("../src/background/index");
    const receive = addListener.mock.calls[0][0];
    const send = (request: RuntimeRequest): Promise<RuntimeResponse> => new Promise(resolve => receive(request, {}, resolve));
    expect(await send({ type: "TEST_PROVIDER", providerId: "openai-compatible" })).toEqual({ ok: true, data: { translation: "你好" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stored[SETTINGS_KEY]).toMatchObject({ activeProviderId: settings.activeProviderId });
    expect((stored[SETTINGS_KEY] as ExtensionSettings).providers.find(provider => provider.id === "openai-compatible")!.enabled).toBe(false);
    expect(await send({ type: "TRANSLATE_BATCH", providerId: "openai-compatible", texts: ["Hello"], targetLang: "zh-CN" }))
      .toMatchObject({ ok: false, error: "翻译服务已停用：openai-compatible" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["callback-only", "missing-menu", "throwing-menu"])("reads and saves settings with %s context menu APIs", async (mode) => {
    const stored: Record<string, unknown> = {};
    const addListener = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = vi.fn();
    const runtime = { onMessage: { addListener }, onConnect: { addListener: vi.fn() }, lastError: undefined as { message: string } | undefined };
    vi.stubGlobal("chrome", {
      runtime,
      tabs: { query: async () => [] },
      storage: { local: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); })
      } },
      contextMenus: mode === "missing-menu" ? undefined : {
        remove: (_id: string, callback: () => void) => callback(),
        update: (_id: string, _properties: unknown, callback?: () => void) => {
          if (mode === "throwing-menu") throw new Error("Menu API unavailable");
          // Chromium before 123 returns undefined and reports errors via callback.
          runtime.lastError = { message: "Menu does not exist" };
          callback?.();
          runtime.lastError = undefined;
        },
        create,
        onClicked: { addListener: vi.fn() }
      }
    });
    await import("../src/background/index");
    expect(addListener).toHaveBeenCalled();
    const receive = addListener.mock.calls[0][0];
    const send = (request: RuntimeRequest): Promise<RuntimeResponse> => new Promise(resolve => {
      expect(receive(request, {}, resolve)).toBe(true);
    });
    const response = await send({ type: "GET_SETTINGS" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const settings = response.data as ExtensionSettings;
    expect(settings.providers.length).toBeGreaterThan(0);
    expect(settings.targetLang).toBe("zh-CN");
    const changed = { ...settings, targetLang: "ja", chunkSize: 800 };
    expect((await send({ type: "SAVE_SETTINGS", settings: changed })).ok).toBe(true);
    expect(stored[SETTINGS_KEY]).toMatchObject({ targetLang: "ja", chunkSize: 800 });
    const saved = await send({ type: "GET_SETTINGS" });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.data).toMatchObject({ targetLang: "ja", chunkSize: 800 });
    if (mode === "callback-only") {
      expect(create).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalled();
    } else expect(warning).toHaveBeenCalled();
  });
});
