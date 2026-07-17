export type ProviderType =
  | "google-web-translate"
  | "microsoft-translator"
  | "google-cloud-translation"
  | "openai-compatible"
  | "zhipu-glm"
  | "http-template";

export interface GoogleWebTranslateConfig {
  type: "google-web-translate";
  id: string;
  label: string;
}

export interface MicrosoftTranslatorConfig {
  type: "microsoft-translator";
  id: string;
  label: string;
  endpoint: string;
  apiKey: string;
  region: string;
}

export interface GoogleCloudTranslationConfig {
  type: "google-cloud-translation";
  id: string;
  label: string;
  apiKey: string;
}

export interface OpenAICompatibleConfig {
  type: "openai-compatible";
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface ZhipuGlmConfig {
  type: "zhipu-glm";
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export interface HttpTemplateConfig {
  type: "http-template";
  id: string;
  label: string;
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  responsePath: string;
}

export type ProviderConfig =
  | GoogleWebTranslateConfig
  | MicrosoftTranslatorConfig
  | GoogleCloudTranslationConfig
  | OpenAICompatibleConfig
  | ZhipuGlmConfig
  | HttpTemplateConfig;

export interface ExtensionSettings {
  targetLang: string;
  sourceLang: string;
  activeProviderId: string;
  chunkSize: number;
  concurrency: number;
  cacheEnabled: boolean;
  floatingBallEnabled: boolean;
  providers: ProviderConfig[];
}

export interface TranslateBatchRequest {
  texts: string[];
  sourceLang?: string;
  targetLang: string;
  providerId?: string;
}

export interface TranslateBatchResponse {
  translations: string[];
  cached: number;
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
  | ({ type: "TRANSLATE_BATCH" } & TranslateBatchRequest)
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "TEST_PROVIDER"; providerId?: string };

export type RuntimeResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };
