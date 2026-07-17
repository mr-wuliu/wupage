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
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      "google-web-translate",
      "microsoft-translator",
      "google-cloud-translation",
      "openai-compatible",
      "zhipu-glm",
      "http-template"
    ]);
  });
});
