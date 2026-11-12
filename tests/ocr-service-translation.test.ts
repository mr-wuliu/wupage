import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { DEFAULT_OCR_SETTINGS } from "../src/shared/ocr-service";
import { recognizeImage } from "../src/background/ocr";
import { ocrRevision } from "../src/background/ocr-service";
import { translateImageWithSettings } from "../src/background/image-translation";
import { translateWithSettings } from "../src/background/translation";
import type { ExtensionSettings } from "../src/shared/types";

vi.mock("../src/background/ocr", () => ({ recognizeImage: vi.fn() }));
vi.mock("../src/background/translation", () => ({ translateWithSettings: vi.fn() }));
const image = { dataUrl: "data:image/png;base64,aGVsbG8=", width: 640, height: 160 };
const base = { ...DEFAULT_SETTINGS, imageTranslationEnabled: true, cacheEnabled: true,
  ocr: { ...DEFAULT_OCR_SETTINGS, mode: "http" as const, endpoint: "https://ocr.example/recognize", model: "my-ocr" } };
let current: ExtensionSettings;
let stored: Record<string, unknown>;
beforeEach(async () => {
  vi.resetAllMocks(); current = structuredClone(base); stored = {};
  vi.stubGlobal("chrome", { storage: { local: {
    get: async (key: string) => key === SETTINGS_KEY ? { [key]: current } : { [key]: stored[key] },
    set: async (value: Record<string, unknown>) => { Object.assign(stored, value); }
  } } });
  vi.mocked(recognizeImage).mockImplementation(async (_url, settings) => ({ revision: (await ocrRevision(settings))!,
    lines: [{ text: "Hello OCR", poly: [[10, 10], [200, 10], [200, 70], [10, 70]] }] }));
  vi.mocked(translateWithSettings).mockResolvedValue({ translations: ["你好 OCR"], cached: 0 });
});
afterEach(() => vi.unstubAllGlobals());

it("translates HTTP geometry without local models and reuses only the same backend cache version", async () => {
  const first = await translateImageWithSettings(current, image);
  expect(first.regions[0].translation).toBe("你好 OCR");
  expect((await translateImageWithSettings(current, image)).cached).toBe(true);
  current = { ...current, ocr: { ...base.ocr, modelRevision: "2" } };
  expect((await translateImageWithSettings(current, image)).cached).toBe(false);
  expect(recognizeImage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(translateWithSettings).mock.calls)).not.toContain("base64");
  expect(JSON.stringify(stored)).not.toContain("base64");
});

it("discards results from a changed service before sending text to the translation provider", async () => {
  const recognize = vi.mocked(recognizeImage).getMockImplementation()!;
  vi.mocked(recognizeImage).mockImplementation(async (...args) => {
    const result = await recognize(...args);
    current = { ...current, ocr: { ...base.ocr, endpoint: "https://changed.example/ocr" } };
    return result;
  });
  await expect(translateImageWithSettings(current, image)).rejects.toThrow("已更改");
  expect(translateWithSettings).not.toHaveBeenCalled(); expect(stored).toEqual({});
});

it("does not cache a translation completed after OCR was disabled", async () => {
  vi.mocked(translateWithSettings).mockImplementation(async () => {
    current = { ...current, imageTranslationEnabled: false };
    return { translations: ["你好"], cached: 0 };
  });
  await expect(translateImageWithSettings(current, image)).rejects.toThrow("关闭");
  expect(stored).toEqual({});
});

it("rejects a cached result if its OCR profile has been superseded", async () => {
  await translateImageWithSettings(current, image);
  const previous = current;
  current = { ...current, ocr: { ...base.ocr, modelRevision: "changed" } };
  await expect(translateImageWithSettings(previous, image)).rejects.toThrow("已更改");
  expect(recognizeImage).toHaveBeenCalledTimes(1);
});
