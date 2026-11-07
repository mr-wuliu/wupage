import type { ProviderConfig, TranslatorProvider } from "../shared/types";
import { translateLocally } from "./local";
import { supportsServiceMode, translationApiOptions } from "../shared/translation-service";
import { DoubaoProvider } from "./doubao";
import { MicrosoftTranslatorProvider, GoogleCloudTranslationProvider, CloudTranslationProvider, GoogleWebTranslateProvider, MicrosoftWebTranslateProvider, PublicTranslationProvider } from "./providers/services";
import { OpenAICompatibleProvider, AnthropicCompatibleProvider, DeepSeekProvider, ZhipuGlmProvider } from "./providers/llm";
import { HttpTemplateProvider } from "./providers/http-template";
import { DeepLProvider } from "./providers/deepl";

export function createProvider(config: ProviderConfig): TranslatorProvider {
  if (supportsServiceMode(config) && config.serviceMode === "api") {
    const api = translationApiOptions(config);
    if (config.type === "microsoft-web-translate") return new MicrosoftTranslatorProvider({
      ...config, type: "microsoft-translator", endpoint: api.endpoint ?? "", apiKey: api.apiKey ?? "", region: api.region ?? ""
    });
    if (config.type === "google-web-translate") return new GoogleCloudTranslationProvider({
      ...config, type: "google-cloud-translation", apiKey: api.apiKey ?? ""
    });
    if (config.type !== "mymemory") return new CloudTranslationProvider(config);
  }
  if (config.type === "doubao-web") return new DoubaoProvider(config);
  if (config.type === "firefox-local") return {
    id: config.id, label: config.label,
    validateConfig: () => ({ ok: true }),
    translateBatch: translateLocally
  };
  if (config.type === "google-web-translate") return new GoogleWebTranslateProvider(config);
  if (config.type === "microsoft-web-translate") return new MicrosoftWebTranslateProvider(config);
  if (config.type === "tencent-transmart" || config.type === "yandex-web-translate"
    || config.type === "volcengine-web-translate" || config.type === "mymemory") {
    return new PublicTranslationProvider(config);
  }
  if (config.type === "microsoft-translator") return new MicrosoftTranslatorProvider(config);
  if (config.type === "google-cloud-translation") {
    return new GoogleCloudTranslationProvider(config);
  }
  if (config.type === "deepl") return new DeepLProvider(config);
  if (config.type === "openai-compatible" || config.type === "index-translate") return new OpenAICompatibleProvider(config);
  if (config.type === "anthropic-compatible") return new AnthropicCompatibleProvider(config);
  if (config.type === "deepseek") return new DeepSeekProvider(config);
  if (config.type === "zhipu-glm") return new ZhipuGlmProvider(config);
  return new HttpTemplateProvider(config);
}
