import { t } from "./i18n";
import { supportsServiceMode, translationApiOptions } from "./translation-service";
import { deepLEndpoint } from "./deepl";
import type { ProviderConfig } from "./types";

export interface UsageSource { label: string; url: string }
export interface ProviderUsage {
  service: string;
  quota: string;
  request: string;
  rate: string;
  concurrency: string;
  note?: string;
  checkedAt?: string;
  sources: UsageSource[];
}

// Snapshot of the linked official material; these are published rules, not account balances.
export const PROVIDER_USAGE_CHECKED_AT = "2026-10-27";
const source = (label: string, url: string): UsageSource => ({ label, url });
const freeServices = () => ({
  "microsoft-web-translate": { service: t("microsoftBrowserTranslationAnonymous"), source: source(t("microsoftEdgeHelp"), "https://support.microsoft.com/en-au/edge/use-microsoft-translator-in-microsoft-edge-browser") },
  "google-web-translate": { service: t("googleWebTranslateAnonymous"), source: source(t("googleTranslate"), "https://translate.google.com/about/") },
  "tencent-transmart": { service: t("tencentTransmartAnonymous"), source: source("TranSmart", "https://transmart.qq.com/") },
  "yandex-web-translate": { service: t("yandexWebTranslationAnonymous"), source: source(t("yandexTranslate"), "https://translate.yandex.com/") },
  "volcengine-web-translate": { service: t("volcengineBrowserTranslationAnonymous"), source: source(t("volcengineTranslate"), "https://translate.volcengine.com/") }
});

function azureUsage(): ProviderUsage {
  return { service: "Microsoft Translator API（Azure）", quota: t("f0FreeTier2MillionCharactersPerMonth"),
    request: t("upTo50000CharactersAnd1000"),
    rate: t("f02MillionCharactersPerHourEvenlyDistributed"), concurrency: t("noFixedConcurrencyCapCharacterRateAndSubscription"),
    sources: [source(t("microsoftFreeTier"), "https://www.microsoft.com/en-us/translator/business/faq/"),
      source(t("azureRequestRateAndConcurrencyLimits"), "https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits")] };
}

function googleUsage(): ProviderUsage {
  return { service: "Google Cloud Translation · Basic v2", quota: t("nmtTheFirst500000CharactersPerMonth"),
    request: t("basicUpTo100KbAnd128Text"),
    rate: t("defaultPerProject6MillionCharactersPerMinute"), concurrency: t("noCommonConcurrencyCapIsPublished"),
    sources: [source(t("googleCloudPricingAndFreeQuota"), "https://cloud.google.com/products/translate/pricing"),
      source(t("googleCloudQuotasAndRequestLimits"), "https://docs.cloud.google.com/translate/quotas"),
      source(t("v2TextItemLimit"), "https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate")] };
}

function customUsage(service = t("customEndpoint")): ProviderUsage {
  return { service, quota: t("dependsOnTheConfiguredServicePlanAndAccount"), request: t("dependsOnTheProviderSPerRequestLimits"),
    rate: t("dependsOnTheProviderSAccountRateLimits"), concurrency: t("dependsOnTheProviderSAccountConcurrencyLimits"), sources: [] };
}

function officialHost(address: string, domains: string[]): boolean {
  try { const url = new URL(address); return url.protocol === "https:" && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); }
  catch { return false; }
}

