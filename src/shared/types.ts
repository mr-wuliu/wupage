export type ProviderType =
  | "firefox-local"
  | "microsoft-web-translate"
  | "google-web-translate"
  | "tencent-transmart"
  | "yandex-web-translate"
  | "volcengine-web-translate"
  | "mymemory"
  | "microsoft-translator"
  | "google-cloud-translation"
  | "openai-compatible"
  | "anthropic-compatible"
  | "deepseek"
  | "zhipu-glm"
  | "http-template";

export type TranslationDisplayMode = "replace" | "bilingual" | "bilingual-accent";

export interface ProviderBaseConfig {
  id: string;
  label: string;
  enabled?: boolean;
  performanceMode?: "inherit" | "custom";
  chunkSize?: number;
  concurrency?: number;
  /** Additional model IDs saved for this provider. */
  customModels?: string[];
}

export interface TranslationApiOptions {
  apiKey?: string;
  endpoint?: string;
  region?: string;
  folderId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  model?: string;
}

export interface DualServiceConfig extends ProviderBaseConfig {
  serviceMode?: "free" | "api";
  api?: TranslationApiOptions;
}

export interface GoogleWebTranslateConfig extends DualServiceConfig {
  type: "google-web-translate";
}

export interface MicrosoftWebTranslateConfig extends DualServiceConfig {
  type: "microsoft-web-translate";
}

export interface TencentTransmartConfig extends DualServiceConfig {
  type: "tencent-transmart";
}

export interface YandexWebTranslateConfig extends DualServiceConfig {
  type: "yandex-web-translate";
}

export interface VolcengineWebTranslateConfig extends DualServiceConfig {
  type: "volcengine-web-translate";
}

export interface MyMemoryConfig extends DualServiceConfig {
  type: "mymemory";
}

export interface FirefoxLocalConfig extends ProviderBaseConfig {
  type: "firefox-local";
}

export interface MicrosoftTranslatorConfig extends ProviderBaseConfig {
  type: "microsoft-translator";
  endpoint: string;
  apiKey: string;
  region: string;
}

export interface GoogleCloudTranslationConfig extends ProviderBaseConfig {
  type: "google-cloud-translation";
  apiKey: string;
}

export interface OpenAICompatibleConfig extends ProviderBaseConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Enabled by default, including for settings saved before this option existed. */
  ollamaCompatibility?: boolean;
}

