import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, mergeStoredKeys, parseSettingsBackup } from "../src/shared/settings-backup";
import { createProvider } from "../src/background/providers";
import type { OpenAICompatibleConfig, ProviderConfig } from "../src/shared/types";

const SECRET = "0123456789abcdef0123456789abcdef";
const settingsWith = (provider: ProviderConfig) => normalizeSettings({
  ...structuredClone(DEFAULT_SETTINGS), activeProviderId: provider.id, providers: [provider]
});
const llm = (baseURL: string, apiKey = ""): OpenAICompatibleConfig => ({
  type: "openai-compatible", id: "custom-llm-review", label: "Custom LLM",
  baseURL, apiKey, model: "model", systemPrompt: "Translate", ollamaCompatibility: false
});
const capture = () => {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '["你好"]' } }]
  }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
};
afterEach(() => vi.unstubAllGlobals());

describe("review: URL credential boundaries", () => {
  it("removes api_key credentials saved in an LLM Base URL from the default backup", async () => {
    const provider = llm(`https://llm.example/v1?api_key=${SECRET}`);
    const file = createSettingsBackup(settingsWith(provider));
    expect(file.includesKeys).toBe(false);
    const written = JSON.stringify(file);
    const restored = parseSettingsBackup(written).settings;
    const mock = capture();
    await createProvider(restored.providers.find(p => p.id === provider.id)!)
      .translateBatch({ texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" });
    const requestUrl = new URL(mock.mock.calls[0][0] as string);
    expect(requestUrl.origin).toBe("https://llm.example");
    expect({
      fileContainsKey: written.includes(SECRET),
      requestContainsKey: requestUrl.searchParams.get("api_key") === SECRET
    }).toEqual({ fileContainsKey: false, requestContainsKey: false });
  });

  it("does not restore a local key when the URL parser treats backslash as an authority boundary", async () => {
    const provider = llm("https://original-provider.example/v1", SECRET);
    const current = settingsWith(provider);
    const file = createSettingsBackup(current);
    const incoming = file.settings.providers.find(p => p.id === provider.id) as OpenAICompatibleConfig;
    incoming.baseURL = String.raw`https://different-provider.example\@original-provider.example/v1`;
    expect(new URL(incoming.baseURL).origin).toBe("https://different-provider.example");
    const parsed = parseSettingsBackup(JSON.stringify(file));
    const { settings: restored, skippedKeys } = mergeStoredKeys(parsed.settings, current);
    const mock = capture();
    await createProvider(restored.providers.find(p => p.id === provider.id)!)
      .translateBatch({ texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe("https://different-provider.example");
    expect({
      skippedKeys,
      sendsOriginalKey: new Headers(init.headers).get("Authorization") === `Bearer ${SECRET}`
    }).toEqual({ skippedKeys: 1, sendsOriginalKey: false });
  });
});
