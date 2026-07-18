import type { ExtensionSettings, ProviderConfig } from "./types";

export interface EffectiveProviderPerformance {
  chunkSize: number;
  concurrency: number;
  performanceMode: "inherit" | "custom";
}

export function getEffectiveProviderPerformance(
  settings: ExtensionSettings,
  providerId = settings.activeProviderId
): EffectiveProviderPerformance {
  const provider = settings.providers.find((entry) => entry.id === providerId);
  const custom = provider?.performanceMode === "custom";
  const chunkSize = custom
    ? clamp(provider.chunkSize, 200, 4000, settings.chunkSize)
    : settings.chunkSize;
  const providerConcurrency = custom
    ? clamp(provider.concurrency, 1, 8, settings.concurrency)
    : settings.concurrency;

  return {
    chunkSize,
    concurrency: Math.min(settings.concurrency, providerConcurrency),
    performanceMode: custom ? "custom" : "inherit"
  };
}

export function isLlmProvider(provider: ProviderConfig): boolean {
  return provider.type === "openai-compatible"
    || provider.type === "anthropic-compatible"
    || provider.type === "zhipu-glm";
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
