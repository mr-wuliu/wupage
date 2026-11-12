import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { DEFAULT_OCR_SETTINGS } from "../src/shared/ocr-service";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup } from "../src/shared/settings-backup";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

const ocr = { ...DEFAULT_OCR_SETTINGS, mode: "http" as const, endpoint: "https://ocr.example/v1/ocr", model: "my-model", apiKey: "secret-api-key" };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock("../src/ocr/model-store"); });

describe("OCR service settings", () => {
  it("round-trips full backups and removes credentials from ordinary backups", () => {
    const settings = { ...DEFAULT_SETTINGS, ocr: { ...ocr, endpoint: ocr.endpoint + "?apiKey=secret-query&language=en" } };
    const backup = createSettingsBackup(settings, "1.20.0");
    expect(backup.settings.ocr).toMatchObject({ apiKey: "", endpoint: ocr.endpoint + "?apiKey=&language=en", model: ocr.model });
    expect(parseSettingsBackup(serializeSettingsBackup(backup)).settings.ocr).toEqual(backup.settings.ocr);
    const full = createSettingsBackup(settings, "1.20.0", undefined, { includeKeys: true });
    expect(parseSettingsBackup(serializeSettingsBackup(full)).settings.ocr).toEqual(settings.ocr);
    expect(() => parseSettingsBackup(serializeSettingsBackup({ ...full, includesKeys: false }))).toThrow();
  });
  it("saves, reloads, and imports HTTP settings without installed local models; rejects invalid service changes", async () => {
    vi.doMock("../src/ocr/model-store", () => ({ installedRevision: vi.fn(async () => undefined) }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let stored: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
    const listeners: Array<(request: RuntimeRequest, sender: chrome.runtime.MessageSender, response: (value: RuntimeResponse) => void) => void> = [];
    vi.stubGlobal("chrome", { runtime: {
      id: "test", getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) }, onConnect: { addListener: vi.fn() }
    }, storage: { local: { get: async () => ({ [SETTINGS_KEY]: stored }),
      set: async (value: Record<string, ExtensionSettings>) => { stored = structuredClone(value[SETTINGS_KEY]); } } } });
    await import("../src/background/index");
    const request = async (message: RuntimeRequest, sender = {}): Promise<RuntimeResponse> =>
      new Promise(resolve => listeners[0](message, sender, resolve));
    const enabled = { ...stored, imageTranslationEnabled: true, ocr };
    expect((await request({ type: "SAVE_SETTINGS", settings: enabled })).ok).toBe(true);
    expect(await request({ type: "GET_SETTINGS" })).toMatchObject({ ok: true, data: { imageTranslationEnabled: true, ocr } });
    expect(await request({ type: "GET_OCR_STATUS" })).toMatchObject({ ok: true, data: { backend: "http", state: "installed" } });
    const full = serializeSettingsBackup(createSettingsBackup(enabled, "1.20.0", undefined, { includeKeys: true }));
    expect(await request({ type: "IMPORT_SETTINGS", backup: full })).toMatchObject({ ok: true, data: { imageTranslationDisabled: false, settings: { imageTranslationEnabled: true } } });
    expect((await request({ type: "SAVE_SETTINGS", settings: { ...enabled, ocr: { ...ocr, endpoint: "file:///bad" } } })).ok).toBe(false);
    expect(stored.ocr?.endpoint).toBe(ocr.endpoint);
    expect((await request({ type: "SAVE_SETTINGS", settings: { ...enabled, ocr: DEFAULT_OCR_SETTINGS } })).ok).toBe(false);
    const message: RuntimeRequest = { type: "TEST_OCR_SERVICE", requestId: "test", config: ocr,
      image: { dataUrl: "data:image/png;base64,aGVsbG8=", width: 640, height: 160 } };
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await request(message, { id: "test", url: "https://example.com/", tab: { id: 1 } })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, coordinateSpace: "pixel", width: 640, height: 160, lines: [] }));
    expect((await request(message, { id: "test", url: "chrome-extension://test/options.html", tab: { id: 2 } })).ok).toBe(true);
  });
});
