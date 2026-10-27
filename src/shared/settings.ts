import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./defaults";
import { isLlmProvider } from "./performance";
import { normalizeAutoTranslation } from "./auto-translation";
import { normalizeSelectionTranslation } from "./selection-translation";
import { normalizeServiceConfig, supportsServiceMode } from "./translation-service";
import type { ExtensionSettings, ProviderConfig } from "./types";

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  const input = isRecord(value) ? value : {};
  const chunkSize = clampNumber(input.chunkSize, 200, 4000, DEFAULT_SETTINGS.chunkSize);
  const concurrency = clampNumber(input.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency);
  const storedProviders = Array.isArray(input.providers)
    ? input.providers.filter(isProviderConfig)
    : [];
  const requestedId = migrateTranslationApis(storedProviders, readString(input.activeProviderId, DEFAULT_SETTINGS.activeProviderId));
  const providers = mergeProviders(storedProviders, chunkSize, concurrency);
  ensureEnabledProvider(providers);
  const requestedProviderId = requestedId;
  const activeProviderId =
    providers.find(
      (provider) => provider.id === requestedProviderId && provider.enabled !== false
    )?.id
    ?? providers.find((provider) => provider.enabled !== false)?.id
    ?? DEFAULT_SETTINGS.activeProviderId;

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    providers,
    autoTranslation: normalizeAutoTranslation(input.autoTranslation),
    selectionTranslation: normalizeSelectionTranslation(input.selectionTranslation),
    targetLang: readString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: readString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    activeProviderId,
    chunkSize,
    concurrency,
    pdfTranslationPageRadius: input.pdfTranslationPageRadius === null
      ? null
      : clampNumber(input.pdfTranslationPageRadius, 0, 1000, DEFAULT_SETTINGS.pdfTranslationPageRadius!),
    cacheEnabled:
      typeof input.cacheEnabled === "boolean"
        ? input.cacheEnabled
        : DEFAULT_SETTINGS.cacheEnabled,
    floatingBallEnabled:
      typeof input.floatingBallEnabled === "boolean"
        ? input.floatingBallEnabled
        : DEFAULT_SETTINGS.floatingBallEnabled,
    translateCodeComments:
      typeof input.translateCodeComments === "boolean"
        ? input.translateCodeComments
        : DEFAULT_SETTINGS.translateCodeComments,
    imageTranslationEnabled: input.imageTranslationEnabled === true,
    translationDisplayMode: isTranslationDisplayMode(input.translationDisplayMode)
      ? input.translationDisplayMode
      : DEFAULT_SETTINGS.translationDisplayMode
  };
}

function migrateTranslationApis(providers: ProviderConfig[], activeId: string): string {
  const aliases = [
    { old: "microsoft-translator", current: "microsoft-web-translate" },
    { old: "google-cloud-translation", current: "google-web-translate" }
  ];
  for (const alias of aliases) {
    const index = providers.findIndex(provider => provider.id === alias.old && provider.type === alias.old);
    if (index < 0) continue;
    const old = providers[index];
    if (old.type !== "microsoft-translator" && old.type !== "google-cloud-translation") continue;
    const current = providers.find(provider => provider.id === alias.current)
      ?? DEFAULT_SETTINGS.providers.find(provider => provider.id === alias.current)!;
    if (!supportsServiceMode(current)) continue;
    // Retain separately configured subscriptions when merging would lose either credential.
    if (current.api?.apiKey && (current.api.apiKey !== old.apiKey || old.type === "microsoft-translator"
      && ((current.api.endpoint || "https://api.cognitive.microsofttranslator.com") !== old.endpoint
        || (current.api.region || "") !== old.region))) continue;
    providers.splice(index, 1);
    const configured = old.apiKey || old.id === activeId || old.type === "microsoft-translator"
      && (old.region || old.endpoint !== "https://api.cognitive.microsofttranslator.com");
    const api = configured ? {
      ...current.api, apiKey: old.apiKey,
      ...(old.type === "microsoft-translator" ? { endpoint: old.endpoint, region: old.region } : {})
    } : current.api;
    const replacement = { ...current, api,
      ...(old.id === activeId ? { serviceMode: "api" as const, enabled: old.enabled, label: old.label } : {}) };
    const currentIndex = providers.findIndex(provider => provider.id === alias.current);
    if (currentIndex < 0) providers.push(replacement);
    else providers[currentIndex] = replacement;
    if (old.id === activeId) activeId = alias.current;
  }
  return activeId;
}

function isTranslationDisplayMode(value: unknown): value is ExtensionSettings["translationDisplayMode"] {
  return value === "replace" || value === "bilingual" || value === "bilingual-accent";
}

function mergeProviders(
  storedProviders: ProviderConfig[],
  globalChunkSize: number,
  globalConcurrency: number
): ProviderConfig[] {
  const byId = new Map(
    DEFAULT_SETTINGS.providers.map((provider) => [
      provider.id,
      normalizeProvider(provider, globalChunkSize, globalConcurrency)
    ])
  );
  for (const provider of storedProviders) {
    byId.set(provider.id, normalizeProvider(provider, globalChunkSize, globalConcurrency));
  }
  return Array.from(byId.values());
}

