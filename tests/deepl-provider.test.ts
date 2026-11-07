import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { TranslationResponseError } from "../src/background/translation-response";
import type { DeepLConfig } from "../src/shared/types";
import { deepLEndpoint } from "../src/shared/deepl";
import { translateWithSettings } from "../src/background/translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

const config: DeepLConfig = { type: "deepl", id: "deepl", label: "DeepL", endpoint: "", apiKey: "test-key:fx" };
const request = { texts: ["Hello", "World"], sourceLang: "auto", targetLang: "zh-CN", context: "A greeting" };
const response = (texts: string[]) => new Response(JSON.stringify({ translations: texts.map(text => ({ text })) }));
beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { id: "test-extension", getURL: (path: string) => `chrome-extension://test-extension/${path}` },
    declarativeNetRequest: { getSessionRules: vi.fn(async () => []), updateSessionRules: vi.fn(async () => undefined) }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("DeepL", () => {
  it("passes context separately through the translation pipeline without a second billable request", async () => {
    const fetch = vi.fn().mockResolvedValue(response(["你好", "世界"]));
    vi.stubGlobal("fetch", fetch);
    await expect(translateWithSettings({ ...DEFAULT_SETTINGS, activeProviderId: "deepl", providers: [config], cacheEnabled: false }, request))
      .resolves.toEqual({ translations: ["你好", "世界"], cached: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ text: ["Hello", "World"], context: "A greeting" });
    const ruleChanges = vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mock.calls.map(([change]) => change);
    expect(ruleChanges.some(change => change.addRules?.[0].action.requestHeaders?.[0].header === "origin")).toBe(true);
    expect(ruleChanges.at(-1)).toHaveProperty("removeRuleIds");
  });

  it("authenticates Free requests, auto-detects source, passes context and preserves batch order", async () => {
    const fetch = vi.fn().mockResolvedValue(response(["你好", "世界"]));
    vi.stubGlobal("fetch", fetch);
    const usage = vi.fn();
    await expect(createProvider(config).translateBatch(request, undefined, usage)).resolves.toEqual(["你好", "世界"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api-free.deepl.com/v2/translate");
    expect(url).not.toContain(config.apiKey);
    expect(init).toMatchObject({ method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: "DeepL-Auth-Key test-key:fx" } });
    expect(JSON.parse(init.body)).toEqual({ text: request.texts, target_lang: "ZH-HANS", context: "A greeting" });
    expect(usage).toHaveBeenCalledWith({ translations: [{ text: "你好" }, { text: "世界" }] });
  });

  it.each([
    ["zh-TW", "en", "ZH", "EN-US"], ["en-US", "zh-TW", "EN", "ZH-HANT"],
    ["en", "zh-HK", "EN", "ZH-HANT"], ["ja", "de", "JA", "DE"],
    ["auto", "en-GB", undefined, "EN-GB"], [undefined, "fr", undefined, "FR"]
  ])("maps source %s and target %s independently", async (sourceLang, targetLang, source, target) => {
    const fetch = vi.fn().mockResolvedValue(response(["Translated"]));
    vi.stubGlobal("fetch", fetch);
    await createProvider({ ...config, apiKey: " paid-key " }).translateBatch({ texts: ["Text"], sourceLang, targetLang: targetLang! });
    expect(fetch.mock.calls[0][0]).toBe("https://api.deepl.com/v2/translate");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.target_lang).toBe(target);
    expect(body.source_lang).toBe(source);
    expect(body).not.toHaveProperty("context");
  });

  it.each(["https://proxy.test", "https://proxy.test/v2/", "https://proxy.test/v2/translate/"])(
    "accepts host, base and complete endpoint %s", endpoint => {
      expect(deepLEndpoint({ ...config, endpoint })).toBe("https://proxy.test/v2/translate");
    }
  );

  it("supports a local proxy and preserves its path prefix", () => {
    expect(deepLEndpoint({ ...config, endpoint: "http://127.0.0.1:8088/deepl/v2" }))
      .toBe("http://127.0.0.1:8088/deepl/v2/translate");
  });

  it.each(["not a url", "file:///tmp/deepl", "https://user:secret@example.test", "https://example.test/#fragment"])(
    "rejects an invalid endpoint before sending credentials: %s", async endpoint => {
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      const provider = createProvider({ ...config, endpoint });
      expect(provider.validateConfig().ok).toBe(false);
      await expect(provider.translateBatch(request)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("requires a key and makes no request for an empty batch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(createProvider({ ...config, apiKey: " " }).validateConfig().ok).toBe(false);
    await expect(createProvider(config).translateBatch({ ...request, texts: [] })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("groups more than 50 texts sequentially and retains their original order", async () => {
    const texts = Array.from({ length: 103 }, (_, i) => `Text ${i}`);
    const fetch = vi.fn(async (_url, init) => response(JSON.parse(init.body).text));
    vi.stubGlobal("fetch", fetch);
    await expect(createProvider(config).translateBatch({ ...request, texts })).resolves.toEqual(texts);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).text.length)).toEqual([50, 50, 3]);
  });

  it("accounts for UTF-8, JSON escaping and context when grouping requests", async () => {
    const texts = Array.from({ length: 12 }, () => '汉字"\\\n'.repeat(2000));
    const fetch = vi.fn(async (_url, init) => response(JSON.parse(init.body).text));
    vi.stubGlobal("fetch", fetch);
    await expect(createProvider(config).translateBatch({ ...request, texts, context: "Context ".repeat(1000) })).resolves.toEqual(texts);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetch.mock.calls) expect(new TextEncoder().encode(init.body).byteLength).toBeLessThanOrEqual(120 * 1024);
  });

  it("rejects oversized input before billing any earlier groups", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createProvider(config).translateBatch({ ...request, texts: [...Array(50).fill("small"), "汉".repeat(50000)] }))
      .rejects.toThrow(/大小/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, { translations: ["wrong shape", "shape"] }, { translations: [{ text: "one" }] },
    { translations: [{ text: " " }, { text: "two" }] }, { translations: [null, { text: "two" }] }])(
    "rejects missing, empty or mismatched results", async payload => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
      await expect(createProvider(config).translateBatch(request)).rejects.toBeInstanceOf(TranslationResponseError);
    }
  );

  it.each([[403, "permission-required", /密钥/], [456, "service-rejected", /额度/],
    [429, "rate-limited", /429/], [500, "service-unavailable", /500/]])(
    "reports HTTP %s without retrying billable batches", async (status, errorCode, message) => {
      const fetch = vi.fn().mockResolvedValue(new Response("error", { status: status as number, headers: { "Retry-After": "12" } }));
      vi.stubGlobal("fetch", fetch);
      await expect(createProvider(config).translateBatch(request)).rejects.toMatchObject({ errorCode, message: expect.stringMatching(message as RegExp) });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("honors cancellation before and between requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      return response(JSON.parse(init.body).text);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createProvider(config).translateBatch({ ...request, texts: Array(51).fill("hello") }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(createProvider(config).translateBatch(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
