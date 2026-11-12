import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { DEFAULT_OCR_SETTINGS, normalizeOcrSettings, validateOcrService } from "../src/shared/ocr-service";
import { cancelOcrTest, initOcrService, ocrRevision, parseOcrServiceResult, recognizeOcrService, testOcrService } from "../src/background/ocr-service";
import { getOcrStatus, recognizeImage } from "../src/background/ocr";
import { positionedLines } from "../src/ocr/regions";

const config = { ...DEFAULT_OCR_SETTINGS, mode: "http" as const, endpoint: "http://127.0.0.1:8000/v1/ocr", model: "my-ocr", apiKey: "example-secret" };
const image = { dataUrl: "data:image/png;base64,aGVsbG8=", width: 640, height: 160 };
const line = { text: "Hello OCR 123", poly: [[32, 50], [360, 50], [360, 100], [32, 100]] };
const result = () => ({ schemaVersion: 1, coordinateSpace: "pixel", width: 640, height: 160, lines: [structuredClone(line)] });
let fetchMock: ReturnType<typeof vi.fn>;
const storage = () => ({ local: { get: async () => ({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, imageTranslationEnabled: true, ocr: config } }) } });
beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json(result())); vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", { storage: storage() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("custom OCR protocol", () => {
  it("uses the exact configured endpoint, model, and bearer key without cookies or redirects", async () => {
    const recognized = await recognizeOcrService(config, image);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.endpoint);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Authorization: "Bearer example-secret" } });
    expect(JSON.parse(init.body as string)).toEqual({ schemaVersion: 1, model: "my-ocr", image });
    expect(recognized.lines).toEqual([line]);
    expect(recognized.revision).toBe(await ocrRevision({ ocr: config }));
    expect(recognized.revision).not.toContain(config.apiKey);
  });
  it("supports missing confidence without inventing a score, retaining the existing low-score filter", () => {
    const lines = parseOcrServiceResult(result(), image);
    expect(lines[0]).not.toHaveProperty("score");
    expect(positionedLines(lines, 640, 160)).toHaveLength(1);
    expect(positionedLines([{ ...lines[0], score: .1 }], 640, 160)).toEqual([]);
  });
  it.each([
    { schemaVersion: 2 }, { coordinateSpace: "normalized" }, { width: 320 }, { height: 320 }, { lines: "hello" },
    { lines: [{ ...line, text: "" }] }, { lines: [{ ...line, text: "x".repeat(4001) }] },
    { lines: [{ ...line, score: 50 }] }, { lines: [{ ...line, score: NaN }] }, { lines: [{ ...line, score: null }] },
    { lines: [{ ...line, poly: [[0, 0], [700, 0], [700, 10], [0, 10]] }] },
    { lines: [{ ...line, poly: [[0, 0], [10, 0], [20, 0], [30, 0]] }] },
    { lines: [{ ...line, poly: [[0, 0], [10, 0], [10, 10]] }] },
    { lines: Array.from({ length: 2001 }, () => line) }
  ])("rejects malformed geometry, confidence, or oversized results (%j)", patch => {
    expect(() => parseOcrServiceResult({ ...result(), ...patch }, image)).toThrow("协议");
  });
  it("accepts an empty detection result without a false success", () => {
    expect(parseOcrServiceResult({ ...result(), lines: [] }, image)).toEqual([]);
  });
  it("rejects HTML, malformed JSON, non-success HTTP, and oversized streamed responses", async () => {
    for (const response of [new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
      new Response("not json"), new Response("secret details", { status: 401 }), new Response("x".repeat(4 * 1024 * 1024 + 1))]) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(recognizeOcrService(config, image)).rejects.toThrow();
    }
  });
  it("rejects invalid endpoint schemes, embedded credentials, header injection, and invalid images before sending", async () => {
    for (const endpoint of ["", "file:///test", "https://user:pass@example.com/ocr", "https://example.com/ocr#fragment"]) {
      expect(() => validateOcrService({ ...config, endpoint })).toThrow();
    }
    await expect(recognizeOcrService({ ...config, apiKey: "bad\r\nHeader: value" }, image)).rejects.toThrow();
    await expect(recognizeOcrService(config, { ...image, width: -1 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("isolates caches by endpoint, model, cache version, and authentication", async () => {
    const revisions = await Promise.all([config, { ...config, endpoint: "https://other.example/ocr" },
      { ...config, model: "other" }, { ...config, modelRevision: "2" }, { ...config, apiKey: "other" }].map(ocr => ocrRevision({ ocr })));
    expect(new Set(revisions).size).toBe(5);
    expect(normalizeOcrSettings(undefined).mode).toBe("builtin");
  });
  it("routes HTTP recognition and status without loading offscreen or checking local models", async () => {
    const settings = { ...DEFAULT_SETTINGS, ocr: config };
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() }, storage: storage() });
    expect(await getOcrStatus(settings)).toMatchObject({ backend: "http", state: "installed" });
    expect(await getOcrStatus({ ...settings, ocr: { ...config, endpoint: "" } })).toMatchObject({ backend: "http", state: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await recognizeImage(image.dataUrl, settings, 640, 160)).lines).toEqual([line]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("aborts in-flight recognition when settings change or the feature is disabled", async () => {
    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    vi.stubGlobal("chrome", { storage: { ...storage(), onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } } });
    initOcrService();
    for (const settings of [{ ...DEFAULT_SETTINGS, imageTranslationEnabled: true, ocr: { ...config, model: "changed" } },
      { ...DEFAULT_SETTINGS, imageTranslationEnabled: false, ocr: config }]) {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }));
      const pending = recognizeOcrService(config, image);
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      changed({ [SETTINGS_KEY]: { newValue: settings } }, "local");
      await rejected; fetchMock.mockClear();
    }
  });
  it("cancels an explicit test and releases its request ID", async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const pending = testOcrService("test-1", config, image);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    cancelOcrTest("test-1"); await rejected;
    expect((await testOcrService("test-1", config, image)).lines).toEqual([line]);
  });
});