function normalizeProvider(
  provider: ProviderConfig,
  globalChunkSize: number,
  globalConcurrency: number
): ProviderConfig {
  if (supportsServiceMode(provider)) provider = normalizeServiceConfig(provider);
  const previousLabels: Record<string, string[]> = {
    "microsoft-web-translate": ["Microsoft 免费翻译", "Microsoft Translator API（Azure）", "Microsoft Translator"],
    "google-web-translate": ["Google Web Translate", "Google Cloud Translation"],
    "tencent-transmart": ["腾讯 TranSmart"], "yandex-web-translate": ["Yandex 免费翻译"], "volcengine-web-translate": ["火山免费翻译"]
  };
  if (previousLabels[provider.id]?.includes(provider.label)) {
    provider = { ...provider, label: DEFAULT_SETTINGS.providers.find(entry => entry.id === provider.id)!.label };
  }
  if (provider.customModels !== undefined) {
    provider = { ...provider, customModels: Array.isArray(provider.customModels)
      ? [...new Set(provider.customModels.filter((model): model is string => typeof model === "string")
        .map((model) => model.trim()).filter(Boolean))]
      : [] };
  }
  if (provider.type === "microsoft-translator" && provider.id === "microsoft-translator"
    && provider.label === "Microsoft Translator") {
    provider = { ...provider, label: "Microsoft Translator API（Azure）" };
  }
  if (provider.type === "deepseek"
    && (provider.model === "deepseek-v4-flash" || provider.model === "deepseek-v4-flash-vision-exp")) {
    provider = { ...provider, model: "deepseek-flash" };
  }
  if (provider.type === "openai-compatible") {
    provider = {
      ...provider,
      ollamaCompatibility: provider.ollamaCompatibility !== false
    };
  }
  const legacyPerformance = provider.performanceMode === undefined;
  const performanceMode = provider.performanceMode === "custom"
    || (legacyPerformance && isLlmProvider(provider))
    ? "custom"
    : "inherit";
  if (performanceMode === "inherit") {
    return {
      ...provider,
      enabled: provider.enabled !== false,
      performanceMode,
      chunkSize: undefined,
      concurrency: undefined
    };
  }
  return {
    ...provider,
    enabled: provider.enabled !== false,
    performanceMode,
    chunkSize: clampNumber(
      provider.chunkSize,
      200,
      4000,
      legacyPerformance && isLlmProvider(provider) ? Math.max(3200, globalChunkSize) : globalChunkSize
    ),
    concurrency: clampNumber(provider.concurrency, 1, 8, globalConcurrency)
  };
}

function ensureEnabledProvider(providers: ProviderConfig[]): void {
  if (providers.some((provider) => provider.enabled !== false)) return;
  const fallback = providers.find((provider) => provider.id === DEFAULT_SETTINGS.activeProviderId)
    ?? providers[0];
  if (fallback) fallback.enabled = true;
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (
    value.performanceMode !== undefined
    && value.performanceMode !== "inherit"
    && value.performanceMode !== "custom"
  ) return false;
  if (value.chunkSize !== undefined && typeof value.chunkSize !== "number") return false;
  if (value.concurrency !== undefined && typeof value.concurrency !== "number") return false;
  if (value.type === "google-web-translate" || value.type === "microsoft-web-translate"
    || value.type === "tencent-transmart" || value.type === "yandex-web-translate"
    || value.type === "volcengine-web-translate" || value.type === "mymemory"
    || value.type === "firefox-local") {
    return ["id", "label"].every((key) => typeof value[key] === "string");
  }

  if (value.type === "microsoft-translator") {
    return ["id", "label", "endpoint", "apiKey", "region"].every((key) =>
      typeof value[key] === "string"
    );
  }

  if (value.type === "google-cloud-translation") {
    return ["id", "label", "apiKey"].every((key) => typeof value[key] === "string");
  }

  if (value.type === "openai-compatible") {
    return ["id", "label", "baseURL", "apiKey", "model", "systemPrompt"].every((key) =>
      typeof value[key] === "string"
    );
  }

  if (value.type === "anthropic-compatible") {
    return ["id", "label", "baseURL", "apiKey", "model", "systemPrompt"].every((key) =>
      typeof value[key] === "string"
    );
  }

  if (value.type === "deepseek") {
    return ["id", "label", "baseURL", "apiKey", "model", "systemPrompt"].every((key) =>
      typeof value[key] === "string"
    );
  }

  if (value.type === "zhipu-glm") {
    return ["id", "label", "baseURL", "apiKey", "model", "systemPrompt"].every((key) =>
      typeof value[key] === "string"
    );
  }

  if (value.type === "http-template") {
    return (
      typeof value.id === "string" &&
      typeof value.label === "string" &&
      (value.method === "GET" || value.method === "POST") &&
      typeof value.url === "string" &&
      isRecord(value.headers) &&
      Object.values(value.headers).every((entry) => typeof entry === "string") &&
      typeof value.bodyTemplate === "string" &&
      typeof value.responsePath === "string"
    );
  }

  return false;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
