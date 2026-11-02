import type { ExtensionSettings } from "./types";
import { DEFAULT_SELECTION_TRANSLATION } from "./dictionary";
import { DEFAULT_APPEARANCE } from "./appearance";
import { DEFAULT_SHORTCUTS, DEFAULT_SHORTCUT_ENABLED } from "./shortcuts";
import { DEFAULT_LOCAL_SHORTCUTS } from "./local-shortcuts";
import { DEFAULT_INPUT_TRANSLATION } from "./input-translation";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  shortcuts: { ...DEFAULT_SHORTCUTS },
  localShortcuts: { ...DEFAULT_LOCAL_SHORTCUTS },
  shortcutEnabled: { ...DEFAULT_SHORTCUT_ENABLED },
  appearance: { ...DEFAULT_APPEARANCE, customSchemes: [] },
  selectionTranslation: { ...DEFAULT_SELECTION_TRANSLATION },
  inputTranslation: { ...DEFAULT_INPUT_TRANSLATION },
  autoTranslation: { enabled: false, nonTargetLanguage: false, presetSites: [], customSites: [] },
  frameTranslation: { enabled: true, excludeMatches: [] },
  targetLang: "zh-CN",
  sourceLang: "auto",
  activeProviderId: "microsoft-web-translate",
  chunkSize: 1200,
  concurrency: 3,
  pdfTranslationPageRadius: 5,
  cacheEnabled: true,
  statisticsEnabled: false,
  floatingBallEnabled: true,
  contextMenuTranslationEnabled: false,
  imageTranslationEnabled: false,
  translateCodeComments: true,
  translationDisplayMode: "bilingual",
  providers: [
    {
      type: "microsoft-web-translate",
      id: "microsoft-web-translate",
      label: "Microsoft 翻译",
      enabled: true
    },
    {
      type: "google-web-translate",
      id: "google-web-translate",
      label: "Google 翻译",
      enabled: true
    },
    {
      type: "doubao-web",
      id: "doubao-web",
      label: "豆包（实验性）",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 1200,
      concurrency: 1
    },
    {
      type: "tencent-transmart",
      id: "tencent-transmart",
      label: "腾讯翻译",
      enabled: true
    },
    {
      type: "yandex-web-translate",
      id: "yandex-web-translate",
      label: "Yandex 翻译",
      enabled: true
    },
    {
      type: "volcengine-web-translate",
      id: "volcengine-web-translate",
      label: "火山翻译",
      enabled: true
    },
    {
      type: "mymemory",
      id: "mymemory",
      label: "MyMemory",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 400,
      concurrency: 1
    },
    {
      type: "openai-compatible",
      id: "openai-compatible",
      label: "OpenAI Compatible",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 3200,
      concurrency: 3,
      baseURL: "https://api.openai.com/v1",
      ollamaCompatibility: true,
      apiKey: "",
      model: "gpt-4o-mini",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "deepseek",
      id: "deepseek",
      label: "DeepSeek",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 3200,
      concurrency: 3,
      baseURL: "https://api.deepseek.com",
      apiKey: "",
      model: "deepseek-flash",
      systemPrompt:
        "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order."
    },
    {
      type: "zhipu-glm",
      id: "zhipu-glm",
      label: "Zhipu GLM",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 3200,
      concurrency: 3,
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
    },
    {
      type: "firefox-local",
      id: "firefox-local",
      label: "Firefox 本地翻译（实验）",
      enabled: true,
      performanceMode: "custom",
      chunkSize: 800,
      concurrency: 1
    }
  ]
};

export const SETTINGS_KEY = "wupage.settings";
export const CACHE_PREFIX = "wupage.cache.";
export const BUILT_IN_PROVIDER_IDS = new Set(
  DEFAULT_SETTINGS.providers.map((provider) => provider.id)
);
