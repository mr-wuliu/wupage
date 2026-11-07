import { t } from "../shared/i18n";
import { getProviderUsage, PROVIDER_USAGE_CHECKED_AT } from "../shared/provider-usage";
import { getEffectiveProviderPerformance } from "../shared/performance";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";

export function renderProviderUsage(container: HTMLElement, provider: ProviderConfig): void {
  const usage = getProviderUsage(provider);
  container.replaceChildren();
  container.className = "provider-usage";
  container.setAttribute("aria-labelledby", "providerUsageTitle");
  const header = document.createElement("div"); header.className = "provider-usage-heading";
  const heading = document.createElement("h3"); heading.id = "providerUsageTitle"; heading.textContent = t("quotasAndLimits", usage.service);
  const checked = document.createElement("time"); checked.dateTime = PROVIDER_USAGE_CHECKED_AT; checked.textContent = t("updated", PROVIDER_USAGE_CHECKED_AT);
  header.append(heading, checked);
  const details = document.createElement("dl"); details.className = "provider-usage-details";
  for (const [label, value] of [[t("freeAnonymousQuota"), usage.quota], [t("perRequest"), usage.request], [t("requestRate"), usage.rate], [t("providerConcurrency"), usage.concurrency]]) {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = value;
    row.append(term, description); details.append(row);
  }
  container.append(header, details);
  if (usage.note) { const note = document.createElement("p"); note.className = "provider-usage-note"; note.textContent = usage.note; container.append(note); }
  const sources = document.createElement("p"); sources.className = "provider-usage-sources"; sources.dataset.role = "usage-sources";
  sources.append(usage.sources.length ? t("officialSources") : t("seeTheConfiguredServiceProviderSOfficialDocumentation"));
  usage.sources.forEach((source, index) => {
    if (index) sources.append(" · ");
    const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = source.label; sources.append(link);
  });
  const scheduling = document.createElement("p"); scheduling.className = "provider-usage-scheduling"; scheduling.dataset.role = "provider-scheduling";
  const note = document.createElement("p"); note.className = "provider-usage-note";
  note.textContent = t("seeTheProviderSLatestPublishedQuotasAnd");
  container.append(sources, scheduling, note);
}

export function updateProviderScheduling(container: HTMLElement, provider: ProviderConfig, settings: ExtensionSettings): void {
  const output = container.querySelector<HTMLElement>("[data-role='provider-scheduling']");
  if (!output) return;
  const performance = getEffectiveProviderPerformance(settings, provider.id);
  const useApi = "serviceMode" in provider && provider.serviceMode === "api";
  const inner = provider.type === "google-web-translate" && !useApi ? t("upToFourInternalRequestsPerTask")
    : ["yandex-web-translate", "volcengine-web-translate", "mymemory", "firefox-local"].includes(provider.type)
      || provider.type === "tencent-transmart" && useApi ? t("sequentialProcessingWithinEachTask") : "";
  output.textContent = t("currentSettingsChunkSizeCharactersConcurrency", performance.chunkSize.toLocaleString(t("interfaceLanguage")), performance.concurrency, inner);
}
