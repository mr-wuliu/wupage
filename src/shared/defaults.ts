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
      label: "Google Web Translate"
    },
    {
      type: "deepl-web",
      id: "deepl-web",
      label: "DeepL Web"
    },
    {
      type: "microsoft-translator",
      id: "microsoft-translator",
      label: "Microsoft Translator",
      endpoint: "https://api.cognitive.microsofttranslator.com",
      apiKey: "",
      region: ""
    },
    {
      type: "google-cloud-translation",
      id: "google-cloud-translation",
      label: "Google Cloud Translation",
      apiKey: ""
    },
    {
      type: "openai-compatible",
      id: "openai-compatible",
      label: "OpenAI Compatible",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "",
      model: "glm-4-flash-250414",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "http-template",
      id: "http-template",
      label: "HTTP Template",
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
