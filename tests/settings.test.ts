import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../src/shared/defaults";
import { getEffectiveProviderPerformance } from "../src/shared/performance";
import { getSettings, normalizeSettings, saveSettings } from "../src/shared/settings";

afterEach(() => { vi.unstubAllGlobals(); });

describe("normalizeSettings", () => {
  it("keeps custom model choices without losing provider credentials", () => {
    const settings = normalizeSettings({
      activeProviderId: "deepseek",
      providers: [{ type: "deepseek", id: "deepseek", label: "DeepSeek",
        baseURL: "https://example.com/v1", apiKey: "saved-key", model: "custom-model", systemPrompt: "Translate",
        customModels: [" custom-model ", "", "custom-model", false, null, "another-model"] }]
    });
    expect(settings.providers.find((provider) => provider.id === "deepseek")).toMatchObject({
      model: "custom-model", customModels: ["custom-model", "another-model"], apiKey: "saved-key"
    });
  });
  it("uses defaults for invalid input", () => {
    const settings = normalizeSettings({
      targetLang: "",
      chunkSize: 99999,
      concurrency: -1,
      providers: []
    });

    expect(settings.targetLang).toBe("zh-CN");
    expect(settings.activeProviderId).toBe("microsoft-web-translate");
    expect(settings.chunkSize).toBe(4000);
    expect(settings.concurrency).toBe(1);
    expect(settings.translateCodeComments).toBe(true);
    expect(settings.imageTranslationEnabled).toBe(false);
    expect(settings.translationDisplayMode).toBe("bilingual");
    expect(settings.providers.length).toBeGreaterThan(0);
  });

  it("preserves a disabled code comment translation setting", () => {
    expect(normalizeSettings({ translateCodeComments: false }).translateCodeComments).toBe(false);
  });

  it("defaults older PDF settings to five pages on each side and supports current-page-only and unlimited", () => {
    expect(normalizeSettings({}).pdfTranslationPageRadius).toBe(5);
    expect(normalizeSettings({ pdfTranslationPageRadius: 0 }).pdfTranslationPageRadius).toBe(0);
    expect(normalizeSettings({ pdfTranslationPageRadius: 12 }).pdfTranslationPageRadius).toBe(12);
    expect(normalizeSettings({ pdfTranslationPageRadius: null }).pdfTranslationPageRadius).toBeNull();
    expect(normalizeSettings({ pdfTranslationPageRadius: -3 }).pdfTranslationPageRadius).toBe(0);
    expect(normalizeSettings({ pdfTranslationPageRadius: 2.7 }).pdfTranslationPageRadius).toBe(3);
    for (const invalid of ["unlimited", "5", false, NaN, Infinity]) {
      expect(normalizeSettings({ pdfTranslationPageRadius: invalid }).pdfTranslationPageRadius).toBe(5);
    }
  });
  it("only enables image translation with an explicit boolean switch", () => {
    expect(normalizeSettings({ imageTranslationEnabled: true }).imageTranslationEnabled).toBe(true);
    expect(normalizeSettings({ imageTranslationEnabled: "true" }).imageTranslationEnabled).toBe(false);
  });

  it("preserves valid translation display modes and rejects unknown values", () => {
    expect(normalizeSettings({ translationDisplayMode: "replace" }).translationDisplayMode)
      .toBe("replace");
    expect(normalizeSettings({ translationDisplayMode: "bilingual-accent" }).translationDisplayMode)
      .toBe("bilingual-accent");
    expect(normalizeSettings({ translationDisplayMode: "unknown" }).translationDisplayMode)
      .toBe("bilingual");
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
    expect(settings.providers.find((provider) => provider.id === "doubao-web"))
      .toMatchObject({ enabled: true, chunkSize: 1200, concurrency: 1 });
    expect(settings.providers.find((provider) => provider.id === "openai-compatible"))
      .toMatchObject({
        performanceMode: "custom",
        chunkSize: 3200,
        concurrency: 5
      });
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      "microsoft-web-translate",
      "google-web-translate",
      "doubao-web",
      "tencent-transmart",
      "yandex-web-translate",
      "volcengine-web-translate",
      "mymemory",
      "deepl",
      "index-translate",
      "openai-compatible",
      "deepseek",
      "zhipu-glm",
      "http-template",
      "firefox-local"
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

  it.each(["google-web-translate", "microsoft-translator", "deepseek"])(
    "migrates legacy Azure credentials while preserving the selected service %s", (activeProviderId) => {
      const settings = normalizeSettings({
        activeProviderId,
        providers: [{
          type: "microsoft-translator", id: "microsoft-translator", label: "My Azure",
          endpoint: "https://api.cognitive.microsofttranslator.com", apiKey: "saved-key", region: "eastasia"
        }]
      });
      expect(settings.activeProviderId).toBe(activeProviderId === "microsoft-translator" ? "microsoft-web-translate" : activeProviderId);
      expect(settings.providers.find((entry) => entry.id === "microsoft-web-translate"))
        .toMatchObject({ type: "microsoft-web-translate", enabled: true });
      for (const id of ["tencent-transmart", "yandex-web-translate", "volcengine-web-translate", "mymemory"]) {
        expect(settings.providers.find(entry => entry.id === id)).toMatchObject({ type: id, enabled: true });
      }
      expect(settings.providers.find((entry) => entry.id === "microsoft-web-translate"))
        .toMatchObject({ serviceMode: activeProviderId === "microsoft-translator" ? "api" : "free",
          api: { apiKey: "saved-key", region: "eastasia" } });
      expect(settings.providers.some(entry => entry.id === "microsoft-translator")).toBe(false);
    }
  );

  it.each([
    ["deepseek-v4-flash", "deepseek-flash"],
    ["deepseek-v4-flash-vision-exp", "deepseek-flash"],
    ["deepseek-flash", "deepseek-flash"],
    ["deepseek-v4-pro", "deepseek-v4-pro"],
    ["custom-model", "custom-model"]
  ])("normalizes saved DeepSeek model %s to %s", (model, expectedModel) => {
    const saved = normalizeSettings(undefined).providers.find((provider) => provider.type === "deepseek")!;
    const settings = normalizeSettings({
      activeProviderId: saved.id,
      providers: [{ ...saved, model, apiKey: "saved-key", baseURL: "https://example.com/v1" }]
    });

    expect(settings.activeProviderId).toBe(saved.id);
    expect(settings.providers.find((provider) => provider.id === saved.id)).toMatchObject({
      model: expectedModel,
      apiKey: "saved-key",
      baseURL: "https://example.com/v1"
    });
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
    expect(settings.activeProviderId).toBe("microsoft-web-translate");
  });

  it("keeps at least one provider enabled", () => {
    const disabledProviders = normalizeSettings(undefined).providers.map((provider) => ({
      ...provider,
      enabled: false
    }));
    const settings = normalizeSettings({ providers: disabledProviders });

    expect(settings.providers.filter((provider) => provider.enabled !== false)).toHaveLength(1);
    expect(settings.activeProviderId).toBe("microsoft-web-translate");
  });

  it.each([true, false, undefined, "true"])("defaults Ollama compatibility on and preserves explicit opt-out: %s", (value) => {
    const saved = normalizeSettings(undefined).providers.find((provider) => provider.type === "openai-compatible")!;
    const settings = normalizeSettings({ providers: [{ ...saved, ollamaCompatibility: value }] });
    const provider = settings.providers.find((entry) => entry.type === "openai-compatible");
    expect(provider?.type === "openai-compatible" && provider.ollamaCompatibility)
      .toBe(value !== false);
  });
});

describe("Doubao settings migration", () => {
  it("retains an explicitly selected Doubao configuration across normalization", () => {
    const normalized = normalizeSettings({
      activeProviderId: "my-doubao",
      providers: [{ type: "doubao-web", id: "my-doubao", label: "我的豆包", enabled: true }]
    });

    expect(normalized.activeProviderId).toBe("my-doubao");
    expect(normalized.providers.find((provider) => provider.id === "my-doubao"))
      .toMatchObject({ type: "doubao-web", label: "我的豆包", enabled: true });
    expect(normalizeSettings(normalized)).toEqual(normalized);
  });

  it("updates the previous built-in label without overwriting custom names", () => {
    const previousLabel = "豆包（网页登录，实验）";
    const result = normalizeSettings({
      activeProviderId: "doubao-web",
      providers: [
        { type: "doubao-web", id: "doubao-web", label: previousLabel, enabled: false },
        { type: "doubao-web", id: "my-doubao", label: previousLabel }
      ]
    });
    expect(result.providers.find((provider) => provider.id === "doubao-web"))
      .toMatchObject({ label: "豆包（实验性）", enabled: false });
    expect(result.providers.find((provider) => provider.id === "my-doubao")?.label).toBe(previousLabel);
    const renamed = normalizeSettings({
      providers: [{ type: "doubao-web", id: "doubao-web", label: "我的豆包" }]
    });
    expect(renamed.providers.find((provider) => provider.id === "doubao-web")?.label).toBe("我的豆包");
    expect(normalizeSettings(result)).toEqual(result);
  });

  it("preserves disabled Doubao through storage round trips and discards unsupported credential fields", async () => {
    let saved: unknown = {
      activeProviderId: "google-web-translate",
      providers: [{
        type: "doubao-web", id: "doubao-web", label: "豆包", enabled: false,
        apiKey: "not-a-supported-field", cookie: "not-a-supported-field", webId: "not-a-supported-field"
      }]
    };
    const set = vi.fn(async (value: Record<string, unknown>) => { saved = value[SETTINGS_KEY]; });
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async () => ({ [SETTINGS_KEY]: saved })), set
    } } });

    const loaded = await getSettings();
    await saveSettings(loaded);
    const reloaded = await getSettings();

    expect(reloaded.activeProviderId).toBe("google-web-translate");
    expect(reloaded.providers.find((provider) => provider.id === "doubao-web")).toEqual({
      type: "doubao-web", id: "doubao-web", label: "豆包", enabled: false,
      performanceMode: "custom", chunkSize: 1200, concurrency: 1
    });
    expect(reloaded).toEqual(loaded);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("keeps Doubao conservative when legacy global settings or edited provider fields request more concurrency", () => {
    const result = normalizeSettings({
      activeProviderId: "doubao-web", chunkSize: 4000, concurrency: 8,
      providers: [{
        type: "doubao-web", id: "doubao-web", label: "豆包", enabled: true,
        performanceMode: "inherit", chunkSize: 4000, concurrency: 8
      }]
    });

    expect(getEffectiveProviderPerformance(result)).toEqual({
      performanceMode: "custom", chunkSize: 1200, concurrency: 1
    });
    expect(result.chunkSize).toBe(4000);
    expect(result.concurrency).toBe(8);
    expect(getEffectiveProviderPerformance(result, "google-web-translate").concurrency).toBe(8);
  });
});
