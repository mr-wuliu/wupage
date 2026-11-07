import type { DictionaryProvider, SelectionTranslationSettings } from "./dictionary";
import type { AppearanceSettings } from "./appearance";
import type { VideoTranslationSettings } from "./video";
import type { ShortcutEnabledSettings, ShortcutSettings, TranslationShortcut } from "./shortcuts";
import type { InterfaceLanguage } from "./i18n";

export type ProviderType =
  | "doubao-web"
  | "firefox-local"
  | "microsoft-web-translate"
  | "google-web-translate"
  | "tencent-transmart"
  | "yandex-web-translate"
  | "volcengine-web-translate"
  | "mymemory"
  | "microsoft-translator"
  | "google-cloud-translation"
  | "deepl"
  | "index-translate"
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

export interface DoubaoWebConfig extends ProviderBaseConfig {
  type: "doubao-web";
}

export type DoubaoStatusState = "unknown" | "checking" | "ready" | "login-required"
  | "rate-limited" | "service-rejected" | "permission-required" | "network-error"
  | "timeout" | "protocol-changed" | "incomplete" | "unsupported-browser" | "unsupported-language";

export interface DoubaoStatus {
  state: DoubaoStatusState;
  checkedAt?: number;
  message?: string;
  retryAt?: number;
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

export interface DeepLConfig extends ProviderBaseConfig {
  type: "deepl";
  /** Empty selects the official Free/Pro endpoint from the API key. */
  endpoint: string;
  apiKey: string;
}

export interface LlmRequestTemplate {
  enabled: boolean;
  /** JSON object: string values override headers; null removes them. */
  headers: string;
  /** JSON merge patch applied to the generated request body. */
  body: string;
}

export interface LlmProviderBaseConfig extends ProviderBaseConfig {
  requestTemplate?: LlmRequestTemplate;
}

export interface OpenAICompatibleConfig extends LlmProviderBaseConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Enabled by default, including for settings saved before this option existed. */
  ollamaCompatibility?: boolean;
}

