import { describe, expect, it } from "vitest";
import { normalizeSettings } from "../src/shared/settings";

describe("normalizeSettings", () => {
  it("uses defaults for invalid input", () => {
    const settings = normalizeSettings({
      targetLang: "",
      chunkSize: 99999,
      concurrency: -1,
      providers: []
    });

    expect(settings.targetLang).toBe("zh-CN");
    expect(settings.activeProviderId).toBe("google-web-translate");
    expect(settings.chunkSize).toBe(4000);
    expect(settings.concurrency).toBe(1);
    expect(settings.providers.length).toBeGreaterThan(0);
  });

  it("adds new built-in providers to older saved settings", () => {
    const settings = normalizeSettings({
      activeProviderId: "openai-compatible",
      providers: [
        {
          type: "openai-compatible",
          id: "openai-compatible",
          label: "OpenAI Compatible",
          baseURL: "https://example.com/v1",
          apiKey: "key",
          model: "model",
          systemPrompt: "Translate to {{targetLang}}"
        }
      ]
    });

    expect(settings.activeProviderId).toBe("openai-compatible");
    expect(settings.providers.find((provider) => provider.id === "openai-compatible"))
      .toMatchObject({
        performanceMode: "custom",
        chunkSize: 3200,
        concurrency: 3
      });
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      "google-web-translate",
      "microsoft-translator",
      "google-cloud-translation",
      "openai-compatible",
      "zhipu-glm",
      "http-template"
    ]);
  });

  it("preserves an explicit inherited provider performance mode", () => {
    const settings = normalizeSettings({
      chunkSize: 900,
      concurrency: 2,
      providers: [
        {
          type: "zhipu-glm",
          id: "zhipu-glm",
          label: "Zhipu GLM",
          performanceMode: "inherit",
          chunkSize: 3900,
          concurrency: 8,
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          apiKey: "",
          model: "glm-4-flash-250414",
          systemPrompt: "Translate to {{targetLang}}"
        }
      ]
    });

    expect(settings.providers.find((provider) => provider.id === "zhipu-glm"))
      .toMatchObject({ performanceMode: "inherit" });
    expect(settings.providers.find((provider) => provider.id === "zhipu-glm")?.chunkSize)
      .toBeUndefined();
  });

  it("preserves custom providers and falls back when the active provider is disabled", () => {
    const settings = normalizeSettings({
      activeProviderId: "openai-compatible",
      providers: [
        {
          type: "openai-compatible",
          id: "openai-compatible",
          label: "OpenAI Compatible",
          enabled: false,
          baseURL: "https://api.openai.com/v1",
          apiKey: "",
          model: "gpt-4o-mini",
          systemPrompt: "Translate to {{targetLang}}"
        },
        {
          type: "anthropic-compatible",
          id: "custom-anthropic-test",
          label: "Custom Anthropic",
          enabled: true,
          baseURL: "https://api.anthropic.com/v1",
          apiKey: "secret",
          model: "claude-test",
          systemPrompt: "Translate to {{targetLang}}"
        }
      ]
    });

    expect(settings.providers.find((provider) => provider.id === "openai-compatible")?.enabled)
      .toBe(false);
    expect(settings.providers.some((provider) => provider.id === "custom-anthropic-test")).toBe(true);
    expect(settings.activeProviderId).toBe("google-web-translate");
  });

  it("keeps at least one provider enabled", () => {
    const disabledProviders = normalizeSettings(undefined).providers.map((provider) => ({
      ...provider,
      enabled: false
    }));
    const settings = normalizeSettings({ providers: disabledProviders });

    expect(settings.providers.filter((provider) => provider.enabled !== false)).toHaveLength(1);
    expect(settings.activeProviderId).toBe("google-web-translate");
  });
});
