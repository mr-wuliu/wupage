import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { normalizeSettings } from "../src/shared/settings";
import type { ProviderConfig } from "../src/shared/types";

const base = {
  id: "custom", label: "Custom", baseURL: "https://example.com/v1", apiKey: "test-key",
  model: "custom-model", systemPrompt: "Translate to {{targetLang}}", ollamaCompatibility: false,
  requestTemplate: { enabled: true, headers: '{"x-opencode-session":"wupage","Authorization":"Bearer {{apiKey}}"}',
    body: '{"enable_thinking":false,"thinking":{"type":"enabled"},"temperature":null,"max_tokens":1234}' }
};

describe("provider request template transport", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(["openai-compatible", "deepseek", "zhipu-glm", "anthropic-compatible"] as const)(
    "applies saved headers and body for %s", async type => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(type === "anthropic-compatible"
        ? { content: [{ type: "text", text: '["你好"]' }] }
        : { choices: [{ message: { content: '["你好"]' } }] })));
      vi.stubGlobal("fetch", fetchMock);
      const saved = normalizeSettings({ providers: [{ ...base, type }] });
      const provider = createProvider(saved.providers.find(entry => entry.id === base.id)!);
      expect(provider.validateConfig()).toEqual({ ok: true });
      await expect(provider.translateBatch({ texts: ['Hello "world"\n!'], targetLang: "zh-CN", context: "A page" }))
        .resolves.toEqual(["你好"]);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(type === "anthropic-compatible" ? "https://example.com/v1/messages" : "https://example.com/v1/chat/completions");
      const headers = new Headers(init.headers);
      expect(headers.get("x-opencode-session")).toBe("wupage");
      expect(headers.get("authorization")).toBe("Bearer test-key");
      expect(headers.get("content-type")).toBe("application/json");
      if (type === "anthropic-compatible") expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: base.model, enable_thinking: false, thinking: { type: "enabled" }, max_tokens: 1234 });
      expect(body).not.toHaveProperty("temperature");
      const messages = body.messages;
      expect(JSON.parse(messages.at(-1).content)).toMatchObject({ texts: ['Hello "world"\n!'], context: "A page" });
    }
  );

  it("uses defaults when overrides are disabled, while retaining them in storage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '["你好"]' } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...base, type: "deepseek" as const, requestTemplate: { ...base.requestTemplate, enabled: false } };
    await createProvider(config).translateBatch({ texts: ["Hello"], targetLang: "zh-CN" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("x-opencode-session")).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({ temperature: 0, thinking: { type: "disabled" } });
    expect(normalizeSettings({ providers: [config] }).providers.find(entry => entry.id === base.id)).toMatchObject({ requestTemplate: config.requestTemplate });
  });

  it.each(["openai-compatible", "deepseek", "zhipu-glm", "anthropic-compatible"] as const)(
    "rejects invalid %s templates before sending text", async type => {
      const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
      const config: ProviderConfig = { ...base, type, requestTemplate: { ...base.requestTemplate, body: '{"stream":true}' } };
      expect(createProvider(config).validateConfig().ok).toBe(false);
      await expect(createProvider(config).translateBatch({ texts: ["Hello"], targetLang: "zh-CN" })).rejects.toThrow("非流式");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

});
