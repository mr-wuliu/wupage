import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, mergeStoredKeys, parseSettingsBackup, settingsBackupHasKeys } from "../src/shared/settings-backup";
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
  it.each(["api_key", "key", "auth_key", "KEY", "auth%5Fkey"])("removes %s credentials saved in an LLM Base URL from the default backup", async (name) => {
    const provider = llm(`https://llm.example/v1?${name}=${SECRET}`);
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
      requestContainsKey: requestUrl.searchParams.get(decodeURIComponent(name)) === SECRET
    }).toEqual({ fileContainsKey: false, requestContainsKey: false });
  });

  it.each([
    "https://sk-translation-gateway.example/v1",
    "https://llm.example/sk-translation-route/v1",
    "https://sk-translation-gateway.example/sk-translation-route?model=sk-public-model#sk-public-section"
  ])("preserves the public URL components in %s", (baseURL) => {
    const current = settingsWith(llm(baseURL, SECRET));
    const file = createSettingsBackup(current);
    const exported = file.settings.providers.find(p => p.id === "custom-llm-review") as OpenAICompatibleConfig;
    expect(exported.baseURL).toBe(baseURL);
    const restored = mergeStoredKeys(parseSettingsBackup(JSON.stringify(file)).settings, current);
    expect(restored.skippedKeys).toBe(0);
    expect(restored.restoredKeys).toBe(1);
    expect(restored.settings.providers.find(p => p.id === exported.id)).toEqual(current.providers.find(p => p.id === exported.id));
  });

  it.each(["key", "auth_key"])("detects and restores a %s URL credential only for the same receiver", (name) => {
    const provider = llm(`https://llm.example/v1?${name}=${SECRET}&model=public`);
    const current = settingsWith(provider);
    expect(settingsBackupHasKeys(current)).toBe(true);
    const file = createSettingsBackup(current);
    expect(settingsBackupHasKeys(file.settings)).toBe(false);
    const exported = file.settings.providers.find(p => p.id === provider.id) as OpenAICompatibleConfig;
    expect(exported.baseURL).toBe(`https://llm.example/v1?${name}=&model=public`);
    const restored = mergeStoredKeys(parseSettingsBackup(JSON.stringify(file)).settings, current);
    expect(restored.restoredKeys).toBe(1);
    expect(restored.settings.providers.find(p => p.id === provider.id)).toEqual(current.providers.find(p => p.id === provider.id));
    const included = createSettingsBackup(current, new Date(), { includesKeys: true });
    expect(included.settings.providers.find(p => p.id === provider.id)).toEqual(current.providers.find(p => p.id === provider.id));
    exported.baseURL = `https://different-provider.example/v1?${name}=&model=public`;
    const moved = mergeStoredKeys(file.settings, current);
    expect(moved.skippedKeys).toBe(1);
    expect(JSON.stringify(moved.settings)).not.toContain(SECRET);
  });

  it("strips userinfo and repeated authentication parameters while preserving public URL text", () => {
    const baseURL = `https://user:${SECRET}@sk-translation-gateway.example/sk-public-route?key=${SECRET}&key=${SECRET}&auth_key=${SECRET}&model=sk-public-model#sk-public-section`;
    const file = createSettingsBackup(settingsWith(llm(baseURL)));
    const exported = file.settings.providers.find(p => p.id === "custom-llm-review") as OpenAICompatibleConfig;
    expect(exported.baseURL).toBe("https://sk-translation-gateway.example/sk-public-route?key=&key=&auth_key=&model=sk-public-model#sk-public-section");
    expect(settingsBackupHasKeys(file.settings)).toBe(false);
  });

  it("preserves a non-authentication key member in a request body", () => {
    const provider = llm("https://llm.example/v1");
    provider.requestTemplate = { enabled: true, headers: "{}", body: '{"key":"public-field-name","texts":{{json texts}}}' };
    const file = createSettingsBackup(settingsWith(provider));
    const exported = file.settings.providers.find(p => p.id === provider.id) as OpenAICompatibleConfig;
    expect(exported.requestTemplate?.body).toBe(provider.requestTemplate.body);
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
