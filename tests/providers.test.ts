import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";

describe("MicrosoftTranslatorProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Microsoft Translator REST API and parses translations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { translations: [{ text: "你好" }] },
        { translations: [{ text: "世界" }] }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createProvider({
      type: "microsoft-translator",
      id: "microsoft",
      label: "Microsoft",
      endpoint: "https://api.cognitive.microsofttranslator.com",
      apiKey: "secret",
      region: "eastasia"
    });

    await expect(
      provider.translateBatch({
        texts: ["hello", "world"],
        sourceLang: "en",
        targetLang: "zh-CN"
      })
    ).resolves.toEqual(["你好", "世界"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/translate?");
    expect(url).toContain("api-version=3.0");
    expect(url).toContain("to=zh-Hans");
    expect(url).toContain("from=en");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Ocp-Apim-Subscription-Key": "secret",
      "Ocp-Apim-Subscription-Region": "eastasia"
    });
    expect(JSON.parse(String(init.body))).toEqual([{ Text: "hello" }, { Text: "world" }]);
  });
});

describe("GoogleWebTranslateProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Google web endpoint without an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[["你好", "hello", null, null]]]
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createProvider({
      type: "google-web-translate",
      id: "google-web",
      label: "Google Web"
    });

    await expect(
      provider.translateBatch({
        texts: ["hello"],
        sourceLang: "en",
        targetLang: "zh-CN"
      })
    ).resolves.toEqual(["你好"]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit?];
    expect(url).toContain("https://translate.googleapis.com/translate_a/single");
    expect(url).toContain("client=gtx");
    expect(url).toContain("sl=en");
    expect(url).toContain("tl=zh-CN");
    expect(url).toContain("q=hello");
    expect(url).not.toContain("key=");
  });
});

describe("GoogleCloudTranslationProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls Google Cloud Translation Basic and decodes translated text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          translations: [{ translatedText: "Tom &amp; Jerry" }]
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createProvider({
      type: "google-cloud-translation",
      id: "google",
      label: "Google",
      apiKey: "secret"
    });

    await expect(
      provider.translateBatch({
        texts: ["Tom & Jerry"],
        sourceLang: "en",
        targetLang: "zh-CN"
      })
    ).resolves.toEqual(["Tom & Jerry"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://translation.googleapis.com/language/translate/v2");
    expect(url).toContain("key=secret");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      q: ["Tom & Jerry"],
      source: "en",
      target: "zh-CN",
      format: "text"
    });
  });
});

describe("ZhipuGlmProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Zhipu GLM chat completions endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "[\"你好\",\"世界\"]"
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createProvider({
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "secret",
      model: "glm-4.7-flash",
      systemPrompt: "Translate to {{targetLang}}"
    });

    await expect(
      provider.translateBatch({
        texts: ["hello", "world"],
        sourceLang: "en",
        targetLang: "zh-CN"
      })
    ).resolves.toEqual(["你好", "世界"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret"
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "glm-4.7-flash",
      temperature: 0
    });
  });

  it("accepts a plain-text response for a single input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "你好" } }] })
    }));
    const provider = createProvider({
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "secret",
      model: "glm-4-flash-250414",
      systemPrompt: "Translate to {{targetLang}}"
    });

    await expect(provider.translateBatch({
      texts: ["hello"],
      sourceLang: "en",
      targetLang: "zh-CN"
    })).resolves.toEqual(["你好"]);
  });

  it("joins a single translation split into multiple response strings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '["第一部分","第二部分"]' } }]
      })
    }));
    const provider = createProvider({
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "secret",
      model: "glm-4-flash-250414",
      systemPrompt: "Translate to {{targetLang}}"
    });

    await expect(provider.translateBatch({
      texts: ["A paragraph with two parts."],
      sourceLang: "en",
      targetLang: "zh-CN"
    })).resolves.toEqual(["第一部分\n第二部分"]);
  });
});

describe("AnthropicCompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Anthropic Messages endpoint and parses text content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "[\"你好\",\"世界\"]" }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({
      type: "anthropic-compatible",
      id: "custom-anthropic",
      label: "Custom Anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "secret",
      model: "claude-test",
      systemPrompt: "Translate to {{targetLang}}"
    });

    await expect(provider.translateBatch({
      texts: ["hello", "world"],
      sourceLang: "en",
      targetLang: "zh-CN"
    })).resolves.toEqual(["你好", "世界"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01"
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "claude-test",
      max_tokens: 8192,
      temperature: 0
    });
  });
});
