import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { signVolcengineTranslation } from "../src/background/volcengine-signing";
import { normalizeSettings } from "../src/shared/settings";
import { withGoogleAuth } from "./helpers/google-web";

const types = ["microsoft-web-translate", "google-web-translate", "tencent-transmart", "yandex-web-translate", "volcengine-web-translate", "mymemory"] as const;
const request = { texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" };
const credentials = { apiKey: "example-key", accessKeyId: "example-ak", secretAccessKey: "example-sk", folderId: "example-folder" };
const responses: Record<typeof types[number], unknown> = {
  "microsoft-web-translate": [{ translations: [{ text: "你好" }] }],
  "google-web-translate": { data: { translations: [{ translatedText: "你好" }] } },
  "tencent-transmart": { choices: [{ message: { content: "你好" } }] },
  "yandex-web-translate": { translations: [{ text: "你好" }] },
  "volcengine-web-translate": { TranslationList: [{ Translation: "你好" }] },
  mymemory: { responseStatus: 200, responseData: { translatedText: "你好" } }
};
const hosts: Record<typeof types[number], string> = {
  "microsoft-web-translate": "api.cognitive.microsofttranslator.com", "google-web-translate": "translation.googleapis.com",
  "tencent-transmart": "tokenhub.tencentmaas.com", "yandex-web-translate": "translate.api.cloud.yandex.net",
  "volcengine-web-translate": "translate.volcengineapi.com", mymemory: "translated-mymemory---translation-memory.p.rapidapi.com"
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("translation service modes", () => {
  it.each(types)("defaults %s to free without sending saved API credentials", async type => {
    const provider = createProvider({ type, id: type, label: type, api: credentials });
    const freePayload = type === "microsoft-web-translate" ? responses[type]
      : type === "google-web-translate" ? [["<pre>你好</pre>"]]
        : type === "tencent-transmart" ? { header: { ret_code: "succ" }, auto_translation: ["你好"] }
          : type === "yandex-web-translate" ? { code: 200, text: ["你好"] }
            : type === "volcengine-web-translate" ? { base_resp: { status_code: 0 }, translation: "你好" } : responses[type];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(freePayload)));
    vi.stubGlobal("fetch", withGoogleAuth(fetchMock));
    expect(provider.validateConfig()).toEqual({ ok: true });
    await expect(provider.translateBatch(request)).resolves.toEqual(["你好"]);
    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain("example-key");
    expect(serialized).not.toContain("example-sk");
    expect(new URL(String(fetchMock.mock.calls[0][0])).hostname).not.toBe(hosts[type]);
  });

  it.each(types)("routes %s API mode to the configured account", async type => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses[type])));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type, id: type, label: type, serviceMode: "api", api: credentials });
    await expect(provider.translateBatch(request)).resolves.toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).hostname).toBe(hosts[type]);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    if (type === "microsoft-web-translate") expect(headers.get("Ocp-Apim-Subscription-Key")).toBe("example-key");
    if (type === "google-web-translate") expect(new URL(url).searchParams.get("key")).toBe("example-key");
    if (type === "tencent-transmart") {
      expect(headers.get("Authorization")).toBe("Bearer example-key");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "hy-mt2-lite", stream: false });
    }
    if (type === "yandex-web-translate") {
      expect(headers.get("Authorization")).toBe("Api-Key example-key");
      expect(JSON.parse(String(init.body))).toMatchObject({ texts: ["Hello"], sourceLanguageCode: "en", targetLanguageCode: "zh", folderId: "example-folder" });
    }
    if (type === "volcengine-web-translate") {
      expect(headers.get("Authorization")).toMatch(/^HMAC-SHA256 Credential=example-ak\//);
      expect(headers.has("Host")).toBe(false);
      expect(JSON.parse(String(init.body))).toMatchObject({ TextList: ["Hello"], SourceLanguage: "en", TargetLanguage: "zh" });
    }
    if (type === "mymemory") expect(headers.get("X-RapidAPI-Key")).toBe("example-key");
  });

  it.each(types)("requires credentials for %s API mode instead of silently using free", async type => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type, id: type, label: type, serviceMode: "api" });
    expect(provider.validateConfig().ok).toBe(false);
    await expect(provider.translateBatch(request)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(types)("does not fall back or disclose credentials after %s API failure", async type => {
    const fetchMock = vi.fn(async () => new Response("example-key example-sk", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type, id: type, label: type, serviceMode: "api", api: credentials });
    await expect(provider.translateBatch(request)).rejects.toThrow("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(types)("cancels %s API requests without dispatching later text", async type => {
    const fetchMock = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type, id: type, label: type, serviceMode: "api", api: credentials });
    const controller = new AbortController();
    const result = provider.translateBatch({ ...request, texts: ["First", "Second"] }, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports MyMemory API quota errors against the RapidAPI subscription", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    const provider = createProvider({ type: "mymemory", id: "mymemory", label: "MyMemory", serviceMode: "api", api: credentials });
    await expect(provider.translateBatch(request)).rejects.toThrow("RapidAPI 订阅");
  });

  it("batches Volcengine requests within its 16-item limit and rejects incomplete results", async () => {
    const fetchMock = vi.fn(async (_url, init: RequestInit) => new Response(JSON.stringify({
      TranslationList: JSON.parse(String(init.body)).TextList.map(() => ({ Translation: "你好" }))
    })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "volcengine-web-translate", id: "volc", label: "volc", serviceMode: "api", api: credentials });
    await expect(provider.translateBatch({ ...request, texts: Array(18).fill("Hello") })).resolves.toHaveLength(18);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).TextList.length)).toEqual([16, 2]);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ TranslationList: [] })));
    await expect(provider.translateBatch(request)).rejects.toThrow("完整译文");
  });

  it("preserves Azure resource paths and regional authentication", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses["microsoft-web-translate"])));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "microsoft-web-translate", id: "ms", label: "ms", serviceMode: "api",
      api: { apiKey: "example-key", region: "eastasia", endpoint: "https://example.cognitiveservices.azure.com/translator/text/v3.0/" } });
    await provider.translateBatch(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/translator/text/v3.0/translate");
    expect(new Headers(init.headers).get("Ocp-Apim-Subscription-Region")).toBe("eastasia");
  });
});

