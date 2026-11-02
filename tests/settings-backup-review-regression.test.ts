import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, mergeStoredKeys, parseSettingsBackup } from "../src/shared/settings-backup";
import { createProvider } from "../src/background/providers";
import type { HttpTemplateConfig, OpenAICompatibleConfig, ProviderConfig } from "../src/shared/types";

const SECRET = "0123456789abcdef0123456789abcdef";
const settingsWith = (provider: ProviderConfig) => normalizeSettings({
  ...structuredClone(DEFAULT_SETTINGS), activeProviderId: provider.id, providers: [provider]
});
const capture = (answer: unknown) => {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(answer), {
    headers: { "Content-Type": "application/json" }
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
};
afterEach(() => vi.unstubAllGlobals());

describe("review: remaining backup boundaries", () => {
  it("strips an api_key from a valid HTTP body template containing a raw texts variable", async () => {
    const provider: HttpTemplateConfig = {
      type: "http-template", id: "custom-http-review", label: "Custom HTTP", method: "POST",
      url: "https://translation.example/v1", responsePath: "translations",
      headers: { "Content-Type": "application/json" },
      bodyTemplate: `{"api_key":"${SECRET}","q":{{json texts}},"target":"{{targetLang}}"}`
    };
    const file = createSettingsBackup(settingsWith(provider));
    expect(file.includesKeys).toBe(false);
    const written = JSON.stringify(file);
    const restored = parseSettingsBackup(written).settings;
    const fetchMock = capture({ translations: ["你好"] });
    await createProvider(restored.providers.find(p => p.id === provider.id)!)
      .translateBatch({ texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).q).toEqual(["Hello"]);
    expect({
      fileContainsKey: written.includes(SECRET),
      requestContainsKey: String(init.body).includes(SECRET)
    }).toEqual({ fileContainsKey: false, requestContainsKey: false });
  });

  it("does not restore a local key when a different host puts the original host after @ in its path", async () => {
    const provider: OpenAICompatibleConfig = {
      type: "openai-compatible", id: "custom-llm-review", label: "Custom LLM",
      baseURL: "https://original-provider.example/v1", apiKey: SECRET,
      model: "model", systemPrompt: "Translate", ollamaCompatibility: false
    };
    const current = settingsWith(provider);
    const file = createSettingsBackup(current);
    const incoming = file.settings.providers.find(p => p.id === provider.id) as OpenAICompatibleConfig;
    incoming.baseURL = "https://different-provider.example/proxy@original-provider.example/v1";
    expect(new URL(incoming.baseURL).origin).toBe("https://different-provider.example");
    const parsed = parseSettingsBackup(JSON.stringify(file));
    const { settings: restored, skippedKeys } = mergeStoredKeys(parsed.settings, current);
    const fetchMock = capture({ choices: [{ message: { content: '["你好"]' } }] });
    await createProvider(restored.providers.find(p => p.id === provider.id)!)
      .translateBatch({ texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe("https://different-provider.example");
    expect({
      skippedKeys,
      sendsOriginalKey: new Headers(init.headers).get("Authorization") === `Bearer ${SECRET}`
    }).toEqual({ skippedKeys: 1, sendsOriginalKey: false });
  });
});
