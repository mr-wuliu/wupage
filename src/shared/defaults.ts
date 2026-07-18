import type { ExtensionSettings } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLang: "zh-CN",
  sourceLang: "auto",
  activeProviderId: "google-web-translate",
  chunkSize: 1200,
  concurrency: 3,
  cacheEnabled: true,
  floatingBallEnabled: true,
  providers: [
    {
      type: "google-web-translate",
      id: "google-web-translate",
      label: "Google Web Translate",
      enabled: true
    },
    {
      type: "microsoft-translator",
      id: "microsoft-translator",
      label: "Microsoft Translator",
      enabled: true,
      endpoint: "https://api.cognitive.microsofttranslator.com",
      apiKey: "",
      region: ""
    },
    {
      type: "google-cloud-translation",
      id: "google-cloud-translation",
      label: "Google Cloud Translation",
      enabled: true,
      apiKey: ""
    },
    {
      type: "openai-compatible",
      id: "openai-compatible",
      label: "OpenAI Compatible",
      enabled: true,
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      enabled: true,
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "",
      model: "glm-4-flash-250414",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "http-template",
      id: "http-template",
      label: "HTTP Template",
      enabled: true,
      method: "POST",
      url: "",
      headers: {
        "Content-Type": "application/json"
      },
      bodyTemplate:
        "{\"q\":{{json texts}},\"source\":\"{{sourceLang}}\",\"target\":\"{{targetLang}}\"}",
      responsePath: "translations"
    }
  ]
};

export const SETTINGS_KEY = "wupage.settings";
export const CACHE_PREFIX = "wupage.cache.";
export const BUILT_IN_PROVIDER_IDS = new Set(
  DEFAULT_SETTINGS.providers.map((provider) => provider.id)
);
