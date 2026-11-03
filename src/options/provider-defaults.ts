import { DEFAULT_SETTINGS } from "../shared/defaults";
import { supportsServiceMode, translationApiOptions } from "../shared/translation-service";
import { supportsRequestTemplate } from "../shared/request-template";
import type { ProviderConfig } from "../shared/types";

export function defaultProviderPerformance(provider: ProviderConfig): Pick<ProviderConfig, "performanceMode" | "chunkSize" | "concurrency"> {
  const defaults = DEFAULT_SETTINGS.providers.find(entry => entry.id === provider.id && entry.type === provider.type);
  return { performanceMode: defaults?.performanceMode ?? "inherit", chunkSize: defaults?.chunkSize, concurrency: defaults?.concurrency };
}

/** Service defaults must leave performance, credentials and user-defined services intact. */
export function restoreProviderParameters(provider: ProviderConfig): ProviderConfig {
  const defaults = DEFAULT_SETTINGS.providers.find(entry => entry.id === provider.id && entry.type === provider.type);
  // HTTP templates can carry credentials in any part of the request.
  if (!defaults || provider.type === "http-template") return provider;
  const restored = { ...structuredClone(defaults), performanceMode: provider.performanceMode,
    chunkSize: provider.chunkSize, concurrency: provider.concurrency };
  if ("apiKey" in restored && "apiKey" in provider) restored.apiKey = provider.apiKey;
  if (supportsServiceMode(restored) && supportsServiceMode(provider)) {
    restored.api = translationApiOptions(restored);
    for (const key of ["apiKey", "accessKeyId", "secretAccessKey"] as const) {
      if (provider.api?.[key] !== undefined) restored.api[key] = provider.api[key];
    }
  }
  if (provider.customModels) restored.customModels = [...provider.customModels];
  if (supportsRequestTemplate(restored) && supportsRequestTemplate(provider) && provider.requestTemplate) {
    restored.requestTemplate = { ...structuredClone(provider.requestTemplate), enabled: false };
  }
  return restored;
}