export interface AnthropicCompatibleConfig extends LlmProviderBaseConfig {
  type: "anthropic-compatible";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface DeepSeekConfig extends LlmProviderBaseConfig {
  type: "deepseek";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface ZhipuGlmConfig extends LlmProviderBaseConfig {
  type: "zhipu-glm";
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface IndexTranslateConfig extends LlmProviderBaseConfig {
  type: "index-translate";
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
  | DoubaoWebConfig
  | FirefoxLocalConfig
  | MicrosoftWebTranslateConfig
  | GoogleWebTranslateConfig
  | TencentTransmartConfig
  | YandexWebTranslateConfig
  | VolcengineWebTranslateConfig
  | MyMemoryConfig
  | MicrosoftTranslatorConfig
  | GoogleCloudTranslationConfig
  | DeepLConfig
  | IndexTranslateConfig
  | OpenAICompatibleConfig
  | AnthropicCompatibleConfig
  | DeepSeekConfig
  | ZhipuGlmConfig
  | HttpTemplateConfig;

export type DualServiceProviderConfig = Extract<ProviderConfig, DualServiceConfig & {
  type: "microsoft-web-translate" | "google-web-translate" | "tencent-transmart"
    | "yandex-web-translate" | "volcengine-web-translate" | "mymemory";
}>;

export interface ExtensionSettings {
  elementExclusions?: import("./element-exclusions").ElementExclusionRule[];
  frameTranslation?: import("./frame-session").FrameTranslationSettings;
  videoTranslation?: VideoTranslationSettings;
  shortcuts?: ShortcutSettings;
  localShortcuts?: import("./local-shortcuts").LocalShortcutSettings;
  shortcutEnabled?: ShortcutEnabledSettings;
  appearance?: AppearanceSettings;
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
  /** Local usage statistics are collected only after explicit opt-in. */
  statisticsEnabled?: boolean;
  floatingBallEnabled: boolean;
  contextMenuTranslationEnabled?: boolean;
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
  excludedSites?: string[];
}

export interface TranslateBatchRequest {
  pageSession?: { id: string; documentKey: string };
  texts: string[];
  /** Verify protected PDF formula markers before caching a translation. */
  preservePlaceholders?: boolean;
  /** Apply academic prose guidance without changing ordinary webpage translation. */
  translationStyle?: "academic";
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
  frames?: import("./frame-session").FrameDiagnostic[];
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
  translateBatch(request: TranslateBatchRequest, signal?: AbortSignal, onUsage?: (payload: unknown) => void): Promise<string[]>;
  validateConfig(): ValidationResult;
}

export type RuntimeRequest =
  | import("./frame-session").FrameSessionRequest
  | { type: "EXECUTE_TRANSLATION_SHORTCUT"; command: TranslationShortcut }
  | { type: "LOOKUP_DICTIONARY"; query: string; provider: DictionaryProvider }
  | { type: "PLAY_DICTIONARY_AUDIO"; provider: DictionaryProvider; url: string }
  | { type: "STOP_DICTIONARY_AUDIO" }
  | { type: "GET_DOUBAO_STATUS" }
  | { type: "CHECK_DOUBAO" }
  | { type: "GET_LOCAL_MODEL_STATUS" }
  | { type: "INSTALL_LOCAL_MODEL"; modelId: string }
  | { type: "CANCEL_LOCAL_MODEL_DOWNLOAD" }
  | { type: "REMOVE_LOCAL_MODEL"; modelId: string }
  | { type: "GET_OCR_STATUS" }
  | { type: "INSTALL_OCR" }
  | { type: "REMOVE_OCR" }
  | { type: "TRANSLATE_PAGE" }
  | { type: "OPEN_VIDEO_SUBTITLES"; tabId?: number }
  | { type: "VIDEO_FRAME_STATUS"; videos: number; area: number; playing: boolean }
  | ({ type: "CAPTURE_VIDEO_FRAME" } & import("./video-frame").VideoFrameArea)
  | ({ type: "TRANSLATE_VIDEO_SUBTITLES"; sessionId: string; requestId: string } & TranslateBatchRequest)
  | { type: "CANCEL_VIDEO_SUBTITLES"; sessionId: string; requestId?: string }
  | { type: "CLEAR_TRANSLATION" }
  | { type: "GET_TRANSLATION_STATE" }
  | { type: "PAGE_TRANSLATION_STATE_CHANGED" }
  | { type: "GET_PARAGRAPH_MODE" }
  | { type: "SET_PARAGRAPH_MODE"; enabled: boolean }
  | { type: "START_TOUCH_PARAGRAPH" }
  | { type: "GET_FLOATING_BALL" }
  | { type: "SET_FLOATING_BALL"; enabled: boolean }
  | { type: "OPEN_TRANSLATION_DEBUG" }
  | { type: "GET_TRANSLATION_DEBUG" }
  | { type: "CLEAR_CACHE" }
  | { type: "GET_STATISTICS" }
  | { type: "CLEAR_STATISTICS" }
  | { type: "LOAD_IMAGE"; url: string }
  | { type: "TRANSLATE_CONTEXT_IMAGE"; srcUrl: string }
  | ({ type: "TRANSLATE_IMAGE" } & TranslateImageRequest)
  | ({ type: "TRANSLATE_BATCH" } & TranslateBatchRequest)
  | { type: "GET_SETTINGS" }
  | { type: "RESET_SETTINGS" }
  | { type: "IMPORT_SETTINGS"; backup: string }
  | { type: "OPEN_OPTIONS_PAGE" }
  | { type: "OPEN_EMBEDDED_PDF"; url: string }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings; previousSettings?: ExtensionSettings; interfaceLanguage?: InterfaceLanguage }
  | { type: "TEST_PROVIDER"; providerId?: string };

export type RuntimeResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; errorCode?: string; retryAfterMs?: number };
