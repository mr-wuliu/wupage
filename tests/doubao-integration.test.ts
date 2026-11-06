import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { getTranslationDebugSnapshot, translateWithSettings } from "../src/background/translation";
import { TranslationResponseError } from "../src/background/translation-response";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { ProviderError } from "../src/shared/errors";
import type { ExtensionSettings, TranslateBatchRequest, TranslatorProvider } from "../src/shared/types";

vi.mock("../src/background/providers", () => ({ createProvider: vi.fn() }));

// Emulate a protocol revision across builds while retaining the actual deadline
// and browser helpers. Cached translations must not cross that revision.
const protocol = vi.hoisted(() => ({ version: 1 }));
vi.mock("../src/shared/doubao", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/shared/doubao")>();
  return { ...original, get DOUBAO_PROTOCOL_VERSION() { return protocol.version; } };
});

const translateBatch = vi.fn<TranslatorProvider["translateBatch"]>();
const detectLanguage = vi.fn();
let nextProviderId = 0;

function settings(cacheEnabled = false): ExtensionSettings {
  const id = `doubao-integration-${nextProviderId++}`;
  return {
    ...DEFAULT_SETTINGS,
    activeProviderId: id,
    cacheEnabled,
    providers: [{ type: "doubao-web", id, label: "Doubao integration" }]
  };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    return Object.fromEntries(keys.filter((item) => values.has(item)).map((item) => [item, values.get(item)]));
  });
  const set = vi.fn(async (entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) values.set(key, value);
  });
  vi.stubGlobal("chrome", { i18n: { detectLanguage }, storage: { local: { get, set } } });
  return { values, get, set };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

