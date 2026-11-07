import { t } from "./i18n";
import { DOUBAO_TARGET_LANGUAGES, isDoubaoBrowserSupported } from "./doubao";
import type { DoubaoStatus, ExtensionSettings, ProviderConfig } from "./types";

export function isDoubaoProviderUnavailable(provider: ProviderConfig): boolean {
  return provider.type === "doubao-web" && !isDoubaoBrowserSupported();
}

export function syncDoubaoTargetControls(
  settings: ExtensionSettings,
  target: HTMLSelectElement
): void {
  const doubao = settings.providers.find((provider) => provider.id === settings.activeProviderId)?.type === "doubao-web";
  for (const option of target.options) {
    const disabled = doubao && !Object.hasOwn(DOUBAO_TARGET_LANGUAGES, option.value);
    if (option.disabled !== disabled) option.disabled = disabled;
  }
  const title = doubao && !Object.hasOwn(DOUBAO_TARGET_LANGUAGES, target.value)
    ? t("doubaoChooseSupportedLanguage")
    : "";
  if (target.title !== title) target.title = title;
}

export function doubaoProviderNotice(settings: ExtensionSettings): string | undefined {
  const provider = settings.providers.find((entry) => entry.id === settings.activeProviderId);
  if (provider?.type !== "doubao-web") return undefined;
  if (isDoubaoProviderUnavailable(provider)) return t("doubaoExperimentalCurrentlyRequiresAChromiumBrowserChoose");
  if (!Object.hasOwn(DOUBAO_TARGET_LANGUAGES, settings.targetLang)) return t("doubaoSupportedLanguages");
  return t("doubaoExperimentalSignInToDoubaoInThis");
}

const STATUS_LABELS: Record<DoubaoStatus["state"], string> = {
  get unknown() { return t("notCheckedYetSignInToDoubaoIn"); },
  get checking() { return t("checkingDoubaoConnection"); },
  get ready() { return t("theLastTranslationOrCheckSucceededReadyTo"); },
  get "login-required"() { return t("signInToDoubaoThenRetryTheTranslation"); },
  get "rate-limited"() { return t("doubaoRateLimitReachedWaitBeforeRetrying"); },
  get "service-rejected"() { return t("doubaoTemporarilyRejectedTheRequestCheckItsWebsite"); },
  get "permission-required"() { return t("doubaoSiteAccessIsMissingCheckTheExtension"); },
  get "network-error"() { return t("cannotReachDoubaoCheckYourConnectionThenRetry"); },
  get timeout() { return t("doubaoTimedOutRetryTheTranslationOrConnection"); },
  get "protocol-changed"() { return t("doubaoSResponseFormatChangedThisVersionCannot"); },
  get incomplete() { return t("doubaoReturnedAnIncompleteTranslationRetryTheUnfinished"); },
  get "unsupported-browser"() { return t("doubaoTranslationIsUnavailableInThisBrowserUse"); },
  get "unsupported-language"() { return t("doubaoUnsupportedLanguage"); }
};

export function formatDoubaoStatus(status: DoubaoStatus, now = Date.now()): string {
  const label = STATUS_LABELS[status.state] ?? STATUS_LABELS.unknown;
  const remaining = status.retryAt ? Math.max(0, Math.ceil((status.retryAt - now) / 1000)) : 0;
  const wait = remaining > 0 ? t("retryInAboutSeconds", remaining) : "";
  const checked = status.checkedAt && Number.isFinite(status.checkedAt)
    ? t("lastChecked", new Date(status.checkedAt).toLocaleString(t("interfaceLanguage")))
    : "";
  return `${label}${wait}${checked}`;
}
