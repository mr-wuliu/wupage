import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";
import { DEFAULT_INPUT_PROMPT, inputTargetLanguage, normalizeInputTranslation, pickInputProvider } from "../src/shared/input-translation";
import { translateInput } from "../src/background/input-translation";

const llm = (extra: Partial<Record<string, unknown>> = {}) => ({ type: "openai-compatible", id: "oa", label: "OA", enabled: true,
  ollamaCompatibility: false, baseURL: "https://llm.test/v1", apiKey: "test-key", model: "m", systemPrompt: "Page prompt", ...extra }) as ProviderConfig;
const google = { type: "google-web-translate", id: "google-web-translate", label: "Google 翻译", enabled: true } as ProviderConfig;
const settingsWith = (providers: ProviderConfig[], active = "google-web-translate", extra: Partial<ExtensionSettings> = {}): ExtensionSettings =>
  ({ ...structuredClone(DEFAULT_SETTINGS), providers, activeProviderId: active, ...extra });
const reply = (content: string) => vi.fn(async (_url: string, _init: RequestInit) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] })));
const storage = { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) };

beforeEach(() => { vi.stubGlobal("chrome", { storage: { local: storage } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("input translation service choice", () => {
  it("prefers the chosen service, then the default service, then any other enabled service that is configured", () => {
    const providers = [google, llm({ id: "a", apiKey: "" }), llm({ id: "b" }), llm({ id: "c" })];
    expect(pickInputProvider(settingsWith(providers))?.id).toBe("google-web-translate");
    expect(pickInputProvider(settingsWith(providers, "c"))?.id).toBe("c");
    expect(pickInputProvider(settingsWith(providers, "c", { inputTranslation: { enabled: true, providerId: "b", prompt: "p" } }))?.id).toBe("b");
    // A chosen service that was removed or lost its key falls back instead of failing.
    expect(pickInputProvider(settingsWith(providers, "c", { inputTranslation: { enabled: true, providerId: "a", prompt: "p" } }))?.id).toBe("c");
    expect(pickInputProvider(settingsWith([{ ...google, enabled: false }, llm({ enabled: false })]))).toBeUndefined();
  });
  it("accepts machine translation services as well as LLMs", () => {
    expect(pickInputProvider(settingsWith([google]))?.id).toBe("google-web-translate");
    expect(pickInputProvider(settingsWith([{ ...google, enabled: false }, llm()], "google-web-translate"))?.id).toBe("oa");
  });
  it("ignores the untouched built-in LLM entries but accepts keyless local endpoints and Anthropic-compatible services", () => {
    expect(pickInputProvider(settingsWith([llm({ apiKey: "" })], "missing"))).toBeUndefined();
    expect(pickInputProvider(settingsWith(DEFAULT_SETTINGS.providers, DEFAULT_SETTINGS.activeProviderId))?.id).toBe(DEFAULT_SETTINGS.activeProviderId);
    expect(pickInputProvider(settingsWith([llm({ apiKey: "", baseURL: "http://localhost:11434/v1" })]))?.id).toBe("oa");
    expect(pickInputProvider(settingsWith([llm({ apiKey: "", baseURL: "http://192.168.1.5:8000/v1" })]))?.id).toBe("oa");
    expect(pickInputProvider(settingsWith([{ ...llm({ id: "claude" }), type: "anthropic-compatible" } as ProviderConfig]))?.id).toBe("claude");
  });
});

describe("input translation language pair", () => {
  it.each([
    ["我们明天下午开会", "English"],
    ["明天 meeting 讨论一下 API 的事", "English"],
    ["See you tomorrow", "Simplified Chinese"],
    ["Please check 这个", "Simplified Chinese"],
    ["明日は会議です", "Simplified Chinese"],
    ["Bonjour à tous", "Simplified Chinese"],
    ["12345", "Simplified Chinese"]
  ])("sends %s to %s", (text, target) => {
    expect(inputTargetLanguage(text)).toBe(target);
  });
});

describe("input translation settings", () => {
  it("fills defaults and keeps a custom prompt", () => {
    expect(normalizeInputTranslation(undefined)).toEqual({ enabled: true, providerId: "", prompt: DEFAULT_INPUT_PROMPT });
    expect(normalizeInputTranslation({ enabled: false, providerId: " b ", prompt: "  Be brief.  " }))
      .toEqual({ enabled: false, providerId: "b", prompt: "Be brief." });
    expect(normalizeInputTranslation({ prompt: "   " }).prompt).toBe(DEFAULT_INPUT_PROMPT);
  });
  it("asks for a native rewrite whose language always differs from the input", () => {
    expect(DEFAULT_INPUT_PROMPT).toContain("the output language always differs from the input language");
    expect(DEFAULT_INPUT_PROMPT).toContain("Do not translate word for word");
    expect(DEFAULT_INPUT_PROMPT).toContain("Leave out filler");
    expect(DEFAULT_INPUT_PROMPT).toContain("Keep line breaks");
  });
});

describe("input translation request", () => {
  it("explains that a translation service is required when none is enabled", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(translateInput(settingsWith([{ ...google, enabled: false }]), "你好")).rejects.toThrow("输入框翻译需要可用的翻译服务");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses a machine translation service without sending the LLM prompt", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify([[["See you tomorrow", "明天见"]]]))); vi.stubGlobal("fetch", fetchMock);
    const result = await translateInput(settingsWith([google, llm()]), "明天见");
    expect(result).toEqual({ translation: "See you tomorrow", providerLabel: "Google 翻译" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("translate.googleapis.com");
    expect(url).toContain("tl=English");
  });
  it("falls back past a chosen service whose settings are incomplete", async () => {
    const fetchMock = reply('["你好"]'); vi.stubGlobal("fetch", fetchMock);
    const cloud = { type: "google-cloud-translation", id: "gc", label: "Google Cloud", enabled: true, apiKey: "" } as ProviderConfig;
    const result = await translateInput(settingsWith([cloud, llm()], "gc"), "Hello");
    expect(result.providerLabel).toBe("OA");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects empty, oversized or disabled requests before calling the model", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(translateInput(settingsWith([llm()]), "  ")).rejects.toThrow("没有可翻译");
    await expect(translateInput(settingsWith([llm()]), "x".repeat(8001))).rejects.toThrow("上限 8000 字符");
    await expect(translateInput(settingsWith([llm()], "oa", { inputTranslation: { enabled: false, providerId: "", prompt: "p" } }), "你好"))
      .rejects.toThrow("已关闭");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends one request with the input prompt and target language and never touches the cache", async () => {
    const fetchMock = reply('["See you tomorrow"]'); vi.stubGlobal("fetch", fetchMock);
    const result = await translateInput(settingsWith([google, llm()], "google-web-translate",
      { cacheEnabled: true, inputTranslation: { enabled: true, providerId: "oa", prompt: DEFAULT_INPUT_PROMPT } }), "明天见");
    expect(result).toEqual({ translation: "See you tomorrow", providerLabel: "OA" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("output language always differs");
    expect(body).not.toContain("Page prompt");
    expect(body).toContain("into English");
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });
  it("uses the prompt saved in settings", async () => {
    const fetchMock = reply('["你好"]'); vi.stubGlobal("fetch", fetchMock);
    await translateInput(settingsWith([llm()], "oa", { inputTranslation: { enabled: true, providerId: "", prompt: "Be brief and formal." } }), "Hello");
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("Be brief and formal.");
    expect(body).toContain("into Simplified Chinese");
  });
});