export function getProviderUsage(provider: ProviderConfig): ProviderUsage {
  const unknown = t("notPublishedByTheProvider");
  if (provider.type === "doubao-web") return { service: t("doubaoExperimental"), quota: t("dependsOnTheQuotaAvailableFromDoubao"),
    request: unknown, rate: unknown, concurrency: unknown,
    sources: [source(t("doubao"), "https://www.doubao.com/")] };
  if (supportsServiceMode(provider)) {
    const useApi = provider.serviceMode === "api";
    if (!useApi && provider.type !== "mymemory") {
      const free = freeServices()[provider.type];
      return { service: free.service, quota: t("noAnonymousApiQuotaIsPublished"), request: unknown, rate: unknown, concurrency: unknown,
        sources: [free.source] };
    }
    const api = translationApiOptions(provider);
    if (provider.type === "microsoft-web-translate") return officialHost(api.endpoint ?? "", ["cognitive.microsofttranslator.com", "cognitiveservices.azure.com"])
      ? azureUsage() : customUsage(t("microsoftTranslatorCustomApiAddress"));
    if (provider.type === "google-web-translate") return googleUsage();
    if (provider.type === "tencent-transmart") {
      if (!officialHost(api.endpoint ?? "", ["tokenhub.tencentmaas.com", "tokenhub.tencentcloudmaas.com", "tokenhub-intl.tencentcloudmaas.com", "tokenhub-us.tencentcloudmaas.tech"])) return customUsage(t("tencentTranslateCustomApiAddress"));
      return { service: t("tencentTokenhub", api.model || t("noModelSpecified")),
        quota: t("eligibleNewUsersCanClaimATrialAllowance"),
        request: t("dependsOnTheSelectedModelSContextAnd"),
        rate: t("tpmTokensPerMinuteAndQpmRequestsPer"), concurrency: t("dependsOnTheAccountAndSelectedModelS"),
        note: t("trialOfferEnds20261231CheckThe"),
        sources: [source(t("tokenhubNewUserTrial"), "https://cloud.tencent.com/document/product/1823/130053"),
          source(t("tokenhubOnlineInferenceAndRateLimits"), "https://cloud.tencent.cn/document/product/1823/130087")] };
    }
    if (provider.type === "yandex-web-translate") return { service: "Yandex Cloud Translate API", quota: t("billedPerCharacterRequiresAnAccountAndKey"),
      request: t("upTo10000CharactersTotalPerRequest"), rate: t("default20RequestsPerSecondPerApiMethod"),
      concurrency: t("noFixedConcurrencyLimitIsPublished"),
      sources: [source(t("yandexCloudQuotas"), "https://yandex.cloud/en/docs/overview/concepts/quotas-limits#translate-quotas"),
        source(t("yandexTranslateRequestLimits"), "https://aistudio.yandex.ru/en/docs/translate/api-ref/Translation/translate"),
        source(t("yandexCloudPricing"), "https://aistudio.yandex.ru/en/docs/translate/pricing")] };
    if (provider.type === "volcengine-web-translate") return { service: t("volcengineMachineTranslationApi"), quota: t("theFirst2MillionCharactersOfTextTranslation"),
      request: t("upTo16TextItemsAnd5000"), rate: t("dependsOnTheAccountQpsQuotaRequestsPer"),
      concurrency: t("noFixedConcurrencyLimitIsPublished"),
      sources: [source(t("volcengineMachineTranslationPricing"), "https://docs.volcengine.com/docs/MachineTranslation/Productbilling?lang=zh"),
        source(t("volcengineTextTranslationApiLimits"), "https://docs.volcengine.com/docs/MachineTranslation/TextTranslationAPI?lang=zh")] };
    return useApi ? { service: "MyMemory · RapidAPI", quota: t("quotaDependsOnTheRapidapiSubscription"),
      request: t("upTo500Utf8BytesPerRequest"), rate: t("dependsOnRapidapiSubscriptionAndAccountRateLimits"), concurrency: t("dependsOnTheRapidapiSubscription"),
      sources: [source(t("mymemoryRapidapiSubscription"), "https://rapidapi.com/translated/api/mymemory-translation-memory"),
        source(t("mymemoryApiSpecification"), "https://mymemory.translated.net/doc/spec.php")] }
      : { service: t("mymemoryAnonymous"), quota: t("label5000CharactersPerDay"),
        request: t("myMemoryAnonymousRequestLimit"), rate: unknown, concurrency: unknown,
        sources: [source(t("mymemoryAnonymousQuota"), "https://mymemory.translated.net/doc/usagelimits.php"),
          source(t("mymemoryPerRequestLimit"), "https://mymemory.translated.net/doc/spec.php")] };
  }
  if (provider.type === "microsoft-translator") return officialHost(provider.endpoint, ["cognitive.microsofttranslator.com", "cognitiveservices.azure.com"])
    ? azureUsage() : customUsage(t("microsoftTranslatorCustomApiAddress"));
  if (provider.type === "google-cloud-translation") return googleUsage();
  if (provider.type === "deepl") {
    let endpoint: string;
    try { endpoint = deepLEndpoint(provider); } catch { return customUsage("DeepL"); }
    if (!officialHost(endpoint, ["api.deepl.com", "api-free.deepl.com"])) return customUsage("DeepL");
    return { service: "DeepL API", quota: t("dependsOnTheConfiguredServicePlanAndAccount"),
      request: t("deepLRequestLimit"), rate: unknown, concurrency: unknown, checkedAt: "2026-11-07",
      sources: [source("DeepL API", "https://developers.deepl.com/docs/resources/usage-limits")] };
  }
  if (provider.type === "index-translate") return { ...customUsage(`Index-Translate · ${provider.model}`),
    note: t("indexTranslateUsageHint"), checkedAt: "2026-11-07",
    sources: [source("Index-Translate", "https://github.com/bilibili/Index-Translate")] };
  if (provider.type === "deepseek") {
    if (!officialHost(provider.baseURL, ["api.deepseek.com"])) return customUsage(t("deepseekCustomApiAddress"));
    const concurrency = provider.model === "deepseek-flash" ? t("deepseekFlash2500ConcurrentRequestsPerAccount")
      : provider.model === "deepseek-v4-pro" ? t("deepseekV4Pro500ConcurrentRequestsPerAccount") : t("modelConcurrencyLimit");
    return { service: `DeepSeek API · ${provider.model}`, quota: t("billedByTokensRequiresAnApiKeyPromotional"),
      request: t("dependsOnTheSelectedModelSContextAnd"), rate: t("rateLimitsDependOnTheAccountAndModel"), concurrency,
      sources: [source(t("deepseekOfficialConcurrencyLimits"), "https://api-docs.deepseek.com/quick_start/rate_limit/"),
        source(t("deepseekOfficialApiDocumentation"), "https://api-docs.deepseek.com/")] };
  }
  if (provider.type === "zhipu-glm") {
    if (!officialHost(provider.baseURL, ["open.bigmodel.cn"])) return customUsage(t("zhipuGlmCustomApiAddress"));
    const freeModel = ["glm-4-flash-250414", "glm-4.5-flash", "glm-4.7-flash"].includes(provider.model);
    return { service: t("zhipuGlmApi", provider.model), quota: freeModel
      ? t("thisModelIsFreeAndRequiresAnAccount")
      : t("pricingAndCreditsDependOnTheModelAnd"),
      request: provider.model === "glm-4-flash-250414" ? t("label128kContextAndUpTo16kOutputTokens") : t("dependsOnTheSelectedModelSContextAnd"),
      rate: t("accountModelRateLimit"), concurrency: t("dependsOnTheAccountSConcurrencyQuotaFor"),
      sources: [source(t("zhipuOfficialModelListIncludingFreeModels"), "https://docs.bigmodel.cn/cn/guide/start/model-overview"),
        source(t("zhipuOfficialRateLimits"), "https://docs.bigmodel.cn/cn/api/rate-limit")] };
  }
  if (provider.type === "firefox-local") return { service: t("firefoxLocalTranslationExperimental"), quota: t("localTranslationUsesNoOnlineApiQuotaDownload"),
    request: t("limitedByTheLanguageModelAndDeviceMemory"), rate: t("notApplicableToLocalTranslation"), concurrency: t("notApplicableToLocalTranslation"),
    sources: [source(t("mozillaLocalTranslationOverview"), "https://support.mozilla.org/en-US/kb/website-translation")] };
  if (provider.type === "openai-compatible" && officialHost(provider.baseURL, ["api.openai.com"])) return {
    service: t("officialOpenaiApi", provider.model), quota: t("billedByModelRequiresAnApiKeyPromotional"),
    request: t("subjectToTheCurrentModelSContextAnd"), rate: t("subjectToModelAndAccountTierLimitsIncluding"),
    concurrency: t("seeTheAccountSLimitsPage"),
    sources: [source(t("openaiRateLimitsAndAccountTiers"), "https://developers.openai.com/api/docs/guides/rate-limits")] };
  if (provider.type === "anthropic-compatible" && officialHost(provider.baseURL, ["api.anthropic.com"])) return {
    service: t("officialAnthropicApi", provider.model), quota: t("billedByModelRequiresAnApiKeyTrial"),
    request: t("subjectToModelContextOutputAndPerRequest"), rate: t("subjectToModelAndAccountTierLimitsOn"),
    concurrency: t("dependsOnTheAccountSConcurrencyQuotaFor"),
    sources: [source(t("anthropicRateLimitsAndAccountTiers"), "https://platform.claude.com/docs/en/api/rate-limits"),
      source(t("anthropicApiOverview"), "https://platform.claude.com/docs/en/api/overview")] };
  return customUsage(provider.type === "http-template" ? t("customHttpService") : t("customCompatibleLlmService"));
}
