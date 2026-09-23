import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { installedRevision } from "../src/ocr/model-store";
import { recognizeImage } from "../src/background/ocr";
import { translateWithSettings } from "../src/background/translation";
import { translateImageWithSettings } from "../src/background/image-translation";
import { needsImageTranslation } from "../src/ocr/regions";

vi.mock("../src/ocr/model-store", () => ({ installedRevision: vi.fn() }));
vi.mock("../src/background/ocr", () => ({ recognizeImage: vi.fn() }));
vi.mock("../src/background/translation", () => ({ translateWithSettings: vi.fn() }));
const request = { dataUrl: "data:image/png;base64,aGVsbG8=", width: 1000, height: 500 };
const settings = { ...DEFAULT_SETTINGS, imageTranslationEnabled: true, cacheEnabled: true };
let stored: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  stored = {};
  vi.stubGlobal("chrome", { storage: { local: { get: async (key: string) => ({ [key]: stored[key] }), set: async (value: object) => Object.assign(stored, value) } } });
  vi.mocked(installedRevision).mockResolvedValue("v1");
  vi.mocked(recognizeImage).mockResolvedValue({ revision: "v1", lines: [
    { text: "Cache performance", score: .99, poly: [[100,100],[300,100],[300,125],[100,125]] },
    { text: "41.7%", score: .99, poly: [[100,150],[200,150],[200,175],[100,175]] },
    { text: "uncertain", score: .1, poly: [[100,200],[200,200],[200,225],[100,225]] }
  ] });
  vi.mocked(translateWithSettings).mockResolvedValue({ translations: ["缓存性能"], cached: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe("local OCR image translation", () => {
  it("translates only OCR text with fixed positions, including with a text-only provider", async () => {
    const result = await translateImageWithSettings(settings, request);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({ text: "Cache performance", translation: "缓存性能", box: [99,198,202,54], sampleColors: true });
    expect(translateWithSettings).toHaveBeenCalledWith(settings, expect.objectContaining({ texts: ["Cache performance"] }));
    expect(JSON.stringify(vi.mocked(translateWithSettings).mock.calls)).not.toContain("base64");
  });
  it("requires installed models and enabled mode before recognizing or calling a provider", async () => {
    await expect(translateImageWithSettings({ ...settings, imageTranslationEnabled: false }, request)).rejects.toThrow("开启");
    vi.mocked(installedRevision).mockResolvedValue(undefined);
    await expect(translateImageWithSettings(settings, request)).rejects.toThrow("扳手");
    expect(recognizeImage).not.toHaveBeenCalled();
    expect(translateWithSettings).not.toHaveBeenCalled();
  });
  it("uses cached geometry and invalidates it when language or model installation changes", async () => {
    await translateImageWithSettings(settings, request);
    const cached = await translateImageWithSettings(settings, request);
    expect(cached.cached).toBe(true);
    expect(cached.regions[0].sampleColors).toBe(true);
    await translateImageWithSettings({ ...settings, targetLang: "ja" }, request);
    expect(recognizeImage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(stored)).not.toContain("base64");
  });
  it("does not cover unchanged translations or send purely numeric labels", async () => {
    vi.mocked(translateWithSettings).mockResolvedValue({ translations: ["Cache performance"], cached: 0 });
    expect((await translateImageWithSettings(settings, request)).regions).toEqual([]);
    for (const value of ["41.7%", "0.91x", "1.3T", "100%", "320B", "2026", "−20%"])
      expect(needsImageTranslation(value), value).toBe(false);
    expect(needsImageTranslation("2 projects")).toBe(true);
    expect(needsImageTranslation("API keys")).toBe(true);
  });
  it("discards a translation completed after model removal", async () => {
    vi.mocked(installedRevision).mockResolvedValueOnce("v1").mockResolvedValue(undefined);
    await expect(translateImageWithSettings(settings, request)).rejects.toThrow("已删除");
    expect(Object.keys(stored)).toHaveLength(0);
  });
  it("rejects malformed image sizes before recognizing", async () => {
    await expect(translateImageWithSettings(settings, { ...request, width: -1 })).rejects.toThrow("尺寸");
    expect(recognizeImage).not.toHaveBeenCalled();
  });
});