beforeEach(() => {
  protocol.version = 1;
  detectLanguage.mockReset();
  detectLanguage.mockResolvedValue({ languages: [{ language: "en", percentage: 95 }] });
  vi.stubGlobal("chrome", { i18n: { detectLanguage } });
  translateBatch.mockReset();
  translateBatch.mockImplementation(async (request) => request.texts.map((text) => `译文：${text}`));
  vi.mocked(createProvider).mockReset();
  vi.mocked(createProvider).mockImplementation((config) => ({
    id: config.id, label: config.label, translateBatch,
    validateConfig: () => ({ ok: true })
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Doubao integration with the common translation path", () => {
  it("translates individual paragraphs when only page-sized language samples can be detected", async () => {
    const config = settings();
    const texts = ["Read the guide.", "Continue to the next chapter.", "Check the installation instructions before starting."];
    detectLanguage.mockImplementation(async (sample: string) => ({
      languages: [{ language: sample.length >= 80 ? "en" : "und", percentage: sample.length >= 80 ? 95 : 0 }]
    }));
    expect((await translateWithSettings(config, { texts, sourceLang: "auto", targetLang: "zh-CN" })).translations)
      .toEqual(texts.map(text => `译文：${text}`));
    expect((await translateWithSettings(config, { texts: [texts[0]], sourceLang: "auto", targetLang: "zh-CN", preservePlaceholders: true })).translations)
      .toEqual([`译文：${texts[0]}`]);
  });

  it("preserves the selected source language and native arrays without mutating page requests", async () => {
    const config = settings();
    const request: TranslateBatchRequest = {
      texts: ["First paragraph", "Second paragraph"], sourceLang: "ja", targetLang: "zh-CN",
      context: "Private document context that Doubao does not accept"
    };
    translateBatch.mockResolvedValueOnce(["第一段", "第二段"]);

    await expect(translateWithSettings(config, request)).resolves.toEqual({
      translations: ["第一段", "第二段"], cached: 0
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    const [actual, signal] = translateBatch.mock.calls[0];
    expect(actual).toEqual({ ...request, context: undefined });
    expect(actual.texts).toEqual(["First paragraph", "Second paragraph"]);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(request.sourceLang).toBe("ja");
    expect(request.context).toContain("Private document context");
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("keeps automatic source requests in one cache without depending on browser detection", async () => {
    memoryStorage();
    const config = settings(true);
    const request: TranslateBatchRequest = {
      texts: ["Un paragraphe en français."], sourceLang: "auto", targetLang: "zh-CN"
    };
    detectLanguage.mockResolvedValueOnce({ languages: [{ language: "fr", percentage: 92 }] });

    expect((await translateWithSettings(config, request)).cached).toBe(0);
    expect(translateBatch).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: "auto" }), expect.any(AbortSignal));
    expect(request.sourceLang).toBe("auto");
    expect((await translateWithSettings(config, { ...request, sourceLang: undefined })).cached).toBe(1);
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(getTranslationDebugSnapshot().tasks.find((task) => task.providerId === config.activeProviderId)?.sourceLang).toBe("auto");
  });

  it("translates and caches a short paragraph even when the browser cannot identify its language", async () => {
    const storage = memoryStorage();
    const config = settings(true);
    detectLanguage.mockResolvedValueOnce({ languages: [{ language: "und", percentage: 0 }] });
    const request = { texts: ["A short label"], sourceLang: "auto", targetLang: "zh-CN" };

    await expect(translateWithSettings(config, request)).resolves.toEqual({ translations: ["译文：A short label"], cached: 0 });
    expect(storage.set).toHaveBeenCalledOnce();
    expect((await translateWithSettings(config, request)).cached).toBe(1);
    expect(translateBatch).toHaveBeenCalledOnce();
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("does not wait for a stalled browser detector before translating", async () => {
    const detection = deferred<{ languages: Array<{ language: string; percentage: number }> }>();
    detectLanguage.mockReturnValueOnce(detection.promise);
    await expect(translateWithSettings(settings(), { texts: ["Hello"], targetLang: "zh-CN" }))
      .resolves.toEqual({ translations: ["译文：Hello"], cached: 0 });
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(translateBatch).toHaveBeenCalledOnce();
  });

  it("supports automatic source translation when the browser language API is unavailable", async () => {
    vi.stubGlobal("chrome", {});
    await expect(translateWithSettings(settings(), { texts: ["Hello"], targetLang: "zh-CN" }))
      .resolves.toEqual({ translations: ["译文：Hello"], cached: 0 });
  });

  it("does not skip a mixed-language batch just because its dominant source matches the target", async () => {
    const texts = ["已经是中文的长段落。", "A shorter English paragraph."];
    detectLanguage.mockResolvedValueOnce({ languages: [{ language: "zh-CN", percentage: 70 }] });
    translateBatch.mockResolvedValueOnce([texts[0], "较短的英文段落。"]);

    expect((await translateWithSettings(settings(), { texts, sourceLang: "auto", targetLang: "zh-CN" })).translations)
      .toEqual([texts[0], "较短的英文段落。"]);
    expect(translateBatch).toHaveBeenCalledWith(expect.objectContaining({ texts, sourceLang: "auto" }), expect.any(AbortSignal));
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("does not detect empty input", async () => {
    await expect(translateWithSettings(settings(), { texts: [], targetLang: "zh-CN" }))
      .resolves.toEqual({ translations: [], cached: 0 });
    expect(detectLanguage).not.toHaveBeenCalled();
    expect(translateBatch).not.toHaveBeenCalled();
  });

  it("retains native item boundaries and order while limiting each batch to ten items", async () => {
    const texts = Array.from({ length: 23 }, (_, index) => `Paragraph ${index}`);
    const result = await translateWithSettings(settings(), {
      texts, targetLang: "zh-CN", context: "A page title"
    });

    expect(translateBatch.mock.calls.map(([request]) => request.texts.length)).toEqual([10, 10, 3]);
    expect(translateBatch.mock.calls.flatMap(([request]) => request.texts)).toEqual(texts);
    expect(result.translations).toEqual(texts.map((text) => `译文：${text}`));
  });

  it("separates source and target language caches while continuing to ignore unsupported page context", async () => {
    memoryStorage();
    const config = settings(true);
    const request = { texts: ["Hello"], targetLang: "zh-CN", sourceLang: "en", context: "Page A" };

    expect((await translateWithSettings(config, request)).cached).toBe(0);
    expect((await translateWithSettings(config, { ...request, sourceLang: "de", context: "Page B" })).cached).toBe(0);
    expect((await translateWithSettings(config, { ...request, context: "Page C" })).cached).toBe(1);
    expect((await translateWithSettings(config, { ...request, targetLang: "ja" })).cached).toBe(0);
    expect(translateBatch).toHaveBeenCalledTimes(3);
    expect(translateBatch.mock.calls.map(([part]) => part.sourceLang)).toEqual(["en", "de", "en"]);
    expect(translateBatch.mock.calls.every(([part]) => part.context === undefined)).toBe(true);
  });

  it("invalidates cached translations when the Doubao protocol version changes", async () => {
    const storage = memoryStorage();
    const config = settings(true);
    const request = { texts: ["Hello"], targetLang: "zh-CN" };
    translateBatch.mockResolvedValueOnce(["旧协议译文"]).mockResolvedValueOnce(["新协议译文"]);

    expect(await translateWithSettings(config, request)).toEqual({ translations: ["旧协议译文"], cached: 0 });
    protocol.version = 2;
    expect(await translateWithSettings(config, request)).toEqual({ translations: ["新协议译文"], cached: 0 });
    expect(await translateWithSettings(config, request)).toEqual({ translations: ["新协议译文"], cached: 1 });
    expect(storage.values.size).toBe(2);
    expect(translateBatch).toHaveBeenCalledTimes(2);
  });

  it("does not cache an earlier successful batch when a later batch is malformed", async () => {
    const storage = memoryStorage();
    const config = settings(true);
    const texts = Array.from({ length: 11 }, (_, index) => `Paragraph ${index}`);
    translateBatch.mockImplementationOnce(async (request) => request.texts.map(() => "有效译文"))
      .mockResolvedValueOnce([""]);

    await expect(translateWithSettings(config, { texts, targetLang: "zh-CN" }))
      .rejects.toBeInstanceOf(TranslationResponseError);
    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(storage.set).not.toHaveBeenCalled();

    const retried = await translateWithSettings(config, { texts, targetLang: "zh-CN" });
    expect(retried.cached).toBe(0);
    expect(retried.translations).toEqual(texts.map((text) => `译文：${text}`));
  });

  it("repairs protected content through the existing fragment path and caches only the repaired result", async () => {
    const storage = memoryStorage();
    const config = settings(true);
    const request = { texts: ["Use ⟪WUPAGE0⟫ safely."], targetLang: "zh-CN", preservePlaceholders: true };
    translateBatch.mockResolvedValueOnce(["缺少公式"])
      .mockResolvedValueOnce(["再次缺少公式"])
      .mockResolvedValueOnce(["使用", "注意安全。"]);

    await expect(translateWithSettings(config, request)).resolves.toEqual({
      translations: ["使用 ⟪WUPAGE0⟫ 注意安全。"], cached: 0
    });
    expect(translateBatch).toHaveBeenCalledTimes(3);
    expect(translateBatch.mock.calls[2][0].texts).toEqual(["Use", "safely."]);
    expect(translateBatch.mock.calls[2][0].context).not.toContain("⟪WUPAGE0⟫");
    const firstSignal = translateBatch.mock.calls[0][1];
    expect(translateBatch.mock.calls.every(([, signal]) => signal === firstSignal)).toBe(true);
    expect([...storage.values.values()]).toEqual(["使用 ⟪WUPAGE0⟫ 注意安全。"]);
    expect((await translateWithSettings(config, request)).cached).toBe(1);
    expect(translateBatch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["initial request", 0], ["paragraph repair", 1], ["fragment repair", 2]
  ] as const)("propagates authentication failure during %s without further recovery calls", async (_stage, precedingCalls) => {
    const storage = memoryStorage();
    const error = new ProviderError("请登录豆包", "login-required");
    for (let index = 0; index < precedingCalls; index++) translateBatch.mockResolvedValueOnce(["缺少公式"]);
    translateBatch.mockRejectedValueOnce(error);

    await expect(translateWithSettings(settings(true), {
      texts: ["Use ⟪WUPAGE0⟫ safely."], targetLang: "zh-CN", preservePlaceholders: true
    })).rejects.toBe(error);
    expect(translateBatch).toHaveBeenCalledTimes(precedingCalls + 1);
    expect(storage.set).not.toHaveBeenCalled();
  });
});

describe("Doubao's total deadline includes common scheduling and recovery", () => {
  function blockGlobalSlot(config: ExtensionSettings) {
    const blocker = deferred<string[]>();
    const googleTranslate = vi.fn<TranslatorProvider["translateBatch"]>(() => blocker.promise);
    config.concurrency = 1;
    config.providers.push({ type: "google-web-translate", id: "global-blocker", label: "Global blocker" });
    vi.mocked(createProvider).mockImplementation((provider) => ({
      id: provider.id, label: provider.label,
      translateBatch: provider.id === "global-blocker" ? googleTranslate : translateBatch,
      validateConfig: () => ({ ok: true })
    }));
    const running = translateWithSettings(config, {
      texts: ["Occupy the common queue"], targetLang: "zh-CN", providerId: "global-blocker"
    });
    return { blocker, googleTranslate, running };
  }

  it("times out while queued globally, removes that entry, and never dispatches it after the slot opens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const config = settings();
    const { blocker, googleTranslate, running } = blockGlobalSlot(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(googleTranslate).toHaveBeenCalledTimes(1);
    const pending = translateWithSettings(config, { texts: ["Queued Doubao paragraph"], targetLang: "zh-CN" });
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "timeout" });

    await vi.advanceTimersByTimeAsync(109_999);
    expect(translateBatch).not.toHaveBeenCalled();
    expect(getTranslationDebugSnapshot().tasks.find((task) => task.providerId === config.activeProviderId)?.status)
      .toBe("queued");
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(getTranslationDebugSnapshot().tasks.find((task) => task.providerId === config.activeProviderId)?.status)
      .toBe("failed");

    blocker.resolve(["其他服务商完成"]);
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(translateBatch).not.toHaveBeenCalled();

    await expect(translateWithSettings(config, { texts: ["A fresh request"], targetLang: "zh-CN" }))
      .resolves.toEqual({ translations: ["译文：A fresh request"], cached: 0 });
    expect(translateBatch).toHaveBeenCalledTimes(1);
  });

  it("passes only the remaining total budget to a request that starts after a long queue wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const config = settings();
    const { blocker, running } = blockGlobalSlot(config);
    await vi.advanceTimersByTimeAsync(0);
    let requestSignal: AbortSignal | undefined;
    translateBatch.mockImplementationOnce((_request, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const pending = translateWithSettings(config, { texts: ["Queued Doubao paragraph"], targetLang: "zh-CN" });
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "timeout" });

    await vi.advanceTimersByTimeAsync(100_000);
    blocker.resolve(["其他服务商完成"]);
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(translateBatch).toHaveBeenCalledTimes(1);
  });

  it("does not start a queued provider request after both callers' deadlines have expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const config = settings();
    const inFlight = deferred<string[]>();
    // An uncooperative provider may settle late; the common path still must not
    // dispatch an already-expired waiter when this request eventually releases.
    translateBatch.mockImplementationOnce(() => inFlight.promise);
    const first = translateWithSettings(config, { texts: ["First"], targetLang: "zh-CN" });
    const firstRejected = expect(first).rejects.toMatchObject({ errorCode: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = translateWithSettings(config, { texts: ["Second"], targetLang: "zh-CN" });
    const secondRejected = expect(second).rejects.toMatchObject({ errorCode: "timeout" });

    await vi.advanceTimersByTimeAsync(109_000);
    await firstRejected;
    await vi.advanceTimersByTimeAsync(1_000);
    await secondRejected;
    expect(translateBatch).toHaveBeenCalledTimes(1);
    inFlight.resolve(["过期译文"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(getTranslationDebugSnapshot().tasks.filter((task) => task.providerId === config.activeProviderId)
      .every((task) => task.status === "failed")).toBe(true);
  });

  it("shares one deadline across protected-text repairs and rejects late results without caching them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storage = memoryStorage();
    const config = settings(true);
    translateBatch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100_000));
      return ["缺少公式"];
    }).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return ["再次缺少公式"];
    });
    const pending = translateWithSettings(config, {
      texts: ["Use ⟪WUPAGE0⟫ safely."], targetLang: "zh-CN", preservePlaceholders: true
    });
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "timeout" });
    // Cache hashing uses WebCrypto; yield to it before advancing the clock.
    await vi.waitFor(() => expect(translateBatch).toHaveBeenCalledTimes(1), { interval: 0 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(translateBatch.mock.calls[1][1]).toBe(translateBatch.mock.calls[0][1]);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(translateBatch).toHaveBeenCalledTimes(2);
    expect(storage.set).not.toHaveBeenCalled();
  });
});