describe("service settings migration", () => {
  it("keeps saved credentials when switching between free and API modes", () => {
    for (const type of types) {
      for (const serviceMode of ["free", "api"] as const) {
        const settings = normalizeSettings({ providers: [{ type, id: type, label: type, serviceMode, api: credentials }] });
        expect(settings.providers.find(entry => entry.id === type)).toMatchObject({ serviceMode, api: credentials });
      }
    }
  });

  it("moves an active legacy Google subscription into the unified service and is idempotent", () => {
    const settings = normalizeSettings({ activeProviderId: "google-cloud-translation", providers: [{
      type: "google-cloud-translation", id: "google-cloud-translation", label: "My Google", apiKey: "example-key"
    }] });
    expect(settings.activeProviderId).toBe("google-web-translate");
    expect(settings.providers.find(entry => entry.id === settings.activeProviderId)).toMatchObject({ label: "My Google", serviceMode: "api", api: { apiKey: "example-key" } });
    expect(normalizeSettings(settings)).toEqual(settings);
  });

  it("retains distinct subscriptions instead of overwriting either credential", () => {
    const settings = normalizeSettings({ activeProviderId: "microsoft-translator", providers: [
      { type: "microsoft-web-translate", id: "microsoft-web-translate", label: "first", api: { apiKey: "first-key" } },
      { type: "microsoft-translator", id: "microsoft-translator", label: "second", apiKey: "second-key", region: "eastasia", endpoint: "https://api.cognitive.microsofttranslator.com" }
    ] });
    expect(settings.activeProviderId).toBe("microsoft-translator");
    expect(settings.providers.find(entry => entry.id === "microsoft-web-translate")).toMatchObject({ api: { apiKey: "first-key" } });
    expect(settings.providers.find(entry => entry.id === "microsoft-translator")).toMatchObject({ apiKey: "second-key" });
  });

  it("normalizes malformed optional API values without dropping the free service", () => {
    const settings = normalizeSettings({ providers: [{ type: "mymemory", id: "mymemory", label: "MyMemory", serviceMode: "other", api: { apiKey: 123, endpoint: "  https://example.com  " } }] });
    expect(settings.providers.find(entry => entry.id === "mymemory")).toMatchObject({ serviceMode: "free", api: { endpoint: "https://example.com" } });
  });
});

it("signs the exact UTF-8 body using the Volcengine V4 reference fixture", async () => {
  const headers = await signVolcengineTranslation('{"TextList":["Hello"],"TargetLanguage":"zh"}', "example-ak", "example-sk", "cn-north-1", new Date("2026-10-27T12:00:00Z"));
  expect(headers["X-Date"]).toBe("20261027T120000Z");
  expect(headers["X-Content-Sha256"]).toBe("9fd0aafbd6a914b7a87b04f665ce41960e6fe62a59cdea4499ca787beaca3a9d");
  expect(headers.Authorization).toBe("HMAC-SHA256 Credential=example-ak/20261027/cn-north-1/translate/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=ba34b70cd96908cd5178c631c575c468c5a95bee6d9a3bcefad3ccea557f6070");
});
