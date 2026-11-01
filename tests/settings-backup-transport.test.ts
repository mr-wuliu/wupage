import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import {
  createSettingsBackup,
  mergeStoredKeys,
  parseSettingsBackup
} from "../src/shared/settings-backup";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";

/**
 * The reported risks need the request side, not just the stored settings: what matters is the
 * bytes a provider puts on the wire. Fictional keys and a stubbed `fetch` keep this offline.
 */

const HTTP_SECRET = "http-template-secret";
const LLM_SECRET = "sk-llm-template-secret";

function httpTemplate(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: "http-template", id: "http-template", label: "HTTP Template", enabled: true, method: "POST",
    url: "https://endpoint.example/translate?api_key={{apiKey}}",
    headers: { "Content-Type": "application/json", Authorization: "Bearer {{apiKey}}" },
    bodyTemplate: '{"texts":{{json texts}},"target":"{{targetLang}}"}',
    responsePath: "translations",
    ...overrides
  } as ProviderConfig;
}

function llm(baseURL: string, apiKey: string): ProviderConfig {
  return {
    type: "openai-compatible", id: "custom-llm", label: "Custom LLM", baseURL, apiKey,
    model: "gpt-4o-mini", systemPrompt: "Translate to {{targetLang}}", ollamaCompatibility: false,
    requestTemplate: {
      enabled: true,
      headers: JSON.stringify({ "Content-Type": "application/json", "x-api-key": "{{apiKey}}" }),
      body: JSON.stringify({ model: "{{model}}", texts: "{{json texts}}" })
    }
  };
}

function settingsWith(providers: ProviderConfig[]): ExtensionSettings {
  return normalizeSettings({ ...DEFAULT_SETTINGS, activeProviderId: providers[0]!.id, providers });
}

/** Captures what the provider put on the wire, without letting a real socket exist. */
function captureFetch(answer: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(answer)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("settings backup transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends no stored credential when an HTTP Template is exported without keys", async () => {
    // Reported risk: the file said "without keys" while the custom carriers still held one.
    const current = settingsWith([httpTemplate({
      url: `https://user:${HTTP_SECRET}@endpoint.example/translate?api_key=${HTTP_SECRET}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HTTP_SECRET}` }
    })]);
    const file = createSettingsBackup(current);
    // The file itself: no fictional credential may survive, whatever field carries it.
    const written = JSON.stringify(file);
    expect(written).not.toContain(HTTP_SECRET);
    const restored = parseSettingsBackup(written).settings;
    const fetchMock = captureFetch({ translations: ["你好"] });
    const provider = createProvider(restored.providers.find((entry) => entry.id === "http-template")!);
    expect(provider.validateConfig()).toEqual({ ok: true });
    await expect(provider.translateBatch({ texts: ["Hello"], targetLang: "zh-CN" }))
      .resolves.toEqual(["你好"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(HTTP_SECRET);
    expect(url).not.toContain("user:");
    // A blanked header travels as an empty value, which is what the export wrote.
    expect(new Headers(init.headers).get("authorization") ?? "").not.toContain(HTTP_SECRET);
  });

  it("sends no stored credential when an LLM template is exported without keys", async () => {
    const current = settingsWith([llm("https://api.example.com/v1", "sk-restored-key")]);
    // A literal key in the saved template is the shape the report reproduced.
    const withLiteral = structuredClone(current);
    withLiteral.providers = withLiteral.providers.map((provider) => provider.id === "custom-llm"
      ? {
        ...provider, requestTemplate: {
          enabled: true,
          headers: JSON.stringify({ "Content-Type": "application/json", "x-api-key": LLM_SECRET }),
          body: JSON.stringify({ model: "{{model}}", texts: "{{json texts}}" })
        }
      } as ProviderConfig : provider);
    const written = JSON.stringify(createSettingsBackup(withLiteral));
    expect(written).not.toContain(LLM_SECRET);
    const restored = parseSettingsBackup(written).settings;
    const fetchMock = captureFetch({ choices: [{ message: { content: '["你好"]' } }] });
    const provider = createProvider(restored.providers.find((entry) => entry.id === "custom-llm")!);
    await expect(provider.translateBatch({ texts: ["Hello"], targetLang: "zh-CN" }))
      .resolves.toEqual(["你好"]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("x-api-key")).not.toContain(LLM_SECRET);
    expect(new Headers(init.headers).get("x-api-key")).toBe("");
  });

  it("stops sending this browser's key once the imported file moves the host", async () => {
    // Reported risk: the file kept the stored key and rewrote where it is sent.
    const current = settingsWith([llm("https://host-a.example/v1", "sk-stored-key")]);
    const fromFile = settingsWith([llm("https://host-b.example/v1", "sk-stored-key")]);
    const keyless = createSettingsBackup(fromFile).settings;
    const { settings: merged, skippedKeys } = mergeStoredKeys(keyless, current);
    expect(skippedKeys).toBe(1);
    const fetchMock = captureFetch({ choices: [{ message: { content: '["你好"]' } }] });
    const provider = createProvider(merged.providers.find((entry) => entry.id === "custom-llm")!);
    await expect(provider.translateBatch({ texts: ["Hello"], targetLang: "zh-CN" }))
      .resolves.toEqual(["你好"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The text is still sent to the new host; what must not travel is the old credential.
    expect(url).toBe("https://host-b.example/v1/chat/completions");
    // The key is blank in storage, so the blanket header no longer names a credential.
    expect(new Headers(init.headers).get("authorization") ?? "").not.toContain("sk-stored-key");
  });

  it("keeps sending the stored key when the file still names the same host", async () => {
    // The guard must not disarm a normal same-device restore.
    const current = settingsWith([llm("https://host-a.example/v1", "sk-stored-key")]);
    const keyless = createSettingsBackup(current).settings;
    const { settings: merged, restoredKeys, skippedKeys } = mergeStoredKeys(keyless, current);
    expect(restoredKeys).toBe(1);
    expect(skippedKeys).toBe(0);
    const fetchMock = captureFetch({ choices: [{ message: { content: '["你好"]' } }] });
    const provider = createProvider(merged.providers.find((entry) => entry.id === "custom-llm")!);
    await provider.translateBatch({ texts: ["Hello"], targetLang: "zh-CN" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-stored-key");
  });
});