export interface AnthropicCompatibleConfig extends ProviderBaseConfig {
  type: "anthropic-compatible";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface DeepSeekConfig extends ProviderBaseConfig {
  type: "deepseek";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface ZhipuGlmConfig extends ProviderBaseConfig {
  type: "zhipu-glm";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface HttpTemplateConfig extends ProviderBaseConfig {
  type: "http-template";
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  responsePath: string;
}

export type ProviderConfig =
  | FirefoxLocalConfig
  | MicrosoftWebTranslateConfig
  | GoogleWebTranslateConfig
  | TencentTransmartConfig
  | YandexWebTranslateConfig
  | VolcengineWebTranslateConfig
  | MyMemoryConfig
  | MicrosoftTranslatorConfig
  | GoogleCloudTranslationConfig
  | OpenAICompatibleConfig
  | AnthropicCompatibleConfig
  | DeepSeekConfig
  | ZhipuGlmConfig
  | HttpTemplateConfig;

export type DualServiceProviderConfig = Extract<ProviderConfig, DualServiceConfig & {
  type: "microsoft-web-translate" | "google-web-translate" | "tencent-transmart"
    | "yandex-web-translate" | "volcengine-web-translate" | "mymemory";
}>;

export interface SelectionTranslationSettings {
  showIcon: boolean;
  /** Empty disables keyboard activation. */
  shortcut: string;
}

export interface ExtensionSettings {
  selectionTranslation?: SelectionTranslationSettings;
  autoTranslation?: AutoTranslationSettings;
  targetLang: string;
  sourceLang: string;
  activeProviderId: string;
  chunkSize: number;
  concurrency: number;
  /** Pages to translate on each side of the reading page; null means the whole PDF. */
  pdfTranslationPageRadius: number | null;
  cacheEnabled: boolean;
  floatingBallEnabled: boolean;
  imageTranslationEnabled?: boolean;
  translateCodeComments: boolean;
  translationDisplayMode: TranslationDisplayMode;
  providers: ProviderConfig[];
}

export interface AutoTranslationSite {
  id: string;
  pattern: string;
  enabled: boolean;
}

export interface AutoTranslationSettings {
  enabled: boolean;
  nonTargetLanguage: boolean;
  presetSites: string[];
  customSites: AutoTranslationSite[];
  removedPresetSites?: string[];
}

export interface TranslateBatchRequest {
  texts: string[];
  /** Verify protected PDF formula markers before caching a translation. */
  preservePlaceholders?: boolean;
  context?: string;
  sourceLang?: string;
  targetLang: string;
  providerId?: string;
}

export interface TranslateBatchResponse {
  translations: string[];
  cached: number;
}

export interface ImageTextRegion {
  box: [number, number, number, number]; // x, y, width, height, normalized to 0–1000
  text: string;
  translation: string;
  foreground: string;
  background: string;
  align: "left" | "center" | "right";
  bold: boolean;
  sampleColors?: boolean;
}

export interface TranslateImageRequest {
  dataUrl: string;
  width: number;
  height: number;
  sourceText?: string;
}

export interface TranslateImageResponse {
  regions: ImageTextRegion[];
  targetLang: string;
  cached: boolean;
  warning?: string;
  skippedRegions?: number;
}

export type TranslationDebugTaskStatus = "queued" | "waiting" | "running" | "succeeded" | "failed";

export interface TranslationDebugTask {
  id: number;
  providerId: string;
  providerLabel: string;
  status: TranslationDebugTaskStatus;
  textCount: number;
  charCount: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  waitUntil?: number;
  sourceLang?: string;
  targetLang?: string;
  chunkSize?: number;
  concurrency?: number;
  performanceMode?: "inherit" | "custom";
  sourceTexts?: string[];
  translatedTexts?: string[];
  error?: string;
}

export interface TranslationDebugSnapshot {
  tasks: TranslationDebugTask[];
  activeCount: number;
  queuedCount: number;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export interface TranslatorProvider {
  id: string;
  label: string;
  translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]>;
  validateConfig(): ValidationResult;
}

export type RuntimeRequest =
  | { type: "GET_LOCAL_MODEL_STATUS" }
  | { type: "INSTALL_LOCAL_MODEL"; modelId: string }
  | { type: "CANCEL_LOCAL_MODEL_DOWNLOAD" }
  | { type: "REMOVE_LOCAL_MODEL"; modelId: string }
  | { type: "GET_OCR_STATUS" }
  | { type: "INSTALL_OCR" }
  | { type: "REMOVE_OCR" }
  | { type: "TRANSLATE_PAGE" }
  | { type: "CLEAR_TRANSLATION" }
  | { type: "GET_TRANSLATION_STATE" }
  | { type: "GET_PARAGRAPH_MODE" }
  | { type: "SET_PARAGRAPH_MODE"; enabled: boolean }
  | { type: "GET_FLOATING_BALL" }
  | { type: "SET_FLOATING_BALL"; enabled: boolean }
  | { type: "OPEN_TRANSLATION_DEBUG" }
  | { type: "GET_TRANSLATION_DEBUG" }
  | { type: "CLEAR_CACHE" }
  | { type: "LOAD_IMAGE"; url: string }
  | { type: "TRANSLATE_CONTEXT_IMAGE"; srcUrl: string }
  | ({ type: "TRANSLATE_IMAGE" } & TranslateImageRequest)
  | ({ type: "TRANSLATE_BATCH" } & TranslateBatchRequest)
  | { type: "GET_SETTINGS" }
  | { type: "OPEN_OPTIONS_PAGE" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "TEST_PROVIDER"; providerId?: string };

export type RuntimeResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };
