import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";
import { translateWithSettings } from "../src/background/translation";
import { TranslationResponseError } from "../src/background/translation-response";
import { translateTextWithRecovery } from "../src/background/protected-translation";

const providers: ProviderConfig[] = [
  { type: "openai-compatible", id: "openai-audit", label: "OpenAI", ollamaCompatibility: false,
    baseURL: "https://example.com/v1", apiKey: "test", model: "test", systemPrompt: "Translate" },
  { type: "anthropic-compatible", id: "anthropic-audit", label: "Anthropic",
    baseURL: "https://example.com/v1", apiKey: "test", model: "test", systemPrompt: "Translate" },
  { type: "deepseek", id: "deepseek-audit", label: "DeepSeek",
    baseURL: "https://example.com/v1", apiKey: "test", model: "test", systemPrompt: "Translate" },
  { type: "zhipu-glm", id: "zhipu-audit", label: "GLM",
    baseURL: "https://example.com/v1", apiKey: "test", model: "test", systemPrompt: "Translate" }
];

function settingsFor(provider: ProviderConfig): ExtensionSettings {
  return { ...DEFAULT_SETTINGS, providers: [provider], activeProviderId: provider.id, cacheEnabled: false, concurrency: 1 };
}

function responseFor(provider: ProviderConfig, content: unknown): Response {
  return Response.json(provider.type === "anthropic-compatible"
    ? { content: [{ type: "text", text: content }] }
    : { choices: [{ message: { content } }] });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe.each(providers)("$label translation recovery", (provider) => {
  it.each(['["截断译文"', '{"translation":', '"未闭合字符串', '```json\n["未结束的代码块"]'])
    ("retries incomplete structured output %s without displaying or caching it", async (broken) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(responseFor(provider, broken))
        .mockResolvedValueOnce(responseFor(provider, '["完整译文"]'));
      vi.stubGlobal("fetch", fetchMock);
      const set = vi.fn(async (_items: Record<string, string>) => undefined);
      vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}), set } } });
      const result = await translateWithSettings({ ...settingsFor(provider), cacheEnabled: true }, {
        texts: ["Complete source sentence."], targetLang: "zh-CN"
      });
      expect(result.translations).toEqual(["完整译文"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(Object.values(set.mock.calls[0][0])).toEqual(["完整译文"]);
    });

  it("does not silently join extra items or retry indefinitely", async () => {
    const fetchMock = vi.fn(async () => responseFor(provider, '["多出的条目","不该拼接的条目"]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateWithSettings(settingsFor(provider), { texts: ["One item."], targetLang: "zh-CN" }))
      .rejects.toBeInstanceOf(TranslationResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, [], 42])("recovers missing or non-text model content %s", async (content) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(responseFor(provider, content))
      .mockResolvedValueOnce(responseFor(provider, '["完整译文"]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateWithSettings(settingsFor(provider), { texts: ["One item."], targetLang: "zh-CN" }))
      .resolves.toMatchObject({ translations: ["完整译文"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not split batches to retry HTML configuration failures", async () => {
    const fetchMock = vi.fn(async () => responseFor(provider, "<!doctype html><html><body>Wrong endpoint</body></html>"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateWithSettings(settingsFor(provider), { texts: ["First.", "Second."], targetLang: "zh-CN" }))
      .rejects.toThrow("HTML 网页");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("does not split batches after HTTP %s", async (status) => {
    const fetchMock = vi.fn(async () => new Response("Access denied", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateWithSettings(settingsFor(provider), { texts: ["First.", "Second."], targetLang: "zh-CN" }))
      .rejects.toThrow(String(status));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("shared translation contracts", () => {
  it("returns valid output even when cache reads and writes are unavailable", async () => {
    const provider = providers[0];
    const fetchMock = vi.fn(async () => responseFor(provider, '["可用译文"]'));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
      set: vi.fn().mockRejectedValue(new Error("QUOTA_BYTES exceeded"))
    } } });
    await expect(translateWithSettings({ ...settingsFor(provider), cacheEnabled: true }, { texts: ["Source."], targetLang: "zh-CN" }))
      .resolves.toEqual({ translations: ["可用译文"], cached: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the error type rather than its wording for protected-text recovery", async () => {
    const translate = vi.fn().mockResolvedValueOnce(["缺少占位符"])
      .mockRejectedValueOnce(new TranslationResponseError("响应格式不正确"))
      .mockResolvedValueOnce(["使用", "替代", "完成操作。"]);
    await expect(translateTextWithRecovery({ texts: ["Use ⟪WUPAGE1⟫ instead of ⟪WUPAGE0⟫ to finish."], targetLang: "zh-CN", preservePlaceholders: true }, translate))
      .resolves.toEqual(["使用 ⟪WUPAGE1⟫ 替代 ⟪WUPAGE0⟫ 完成操作。"]);
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("does not treat an arbitrary error starting with the former prefix as recoverable", async () => {
    const translate = vi.fn().mockResolvedValueOnce(["缺少占位符"])
      .mockRejectedValueOnce(new Error("LLM response connection closed"));
    await expect(translateTextWithRecovery({ texts: ["Use ⟪WUPAGE0⟫."], targetLang: "zh-CN", preservePlaceholders: true }, translate))
      .rejects.toThrow("connection closed");
    expect(translate).toHaveBeenCalledTimes(2);
  });
});
