import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./defaults";
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
  const storedProviders = Array.isArray(input.providers)
    ? input.providers.filter(isProviderConfig)
    : [];
  const providers = mergeProviders(storedProviders);
  const activeProviderId = readString(input.activeProviderId, DEFAULT_SETTINGS.activeProviderId);

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    providers,
    targetLang: readString(input.targetLang, DEFAULT_SETTINGS.targetLang),
    sourceLang: readString(input.sourceLang, DEFAULT_SETTINGS.sourceLang),
    activeProviderId: providers.some((provider) => provider.id === activeProviderId)
      ? activeProviderId
      : DEFAULT_SETTINGS.activeProviderId,
    chunkSize: clampNumber(input.chunkSize, 200, 4000, DEFAULT_SETTINGS.chunkSize),
    concurrency: clampNumber(input.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency),
    cacheEnabled:
      typeof input.cacheEnabled === "boolean"
        ? input.cacheEnabled
        : DEFAULT_SETTINGS.cacheEnabled,
    floatingBallEnabled:
      typeof input.floatingBallEnabled === "boolean"
        ? input.floatingBallEnabled
        : DEFAULT_SETTINGS.floatingBallEnabled
  };
}

function mergeProviders(storedProviders: ProviderConfig[]): ProviderConfig[] {
  const byId = new Map(DEFAULT_SETTINGS.providers.map((provider) => [provider.id, provider]));
  for (const provider of storedProviders) {
    byId.set(provider.id, provider);
  }
  return Array.from(byId.values());
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "google-web-translate" ||
    value.type === "deepl-web"
  ) {
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
