import { getInterfaceLanguage, initializeInterfaceLanguage, localizeDocument, t, htmlMessage, type InterfaceLanguage } from "../shared/i18n";
import { BUILT_IN_PROVIDER_IDS, DEFAULT_SETTINGS } from "../shared/defaults";
import { normalizeFrameTranslation } from "../shared/frame-session";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import { sendRuntimeMessage } from "../shared/messaging";
import type { DoubaoStatus, ExtensionSettings, ProviderConfig, TranslationApiOptions } from "../shared/types";
import { supportsServiceMode, translationApiOptions } from "../shared/translation-service";
import "./styles.css";
import { setImageTranslationToggle } from "../shared/ocr-control";
import { setupOcrSettings } from "./ocr-service";
import { DEFAULT_OCR_SETTINGS } from "../shared/ocr-service";
import { setupLocalModelControl } from "../local/control";
import { ensureProviderIconStyles, providerIconMarkup } from "../shared/provider-icons";
import { setupAutoTranslationControls } from "./auto-translation";
import { setupElementRuleControls } from "./element-exclusions";
import { renderProviderUsage, updateProviderScheduling } from "./provider-usage";
import { setupSettingsNavigation } from "./navigation";
import { setupStatisticsControls } from "./statistics";
import { setupShortcutSettings } from "./shortcuts";
import { setupAppearanceControls } from "./appearance";
import "../shared/appearance.css";
import { normalizeSelectionTranslation, type DictionaryProvider, type SelectionTriggerStyle } from "../shared/dictionary";
import { RequestTemplateError, supportsRequestTemplate, validateRequestTemplate } from "../shared/request-template";
import { readRequestTemplate, setupProviderTabs } from "./provider-advanced";
import { isDoubaoBrowserSupported } from "../shared/doubao";
import { formatDoubaoStatus, isDoubaoProviderUnavailable, syncDoubaoTargetControls } from "../shared/doubao-ui";
import { renderUiIcons, uiIconMarkup } from "../shared/ui-icons";
import { setupSettingsBackupControls } from "./settings-backup";
import { setupSettingsResetControls } from "./reset-settings";
import { ACTION_STATUS_DURATION, setupSettingsActionFeedback } from "./action-feedback";
import { defaultProviderPerformance, restoreProviderParameters } from "./provider-defaults";

await initializeInterfaceLanguage();
localizeDocument(document);
renderUiIcons();

const settingsNavigation = setupSettingsNavigation(query<HTMLElement>(".settings"));
const shortcutControls = setupShortcutSettings(query<HTMLElement>("#shortcutSettings"));
const appearanceControls = setupAppearanceControls(query<HTMLElement>("#appearanceSettings"));
const statisticsControls = setupStatisticsControls(query<HTMLElement>("#statisticsSettings"));

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
const interfaceLanguageSelect = query<HTMLSelectElement>("#interfaceLanguage");
interfaceLanguageSelect.value = getInterfaceLanguage();
const chunkSize = query<HTMLInputElement>("#chunkSize");
const concurrency = query<HTMLInputElement>("#concurrency");
const pdfTranslationScope = query<HTMLSelectElement>("#pdfTranslationScope");
const pdfTranslationPageRadius = query<HTMLInputElement>("#pdfTranslationPageRadius");
const pdfTranslationPageRadiusField = query<HTMLElement>("#pdfTranslationPageRadiusField");
const cacheEnabled = query<HTMLInputElement>("#cacheEnabled");
const floatingBallEnabled = query<HTMLInputElement>("#floatingBallEnabled");
const selectionTranslationEnabled = query<HTMLInputElement>("#selectionTranslationEnabled");
const selectionTranslationFields = query<HTMLFieldSetElement>("#selectionTranslationFields");
const selectionDictionary = query<HTMLSelectElement>("#selectionDictionary");
const selectionTriggerStyle = query<HTMLSelectElement>("#selectionTriggerStyle");
const imageTranslationEnabled = query<HTMLInputElement>("#imageTranslationEnabled");
const translateCodeComments = query<HTMLInputElement>("#translateCodeComments");
const translationDisplayMode = query<HTMLSelectElement>("#translationDisplayMode");
const translationDisplayModeDescription = query<HTMLSpanElement>("#translationDisplayModeDescription");
const providerPicker = query<HTMLDivElement>("#providerPicker");
const providerTrigger = query<HTMLButtonElement>("#providerTrigger");
const providerTriggerLabel = query<HTMLSpanElement>("#providerTriggerLabel");
const providerMenu = query<HTMLDivElement>("#providerMenu");
const addProviderButton = query<HTMLButtonElement>("#addProvider");
const providerForm = query<HTMLDivElement>("#providerForm");
const providerPerformance = query<HTMLDivElement>("#providerPerformance");
const modelDialog = query<HTMLDialogElement>("#modelDialog");
const modelDialogForm = query<HTMLFormElement>("#modelDialogForm");
const modelAction = query<HTMLSelectElement>("#modelAction");
const customModelName = query<HTMLInputElement>("#customModelName");
const providerDialog = query<HTMLDialogElement>("#providerDialog");
const providerDialogForm = query<HTMLFormElement>("#providerDialogForm");
const cancelProviderButton = query<HTMLButtonElement>("#cancelProvider");
const customProviderName = query<HTMLInputElement>("#customProviderName");
const customProviderKind = query<HTMLSelectElement>("#customProviderKind");
const customLlmFormatField = query<HTMLLabelElement>("#customLlmFormatField");
const customLlmFormat = query<HTMLSelectElement>("#customLlmFormat");
const saveButton = query<HTMLButtonElement>("#save");
const status = query<HTMLParagraphElement>("#status");
const autoTranslationControls = setupAutoTranslationControls(
  query<HTMLElement>("#autoTranslationSettings"), field => {
    settingsNavigation.reveal(field);
    field.scrollIntoView?.({ block: "center" });
  }
);
const frameTranslationEnabled = query<HTMLInputElement>("#frameTranslationEnabled");
const elementRuleControls = setupElementRuleControls(query<HTMLElement>("#elementExclusionSettings"), field => {
  settingsNavigation.reveal(field); field.scrollIntoView?.({ block: "center" });
});
const frameTranslationExcluded = query<HTMLTextAreaElement>("#frameTranslationExcluded");

const LLM_MODEL_OPTIONS = [
  "gpt-4o-mini",
  "glm-4-flash-250414",
  "glm-4.7-flash",
  "glm-4-flashx-250414"
];
const ZHIPU_MODEL_OPTIONS = [
  "glm-4-flash-250414",
  "glm-4.7-flash",
  "glm-4-flashx-250414"
];
const DEEPSEEK_MODEL_OPTIONS = [
  "deepseek-flash",
  "deepseek-v4-pro"
];
const DEFAULT_LLM_PROMPT =
  "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order.";

let settings: ExtensionSettings;
let savedSettings: ExtensionSettings;
let providerFormSettings: ProviderConfig | undefined;
let editingProviderId: string | undefined;
let disposeLocalControl: (() => void) | undefined;
let activeProviderTest: { providerId: string; status: HTMLElement; message: string } | undefined;
let providerFormVersion = 0;
let doubaoStatus: DoubaoStatus = { state: "unknown" };
let doubaoCheck: Promise<void> | undefined;
let doubaoStatusRevision = 0;
let doubaoRetryTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const pendingSettingsWrites = new Set<Promise<void>>();
let optionsClosed = false;
let ocrSettingsControls: ReturnType<typeof setupOcrSettings> | undefined;

window.addEventListener("pagehide", () => {
  optionsClosed = true;
  clearTimeout(doubaoRetryTimer);
  clearTimeout(statusTimer);
}, { once: true });

void init().catch((error: unknown) => {
  setStatus(error instanceof Error ? error.message : String(error));
});

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  savedSettings = cloneSettings(settings);
  ocrSettingsControls = setupOcrSettings(imageTranslationEnabled, () => {
    settings.imageTranslationEnabled = false; setImageTranslationToggle(imageTranslationEnabled, false);
  }, settings.ocr, field => settingsNavigation.reveal(field));
  render();
  setupSettingsActionFeedback(document);
  setupSettingsBackupControls({ status: setStatus, imported: imported => {
    invalidateProviderTest();
    settings = imported;
    savedSettings = cloneSettings(imported);
    editingProviderId = undefined;
    setProviderMenuOpen(false);
    render();
  } });
  const imageNotice = new URLSearchParams(location.search).get("imageTranslationNotice");
  if (imageNotice === "setup") setStatus(t("beforeTranslatingImagesFromTheContextMenuInstall"));
  if (imageNotice === "refresh") setStatus(t("couldNotConnectToTheImageSPage"));
  if (imageNotice) {
    settingsNavigation.reveal(imageTranslationEnabled);
    imageTranslationEnabled.closest(".image-feature")?.scrollIntoView?.({ block: "center" });
  }
  if (new URLSearchParams(location.search).get("pageTranslationNotice") === "refresh") {
    setStatus(t("couldNotConnectToThePageRefreshIt"));
  }

  providerTrigger.addEventListener("click", () => setProviderMenuOpen(providerMenu.hidden));
  providerMenu.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-action]")
      : null;
    if (!button) return;
    void handleProviderAction(button.dataset.action ?? "", button.dataset.providerId ?? "");
  });
  addProviderButton.addEventListener("click", openProviderDialog);
  cancelProviderButton.addEventListener("click", () => providerDialog.close());
  customProviderKind.addEventListener("change", updateCustomProviderFields);
  providerDialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void addCustomProvider();
  });
  query<HTMLButtonElement>("#cancelModel").addEventListener("click", () => modelDialog.close());
  modelAction.addEventListener("change", () => {
    const provider = getEditingProvider();
    customModelName.value = modelAction.value === "edit" && "model" in provider ? provider.model : "";
    customModelName.focus();
  });
  modelDialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveModel();
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !providerPicker.contains(event.target)) {
      setProviderMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setProviderMenuOpen(false);
  });
  saveButton.addEventListener("click", () => {
    void save().catch(() => {});
  });
  setupSettingsResetControls(resetSettings);
  query<HTMLButtonElement>("#restorePageDefaults").addEventListener("click", () => {
    try { restorePageDefaults(); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  });
  providerForm.addEventListener("input", invalidateProviderTest);
  providerForm.addEventListener("change", invalidateProviderTest);
  const updateUsageOnEdit = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (["serviceMode", "model", "baseURL", "endpoint"].includes(target.dataset.field ?? "")
      || ["model", "endpoint"].includes(target.dataset.apiField ?? "")) updateProviderUsage();
  };
  providerForm.addEventListener("input", updateUsageOnEdit);
  providerForm.addEventListener("change", updateUsageOnEdit);
  for (const field of [chunkSize, concurrency, providerPerformance]) {
    field.addEventListener("input", updateUsageScheduling);
    field.addEventListener("change", updateUsageScheduling);
  }
  pdfTranslationScope.addEventListener("change", updatePdfTranslationScope);
  sourceLang.addEventListener("change", updateLocalControl);
  targetLang.addEventListener("change", updateLocalControl);
}

function render(): void {
  renderGeneralSettings();
  renderProviderPicker(false);
  renderProviderForm();
}

function renderGeneralSettings(): void {
  statisticsControls.render(settings.statisticsEnabled === true);
  shortcutControls.render(settings.shortcuts, settings.shortcutEnabled, settings.localShortcuts);
  appearanceControls.render(settings.appearance);
  autoTranslationControls.render(settings.autoTranslation);
  elementRuleControls.render(settings);
  renderGeneralPageSettings(settings);
  renderSelectionSettings(settings);
  renderPerformanceSettings(settings);
  ocrSettingsControls?.render(settings.ocr);
}

function renderGeneralPageSettings(value: ExtensionSettings): void {
  const frameTranslation = normalizeFrameTranslation(value.frameTranslation);
  frameTranslationEnabled.checked = frameTranslation.enabled;
  frameTranslationExcluded.value = frameTranslation.excludeMatches.join("\n");
  renderLanguageOptions(targetLang, value.targetLang, TARGET_LANGUAGES);
  renderLanguageOptions(sourceLang, value.sourceLang, SOURCE_LANGUAGES);
  cacheEnabled.checked = value.cacheEnabled;
  floatingBallEnabled.checked = value.floatingBallEnabled;
  setImageTranslationToggle(imageTranslationEnabled, value.imageTranslationEnabled === true);
  translateCodeComments.checked = value.translateCodeComments;
  translationDisplayMode.innerHTML = TRANSLATION_DISPLAY_MODES
    .map((mode) => `<option value="${mode.value}">${mode.label}</option>`)
    .join("");
  translationDisplayMode.value = value.translationDisplayMode;
  updateTranslationDisplayModeDescription();
}

function renderSelectionSettings(value: ExtensionSettings): void {
  const selection = normalizeSelectionTranslation(value.selectionTranslation);
  selectionTranslationEnabled.checked = selection.enabled;
  selectionTranslationFields.disabled = !selection.enabled;
  selectionDictionary.value = selection.provider;
  selectionTriggerStyle.value = selection.style;
}

function renderPerformanceSettings(value: ExtensionSettings): void {
  chunkSize.value = String(value.chunkSize);
  concurrency.value = String(value.concurrency);
  pdfTranslationScope.value = value.pdfTranslationPageRadius === null ? "unlimited" : "nearby";
  pdfTranslationPageRadius.value = String(value.pdfTranslationPageRadius ?? DEFAULT_SETTINGS.pdfTranslationPageRadius);
  updatePdfTranslationScope();
}

translationDisplayMode.addEventListener("change", updateTranslationDisplayModeDescription);
selectionTranslationEnabled.addEventListener("change", () => { selectionTranslationFields.disabled = !selectionTranslationEnabled.checked; });

function updatePdfTranslationScope(): void {
  pdfTranslationPageRadiusField.hidden = pdfTranslationScope.value === "unlimited";
  pdfTranslationPageRadius.disabled = pdfTranslationPageRadiusField.hidden;
}

function updateTranslationDisplayModeDescription(): void {
  translationDisplayModeDescription.textContent = TRANSLATION_DISPLAY_MODES.find(
    (mode) => mode.value === translationDisplayMode.value
  )?.description ?? "";
}

function renderLanguageOptions(
  select: HTMLSelectElement,
  value: string,
  languages: ReadonlyArray<{ code: string; label: string }>
): void {
  const options = languages.some((entry) => entry.code === value)
    ? languages
    : [{ code: value, label: value }, ...languages];
  select.innerHTML = options
    .map((entry) => `<option value="${escapeHtml(entry.code)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  select.value = value;
}

function renderProviderPicker(keepOpen: boolean): void {
  ensureProviderIconStyles();
  const activeProvider = getEditingProvider();
  query<HTMLElement>("#providerTriggerIcon").innerHTML = providerIconMarkup(activeProvider);
  providerTriggerLabel.textContent = activeProvider.label;
  query<HTMLElement>("#disabledProviderHint").hidden = activeProvider.enabled !== false;
  providerMenu.innerHTML = settings.providers.map(renderProviderMenuRow).join("");
  setProviderMenuOpen(keepOpen);
}

function renderProviderMenuRow(provider: ProviderConfig): string {
  const enabled = provider.enabled !== false;
  const unavailable = isDoubaoProviderUnavailable(provider);
  const builtIn = BUILT_IN_PROVIDER_IDS.has(provider.id);
  return `
    <div class="provider-menu-row" data-built-in="${builtIn}" role="group">
      <button
        class="provider-option"
        type="button"
        role="option"
        data-action="select"
        data-provider-id="${escapeAttr(provider.id)}"
        aria-selected="${provider.id === editingProviderId}"
        data-enabled="${enabled}"
        ${unavailable ? "disabled" : ""}
        title="${unavailable ? t("doubaoTranslationIsUnavailableInThisBrowser") : `${escapeAttr(provider.label)}${enabled ? "" : t("disabledEditable")}`}"
      >
        ${providerIconMarkup(provider)}
        <span class="provider-option-label">${escapeHtml(provider.label)}</span>
      </button>
      <button
        class="provider-enable"
        type="button"
        data-action="toggle"
        data-provider-id="${escapeAttr(provider.id)}"
        aria-pressed="${enabled}"
        title="${enabled ? t("disable") : t("enable")} ${escapeAttr(provider.label)}"
        aria-label="${enabled ? t("disable") : t("enable")} ${escapeAttr(provider.label)}"
      ></button>
      ${builtIn ? "" : `
        <button
          class="provider-delete"
          type="button"
          data-action="delete"
          data-provider-id="${escapeAttr(provider.id)}"
          title="${htmlMessage("delete", provider.label)}"
          aria-label="${htmlMessage("delete", provider.label)}"
        >${uiIconMarkup("trash")}</button>
      `}
    </div>
  `;
}

function renderProviderForm(rebuildPerformance = true): void {
  invalidateProviderTest();
  const version = ++providerFormVersion;
  clearTimeout(doubaoRetryTimer);
  disposeLocalControl?.(); disposeLocalControl = undefined;
  const provider = getEditingProvider();
  providerFormSettings = structuredClone(provider);
  if (rebuildPerformance) renderProviderPerformanceControls(provider);
  syncDoubaoTargetControls(settings, targetLang);
  if (provider.type === "doubao-web") {
    setProviderFormMarkup(provider, `
      <div class="grid"><label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label></div>
      <div class="doubao-setup">
        <h3>${htmlMessage("doubaoExperimental")}</h3>
        <p>${htmlMessage("signInToDoubaoInThisBrowserTo")}</p>
        <p>${htmlMessage("translationSendsYourSourceTextToDoubaoThe")}</p>
        <div class="doubao-actions">
          <button type="button" data-action="open-doubao">${htmlMessage("openDoubaoAndSignIn")}</button>
          <button id="test" type="button" data-action="check-doubao">${htmlMessage("checkAgain")}</button>
        </div>
        <p data-role="doubao-status" role="status" aria-live="polite"></p>
        <p class="hint">${htmlMessage("ifYourSessionExpiresSignInAgainAnd")}</p>
      </div>`);
    providerForm.querySelector<HTMLButtonElement>("[data-action='open-doubao']")?.addEventListener("click", () => {
      void chrome.tabs.create({ url: "https://www.doubao.com/" }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
    });
    if (!isDoubaoBrowserSupported()) doubaoStatus = { state: "unsupported-browser" };
    renderDoubaoStatus();
    if (isDoubaoBrowserSupported() && !doubaoCheck) {
      const revision = doubaoStatusRevision;
      void sendRuntimeMessage<DoubaoStatus>({ type: "GET_DOUBAO_STATUS" }).then((result) => {
        if (version !== providerFormVersion || revision !== doubaoStatusRevision || !result) return;
        doubaoStatus = result;
        renderDoubaoStatus();
      }).catch(() => { /* Keep the actionable initial state if the background is restarting. */ });
    }
    return;
  }
  if (provider.type === "firefox-local") {
    setProviderFormMarkup(provider, `<div class="grid"><label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label></div><div data-local-model-control></div>`);
    updateLocalControl();
    return;
  }
  if (supportsServiceMode(provider)) {
    const api = translationApiOptions(provider);
    const fields = provider.type === "microsoft-web-translate"
      ? [["endpoint", "Endpoint", "url"], ["apiKey", "API Key", "password"], ["region", t("azureRegionOptional"), "text"]]
      : provider.type === "tencent-transmart"
        ? [["endpoint", "Base URL", "url"], ["apiKey", "TokenHub API Key", "password"], ["model", t("translationModel"), "text"]]
        : provider.type === "yandex-web-translate"
          ? [["apiKey", "Yandex Cloud API Key", "password"], ["folderId", t("folderIdIfRequiredByYourAccount"), "text"]]
          : provider.type === "volcengine-web-translate"
            ? [["accessKeyId", "Access Key ID", "password"], ["secretAccessKey", "Secret Access Key", "password"], ["region", t("region"), "text"]]
            : [["apiKey", provider.type === "mymemory" ? "RapidAPI Key" : "Google Cloud API Key", "password"]];
    const apiLabel = { "microsoft-web-translate": "Microsoft Translator API（Azure）", "google-web-translate": "Google Cloud Translation API",
      "tencent-transmart": t("tencentTokenhubTranslationApi"), "yandex-web-translate": "Yandex Cloud Translate API",
      "volcengine-web-translate": t("volcengineMachineTranslationApi"), "mymemory": "MyMemory（RapidAPI）" }[provider.type];
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>${htmlMessage("serviceMode")} <select data-field="serviceMode" aria-controls="translationApiFields">
          <option value="free" ${provider.serviceMode !== "api" ? "selected" : ""}>${htmlMessage("freeServiceDefault")}</option>
          <option value="api" ${provider.serviceMode === "api" ? "selected" : ""}>${htmlMessage("apiServiceOwnCredentials")}</option>
        </select></label>
      </div>
      <div id="translationApiFields" ${provider.serviceMode !== "api" ? "hidden" : ""}>
        <p class="hint">${htmlMessage("yourProviderDeterminesQuotaAndPricingSwitchingBack", apiLabel)}</p>
        <div class="grid">${fields.map(([name, label, type]) => `<label>${label}<input data-api-field="${name}" type="${type}" value="${escapeAttr(api[name as keyof TranslationApiOptions] ?? "")}" autocomplete="off" /></label>`).join("")}</div>
      </div>
    `);
    providerForm.querySelector<HTMLSelectElement>("[data-field='serviceMode']")!.addEventListener("change", event => {
      const useApi = (event.target as HTMLSelectElement).value === "api";
      providerForm.querySelector<HTMLElement>("#translationApiFields")!.hidden = !useApi;
    });
    return;
  }

  if (provider.type === "deepl") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>API Key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" autocomplete="off" /></label>
        <label>${htmlMessage("deepLEndpointLabel")} <input data-field="endpoint" type="url" value="${escapeAttr(provider.endpoint)}" placeholder="${htmlMessage("deepLAutoEndpoint")}" /></label>
      </div>
      <p class="hint">${htmlMessage("deepLSetupHint")}</p>
      <p class="hint"><a href="https://www.deepl.com/your-account/keys" target="_blank" rel="noreferrer">${htmlMessage("deepLManageKeys")}</a></p>
    `);
    return;
  }

  if (provider.type === "microsoft-translator") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Endpoint <input data-field="endpoint" type="url" value="${escapeAttr(provider.endpoint)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>${htmlMessage("region")} <input data-field="region" type="text" value="${escapeAttr(provider.region)}" placeholder="${htmlMessage("globalOrAnAzureRegion")}" /></label>
      </div>
    `);
    return;
  }

  if (provider.type === "google-cloud-translation") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
      </div>
    `);
    return;
  }

  if (provider.type === "openai-compatible" || provider.type === "anthropic-compatible" || provider.type === "index-translate") {
    const isAnthropic = provider.type === "anthropic-compatible";
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>${htmlMessage("apiKeyOptional")} <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>${htmlMessage("systemPrompt")} <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      ${provider.type !== "openai-compatible" ? "" : `
        <label>${htmlMessage("ollamaCompatibility")}
          <select data-field="ollamaCompatibility">
            <option value="enabled" ${provider.type === "openai-compatible" && provider.ollamaCompatibility !== false ? "selected" : ""}>${htmlMessage("enabledDefault")}</option>
            <option value="disabled" ${provider.type === "openai-compatible" && provider.ollamaCompatibility === false ? "selected" : ""}>${htmlMessage("disabledOption")}</option>
          </select>
        </label>
        <p class="hint">${htmlMessage("enabledByDefaultSupportsIpv4Ipv6CustomPorts")}</p>
      `}
      <p class="hint">${htmlMessage("apiFormat", isAnthropic ? "Anthropic Messages" : "OpenAI Chat Completions")}</p>
      ${provider.type === "index-translate" ? `<p class="hint">${htmlMessage("indexTranslateSetupHint")}</p>
        <p class="hint"><a href="https://github.com/bilibili/Index-Translate#inference" target="_blank" rel="noreferrer">${htmlMessage("indexTranslateSetupGuide")}</a></p>` : ""}
    `);
    return;
  }

  if (provider.type === "deepseek") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>${htmlMessage("systemPrompt")} <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">${htmlMessage("usesDeepseekChatCompletionsWithThinkingDisabledBy")}</p>
    `);
    return;
  }

  if (provider.type === "zhipu-glm") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>${htmlMessage("systemPrompt")} <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">${htmlMessage("usesZhipuGlmChatCompletionsDefaultApiAddress")}</p>
    `);
    return;
  }

  setProviderFormMarkup(provider, `
    <div class="grid">
      <label>${htmlMessage("displayName")} <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
      <label>${htmlMessage("requestMethod")}
        <select data-field="method">
          <option value="POST" ${provider.method === "POST" ? "selected" : ""}>POST</option>
          <option value="GET" ${provider.method === "GET" ? "selected" : ""}>GET</option>
        </select>
      </label>
      <label>URL <input data-field="url" type="url" value="${escapeAttr(provider.url)}" /></label>
      <label>${htmlMessage("responsePath")} <input data-field="responsePath" type="text" value="${escapeAttr(provider.responsePath)}" /></label>
    </div>
    <label>${htmlMessage("requestHeadersJson")} <textarea data-field="headers">${escapeHtml(JSON.stringify(provider.headers, null, 2))}</textarea></label>
    <label>${htmlMessage("requestBodyTemplate")} <textarea data-field="bodyTemplate">${escapeHtml(provider.bodyTemplate)}</textarea></label>
  `);
}

function renderDoubaoStatus(): void {
  if (optionsClosed || getEditingProvider().type !== "doubao-web") return;
  const statusElement = providerForm.querySelector<HTMLElement>("[data-role='doubao-status']");
  const checkButton = providerForm.querySelector<HTMLButtonElement>("[data-action='check-doubao']");
  const retryIn = Math.max(0, (doubaoStatus.retryAt ?? 0) - Date.now());
  if (statusElement) {
    statusElement.textContent = formatDoubaoStatus(doubaoStatus);
    statusElement.dataset.state = doubaoStatus.state;
  }
  const disabled = Boolean(doubaoCheck) || doubaoStatus.state === "checking" || !isDoubaoBrowserSupported() || retryIn > 0;
  if (checkButton) checkButton.disabled = disabled;
  clearTimeout(doubaoRetryTimer);
  if (retryIn > 0) doubaoRetryTimer = setTimeout(renderDoubaoStatus, Math.min(retryIn + 10, 1000));
  else if (doubaoStatus.state === "checking" && !doubaoCheck) {
    const version = providerFormVersion;
    const revision = doubaoStatusRevision;
    doubaoRetryTimer = setTimeout(() => {
      void sendRuntimeMessage<DoubaoStatus>({ type: "GET_DOUBAO_STATUS" }).then((result) => {
        if (version !== providerFormVersion || revision !== doubaoStatusRevision || !result) return;
        doubaoStatus = result;
        renderDoubaoStatus();
      }).catch(() => {
        if (version !== providerFormVersion || revision !== doubaoStatusRevision) return;
        doubaoStatus = { state: "network-error" };
        renderDoubaoStatus();
      });
    }, 1000);
  }
}

function checkDoubao(): Promise<void> {
  if (doubaoCheck) return doubaoCheck;
  if (!isDoubaoBrowserSupported()) {
    doubaoStatus = { state: "unsupported-browser" };
    renderDoubaoStatus();
    return Promise.resolve();
  }
  if ((doubaoStatus.retryAt ?? 0) > Date.now()) return Promise.resolve();
  doubaoStatusRevision += 1;
  doubaoStatus = { state: "checking" };
  doubaoCheck = sendRuntimeMessage<DoubaoStatus>({ type: "CHECK_DOUBAO" })
    .then((result) => { doubaoStatus = result; })
    .catch(() => { doubaoStatus = { state: "network-error", checkedAt: Date.now() }; })
    .finally(() => {
      doubaoCheck = undefined;
      renderDoubaoStatus();
    });
  renderDoubaoStatus();
  return doubaoCheck;
}

function updateLocalControl(): void {
  const container = providerForm.querySelector<HTMLElement>("[data-local-model-control]");
  if (!container) return;
  disposeLocalControl?.();
  disposeLocalControl = setupLocalModelControl(container, sourceLang.value, targetLang.value);
}

function setProviderFormMarkup(provider: ProviderConfig, markup: string): void {
  providerForm.dataset.providerId = provider.id;
  providerForm.innerHTML = markup;
  setupProviderTabs(providerForm, provider);
  if (!providerForm.querySelector("#test")) {
    providerForm.insertAdjacentHTML("beforeend", `<div class="provider-test-action">${renderTestButton()}</div>`);
  }
  providerForm.insertAdjacentHTML("beforeend", '<p data-role="provider-test-status" class="hint" role="status" hidden></p>');
  const usage = document.createElement("aside"); usage.id = "providerUsage";
  providerForm.append(usage);
  renderProviderUsage(usage, provider);
  updateUsageScheduling();
  providerForm.querySelector("#test")?.addEventListener("click", testProvider);
  providerForm.querySelector("[data-action='test-provider']")?.addEventListener("click", testProvider);
  providerForm.querySelector("[data-action='manage-model']")?.addEventListener("click", () => {
    settings = readSettingsFromForm();
    modelAction.value = "add";
    customModelName.value = "";
    query<HTMLElement>("#modelStatus").textContent = "";
    modelDialog.showModal();
    customModelName.focus();
  });
}

function updateProviderUsage(): void {
  const container = providerForm.querySelector<HTMLElement>("#providerUsage");
  if (!container) return;
  renderProviderUsage(container, readProviderFromForm(getEditingProvider()));
  updateUsageScheduling();
}

function updateUsageScheduling(): void {
  refreshUsageScheduling(readProviderFromForm(getEditingProvider()));
}

function refreshUsageScheduling(base: ProviderConfig): void {
  const container = providerForm.querySelector<HTMLElement>("#providerUsage");
  if (!container) return;
  const provider = { ...base, ...readProviderPerformance() } as ProviderConfig;
  const value = (input: HTMLInputElement, fallback: number, min: number, max: number): number => {
    const number = Number(input.value);
    return input.value && Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  updateProviderScheduling(container, provider, { ...settings,
    chunkSize: value(chunkSize, settings.chunkSize, 200, 4000), concurrency: value(concurrency, settings.concurrency, 1, 8),
    providers: settings.providers.map(entry => entry.id === provider.id ? provider : entry) });
}

type ModelProvider = Extract<ProviderConfig, { model: string }>;

function modelPresets(provider: ModelProvider): string[] {
  if (provider.type === "index-translate") return ["Index-Translate-35B-A3B", "Index-Translate-9B", "Index-Translate-2B"];
  if (provider.type === "deepseek") return DEEPSEEK_MODEL_OPTIONS;
  if (provider.type === "zhipu-glm") return ZHIPU_MODEL_OPTIONS;
  return provider.type === "openai-compatible" ? LLM_MODEL_OPTIONS : [];
}

function renderTestButton(): string {
  return `<button id="test" type="button" class="secondary">${htmlMessage("testService")}</button>`;
}

function renderModelControl(provider: ModelProvider): string {
  const models = [...new Set([...modelPresets(provider), ...(provider.customModels ?? [])])];
  return `<div class="model-field">
    <label for="providerModel">${htmlMessage("model")}</label>
    <div class="model-toolbar">
      <select id="providerModel" data-field="model">${renderOptions(models, provider.model)}</select>
      <button type="button" class="icon-button add-model" data-action="manage-model" title="${htmlMessage("addOrEditModel")}" aria-label="${htmlMessage("addOrEditModel")}">${uiIconMarkup("plus")}</button>
      ${renderTestButton()}
    </div>
  </div>`;
}

async function saveModel(): Promise<void> {
  try {
    const provider = getEditingProvider();
    if (!("model" in provider)) return;
    const model = customModelName.value.trim();
    if (!model) {
      query<HTMLElement>("#modelStatus").textContent = t("enterAModelName");
      return;
    }
    const presets = modelPresets(provider);
    const previous = [...new Set([...(provider.customModels ?? []),
      ...(!presets.includes(provider.model) ? [provider.model] : [])])];
    const customModels = [...new Set([
      ...previous.filter((name) => modelAction.value !== "edit" || name !== provider.model),
      ...(!presets.includes(model) ? [model] : [])
    ])];
    settings.providers = settings.providers.map((entry) => entry.id === provider.id
      ? { ...provider, model, customModels } : entry);
    await persistSettings(false);
    modelDialog.close();
    render();
    setStatus(t("savedModel", model));
  } catch (error) {
    query<HTMLElement>("#modelStatus").textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderProviderPerformanceControls(provider: ProviderConfig): void {
  providerPerformance.innerHTML = provider.type === "firefox-local"
    ? `<p class="hint">${htmlMessage("localTranslationUsesAFixedChunkSizeOf")}</p>`
    : provider.type === "doubao-web"
      ? `<p class="hint">${htmlMessage("doubaoUsesAFixedChunkSizeOf1200")}</p>`
      : renderProviderPerformance(provider);
  providerPerformance.querySelector("[data-field='inheritPerformance']")
    ?.addEventListener("change", updateProviderPerformanceFields);
  updateProviderPerformanceFields();
}

function renderProviderPerformance(provider: ProviderConfig): string {
  const inherited = provider.performanceMode !== "custom";
  return `
    <fieldset class="provider-performance">
      <legend>${htmlMessage("currentServiceName", provider.label)}</legend>
      <label class="setting-toggle performance-inherit">
        <span>${htmlMessage("useGeneralPerformanceSettings")}</span>
        <input data-field="inheritPerformance" type="checkbox" role="switch" ${inherited ? "checked" : ""} />
        <span class="setting-toggle-control" aria-hidden="true"></span>
      </label>
      <div class="grid performance-overrides" data-role="performanceOverrides" ${inherited ? "hidden" : ""}>
        <label>${htmlMessage("chunkSize")}
          <input data-field="chunkSize" type="number" min="200" max="4000" value="${provider.chunkSize ?? settings.chunkSize}" />
        </label>
        <label>${htmlMessage("serviceConcurrency")}
          <input data-field="concurrency" type="number" min="1" max="${settings.concurrency}" value="${provider.concurrency ?? settings.concurrency}" />
        </label>
      </div>
      <p class="hint">${htmlMessage("serviceConcurrencyIsCappedByTheGlobalMaximum")}</p>
    </fieldset>
  `;
}

function updateProviderPerformanceFields(): void {
  const inherit = providerPerformance.querySelector<HTMLInputElement>("[data-field='inheritPerformance']");
  const overrides = providerPerformance.querySelector<HTMLElement>("[data-role='performanceOverrides']");
  if (!inherit || !overrides) return;
  overrides.hidden = inherit.checked;
  overrides.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
    input.disabled = inherit.checked;
  });
}

async function handleProviderAction(action: string, providerId: string): Promise<void> {
  try {
    if (action === "select") await selectProvider(providerId);
    if (action === "toggle") await toggleProvider(providerId);
    if (action === "delete") await deleteProvider(providerId);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function selectProvider(providerId: string): Promise<void> {
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (!provider || isDoubaoProviderUnavailable(provider)) return;
  invalidateProviderTest();
  settings = readSettingsFromForm();
  if (provider.enabled !== false) settings.activeProviderId = providerId;
  await persistSettings(false);
  editingProviderId = providerId;
  renderProviderPicker(false);
  renderProviderForm();
  setStatus(provider.enabled === false ? t("disabledServiceSelectedYouCanEditItsConfiguration") : t("currentServiceChanged"));
}

async function toggleProvider(providerId: string): Promise<void> {
  settings = readSettingsFromForm();
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (!provider) return;
  const nextEnabled = provider.enabled === false;
  if (!nextEnabled) {
    const hasOtherEnabled = settings.providers.some(
      (entry) => entry.id !== providerId && entry.enabled !== false
    );
    if (!hasOtherEnabled) {
      setStatus(t("enableAtLeastOneTranslationService"));
      return;
    }
  }
  settings.providers = settings.providers.map((entry) =>
    entry.id === providerId ? { ...entry, enabled: nextEnabled } : entry
  );
  if (!nextEnabled && settings.activeProviderId === providerId) {
    settings.activeProviderId = settings.providers.find((entry) => entry.enabled !== false)!.id;
  }
  await persistSettings(false);
  renderProviderPicker(true);
  renderProviderForm();
  setStatus(nextEnabled ? t("serviceEnabled") : t("serviceDisabled"));
}

async function deleteProvider(providerId: string): Promise<void> {
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) return;
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (!provider || !window.confirm(t("confirmDeleteProvider", provider.label))) return;
  settings = readSettingsFromForm();
  settings.providers = settings.providers.filter((entry) => entry.id !== providerId);
  if (settings.activeProviderId === providerId) {
    settings.activeProviderId = settings.providers.find((entry) => entry.enabled !== false)?.id
      ?? DEFAULT_SETTINGS.activeProviderId;
  }
  if (editingProviderId === providerId) editingProviderId = settings.activeProviderId;
  await persistSettings(false);
  renderProviderPicker(true);
  renderProviderForm();
  setStatus(t("customServiceDeleted"));
}

function openProviderDialog(): void {
  setProviderMenuOpen(false);
  customProviderName.value = "";
  customProviderKind.value = "http";
  customLlmFormat.value = "openai";
  updateCustomProviderFields();
  providerDialog.showModal();
  window.setTimeout(() => customProviderName.focus(), 0);
}

function updateCustomProviderFields(): void {
  customLlmFormatField.hidden = customProviderKind.value !== "llm";
}

async function addCustomProvider(): Promise<void> {
  try {
    settings = readSettingsFromForm();
    const provider = createCustomProvider(
      customProviderName.value.trim(),
      customProviderKind.value,
      customLlmFormat.value
    );
    settings.providers = [...settings.providers, provider];
    settings.activeProviderId = provider.id;
    await persistSettings(false);
    editingProviderId = provider.id;
    providerDialog.close();
    render();
    setStatus(t("customServiceAddedCompleteItsConfigurationAndSave"));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

function createCustomProvider(name: string, kind: string, llmFormat: string): ProviderConfig {
  const id = createCustomProviderId(kind === "llm" ? llmFormat : kind);
  if (kind === "http") {
    return {
      type: "http-template",
      id,
      label: name || t("customHttp"),
      enabled: true,
      performanceMode: "inherit",
      method: "POST",
      url: "",
      headers: { "Content-Type": "application/json" },
      bodyTemplate: "{\"q\":{{json texts}},\"source\":\"{{sourceLang}}\",\"target\":\"{{targetLang}}\"}",
      responsePath: "translations"
    };
  }
  if (llmFormat === "anthropic") {
    return {
      type: "anthropic-compatible",
      id,
      label: name || t("customAnthropicLlm"),
      enabled: true,
      performanceMode: "custom",
      chunkSize: 3200,
      concurrency: settings.concurrency,
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "",
      model: "claude-3-5-haiku-latest",
      systemPrompt: DEFAULT_LLM_PROMPT
    };
  }
  return {
    type: "openai-compatible",
    id,
    label: name || t("customOpenaiLlm"),
    enabled: true,
    performanceMode: "custom",
    chunkSize: 3200,
    concurrency: settings.concurrency,
    baseURL: "https://api.openai.com/v1",
    ollamaCompatibility: true,
    apiKey: "",
    model: "gpt-4o-mini",
    systemPrompt: DEFAULT_LLM_PROMPT
  };
}

function createCustomProviderId(kind: string): string {
  return `custom-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function save(): Promise<void> {
  setStatus("");
  const selected = interfaceLanguageSelect.value as InterfaceLanguage;
  const languageChange = selected !== getInterfaceLanguage() ? selected : undefined;
  if (languageChange) saveButton.disabled = true;
  try {
    settings = readSettingsFromForm();
    await persistSettings(false, languageChange);
    if (languageChange) {
      location.reload();
      return;
    }
    render();
    setStatus(t("saved"), ACTION_STATUS_DURATION);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (languageChange) saveButton.disabled = false;
  }
}

function persistSettings(showSavedStatus: boolean, interfaceLanguage?: InterfaceLanguage): Promise<void> {
  const write = persistSettingsNow(showSavedStatus, interfaceLanguage);
  pendingSettingsWrites.add(write);
  void write.then(() => pendingSettingsWrites.delete(write), () => pendingSettingsWrites.delete(write));
  return write;
}

async function persistSettingsNow(showSavedStatus: boolean, interfaceLanguage?: InterfaceLanguage): Promise<void> {
  const previousSettings = cloneSettings(savedSettings);
  // A service test leaves the current form mounted. Compare its fields with
  // what that form displayed, even if the previous save merged external edits.
  const formSettings = providerFormSettings;
  if (formSettings) previousSettings.providers = previousSettings.providers.map(provider =>
    provider.id === formSettings.id ? formSettings : provider);
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings, previousSettings, ...(interfaceLanguage ? { interfaceLanguage } : {}) });
  if (interfaceLanguage) return;
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  savedSettings = cloneSettings(settings);
  // Provider actions can save without rebuilding the provider form (for
  // example while a service test owns its status node). Keep every other
  // control aligned with the merged settings used as the next edit baseline.
  renderGeneralSettings();
  if (showSavedStatus) setStatus(t("saved"), ACTION_STATUS_DURATION);
}

function invalidateProviderTest(): void {
  const previous = activeProviderTest;
  activeProviderTest = undefined;
  if (!previous) return;
  previous.status.hidden = true;
  previous.status.textContent = "";
  if (previous.message && status.textContent === previous.message) setStatus("");
}

async function testProvider(): Promise<void> {
  if (getEditingProvider().type === "doubao-web") {
    await checkDoubao();
    return;
  }
  invalidateProviderTest();
  const inlineStatus = providerForm.querySelector<HTMLElement>("[data-role='provider-test-status']");
  if (!inlineStatus) return;
  const run = { providerId: getEditingProvider().id, status: inlineStatus, message: "" };
  activeProviderTest = run;
  const isCurrent = (): boolean => activeProviderTest === run
    && getEditingProvider().id === run.providerId && run.status.isConnected;
  const report = (message: string): void => {
    if (!isCurrent()) return;
    run.message = message;
    setStatus(message);
    run.status.hidden = false;
    run.status.textContent = message;
  };
  try {
    settings = readSettingsFromForm();
    report(t("testing"));
    await persistSettings(false);
    if (!isCurrent()) return;
    const result = await sendRuntimeMessage<{ translation: string }>({
      type: "TEST_PROVIDER",
      providerId: run.providerId
    });
    report(t("testPassed", result.translation));
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  }
}

function restorePageDefaults(): void {
  const panel = document.querySelector<HTMLElement>(".settings-panel:not([hidden])");
  switch (panel?.id) {
    case "generalSettings":
      interfaceLanguageSelect.value = "browser";
      renderGeneralPageSettings(DEFAULT_SETTINGS);
      syncDoubaoTargetControls(settings, targetLang); updateLocalControl();
      break;
    case "selectionTranslationSettings": renderSelectionSettings(DEFAULT_SETTINGS); break;
    case "autoTranslationSettings": autoTranslationControls.render(DEFAULT_SETTINGS.autoTranslation); break;
    case "elementExclusionSettings": elementRuleControls.render(DEFAULT_SETTINGS); break;
    case "shortcutSettings": shortcutControls.reset(); break;
    case "appearanceSettings": appearanceControls.render(DEFAULT_SETTINGS.appearance); break;
    case "statisticsSettings": statisticsControls.reset(); break;
    case "providerSettings": {
      const provider = getEditingProvider();
      const resetCurrent = BUILT_IN_PROVIDER_IDS.has(provider.id) && provider.type !== "http-template";
      // Preserve even unsaved credentials without reading or validating other pages.
      const draft = resetCurrent ? readProviderFromForm(provider) : provider;
      settings.providers = settings.providers.map(entry => restoreProviderParameters(entry.id === provider.id ? draft : entry));
      renderProviderPicker(false);
      if (resetCurrent) {
        // Save must compare restored fields with the original form, not the defaults just rendered.
        const baseline = providerFormSettings;
        renderProviderForm(false);
        providerFormSettings = baseline;
      }
      setStatus(t("builtInServiceDefaultsRestoredCredentialsAndCustom"), ACTION_STATUS_DURATION);
      return;
    }
    case "performanceSettings":
      settings.providers = settings.providers.map(provider => ({ ...provider, ...defaultProviderPerformance(provider) }));
      renderPerformanceSettings(DEFAULT_SETTINGS);
      renderProviderPerformanceControls(getEditingProvider());
      refreshUsageScheduling(getEditingProvider());
      break;
    default: return;
  }
  setStatus(t("sectionDefaultsRestoredSaveToApply"), ACTION_STATUS_DURATION);
}

async function resetSettings(): Promise<void> {
  // Commit first: cancellation or failed storage must not replace the draft or
  // its baseline. The background returns the value from this exact write.
  // Finish existing saves and their UI continuations before replacing state.
  await Promise.allSettled([...pendingSettingsWrites]);
  const reset = await sendRuntimeMessage<ExtensionSettings>({ type: "RESET_SETTINGS" });
  if (optionsClosed) return;
  if (getInterfaceLanguage() !== "browser") {
    location.reload();
    return;
  }
  interfaceLanguageSelect.value = "browser";
  invalidateProviderTest();
  settings = reset;
  savedSettings = cloneSettings(reset);
  editingProviderId = undefined;
  setProviderMenuOpen(false);
  render();
  setStatus(t("allSettingsReset"), ACTION_STATUS_DURATION);
}

function readSettingsFromForm(): ExtensionSettings {
  let appearance: ReturnType<typeof appearanceControls.read>;
  try { appearance = appearanceControls.read(); }
  catch (error) {
    settingsNavigation.reveal(query<HTMLElement>("#appearanceSettings"));
    query<HTMLElement>("#appearanceSettings [aria-invalid='true']").focus();
    throw error;
  }
  const activeProvider = {
    ...readProviderFromForm(getEditingProvider()),
    ...(getEditingProvider().type === "firefox-local" ? { performanceMode: "custom", chunkSize: 800, concurrency: 1 }
      : getEditingProvider().type === "doubao-web" ? { performanceMode: "custom", chunkSize: 1200, concurrency: 1 }
        : readProviderPerformance())
  } as ProviderConfig;
  if (supportsRequestTemplate(activeProvider)) {
    try {
      validateRequestTemplate(activeProvider.requestTemplate);
    } catch (error) {
      if (error instanceof RequestTemplateError) {
        providerForm.querySelector<HTMLButtonElement>("#providerAdvancedTab")!.click();
        const field = providerForm.querySelector<HTMLTextAreaElement>(
          `[data-field='${error.field === "headers" ? "requestHeadersTemplate" : "requestBodyTemplate"}']`
        )!;
        settingsNavigation.reveal(field);
        field.setAttribute("aria-invalid", "true");
        const message = providerForm.querySelector<HTMLElement>("[data-role='request-template-status']")!;
        message.textContent = error.message;
        message.hidden = false;
        field.focus();
      }
      throw error;
    }
  }
  const ocr = ocrSettingsControls?.read();
  return {
    ...settings,
    ...(settings.ocr !== undefined || ocr && JSON.stringify(ocr) !== JSON.stringify(DEFAULT_OCR_SETTINGS) ? { ocr } : {}),
    appearance,
    shortcuts: shortcutControls.read(),
    localShortcuts: shortcutControls.readLocal(),
    shortcutEnabled: shortcutControls.readEnabled(),
    autoTranslation: autoTranslationControls.read(),
    ...elementRuleControls.read(),
    frameTranslation: normalizeFrameTranslation({ enabled: frameTranslationEnabled.checked,
      excludeMatches: frameTranslationExcluded.value.split(/\r?\n/u) }),
    targetLang: targetLang.value.trim() || "zh-CN",
    sourceLang: sourceLang.value.trim() || "auto",
    activeProviderId: settings.activeProviderId,
    chunkSize: Number(chunkSize.value),
    concurrency: Number(concurrency.value),
    pdfTranslationPageRadius: pdfTranslationScope.value === "unlimited" ? null
      : pdfTranslationPageRadius.value === "" ? DEFAULT_SETTINGS.pdfTranslationPageRadius : Number(pdfTranslationPageRadius.value),
    cacheEnabled: cacheEnabled.checked,
    statisticsEnabled: statisticsControls.read(),
    floatingBallEnabled: floatingBallEnabled.checked,
    selectionTranslation: {
      enabled: selectionTranslationEnabled.checked,
      provider: selectionDictionary.value as DictionaryProvider,
      style: selectionTriggerStyle.value as SelectionTriggerStyle
    },
    imageTranslationEnabled: imageTranslationEnabled.checked,
    translateCodeComments: translateCodeComments.checked,
    translationDisplayMode: translationDisplayMode.value as ExtensionSettings["translationDisplayMode"],
    providers: settings.providers.map((provider) =>
      provider.id === activeProvider.id ? activeProvider : provider
    )
  };
}

function readProviderPerformance(): Pick<
  ProviderConfig,
  "performanceMode" | "chunkSize" | "concurrency"
> {
  const inherit = providerPerformance.querySelector<HTMLInputElement>("[data-field='inheritPerformance']");
  if (!inherit || inherit.checked) {
    return {
      performanceMode: "inherit",
      chunkSize: undefined,
      concurrency: undefined
    };
  }
  const providerChunkSize = providerPerformance.querySelector<HTMLInputElement>("[data-field='chunkSize']");
  const providerConcurrency = providerPerformance.querySelector<HTMLInputElement>("[data-field='concurrency']");
  return {
    performanceMode: "custom",
    chunkSize: Number(providerChunkSize?.value),
    concurrency: Number(providerConcurrency?.value)
  };
}

function readProviderFromForm(provider: ProviderConfig): ProviderConfig {
  const field = (name: string) =>
    providerForm.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-field="${name}"]`
    )?.value ?? "";

  if ("model" in provider) {
    // Retain models from older settings before replacing the current selection.
    const previousModel = provider.model.trim();
    if (previousModel && !modelPresets(provider).includes(previousModel)) {
      provider = { ...provider, customModels: [...new Set([...(provider.customModels ?? []), previousModel])] };
    }
  }
  if (supportsRequestTemplate(provider)) {
    provider = { ...provider, requestTemplate: readRequestTemplate(providerForm) };
  }

  if (supportsServiceMode(provider)) {
    const api = { ...provider.api };
    providerForm.querySelectorAll<HTMLInputElement>("[data-api-field]").forEach(input => {
      api[input.dataset.apiField as keyof TranslationApiOptions] = input.value.trim();
    });
    return { ...provider, label: field("label").trim() || provider.label,
      serviceMode: field("serviceMode") === "api" ? "api" : "free", api };
  }
  if (provider.type === "firefox-local" || provider.type === "doubao-web") {
    return { ...provider, label: field("label").trim() || provider.label };
  }
  if (provider.type === "microsoft-translator") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      endpoint: field("endpoint").trim() || "https://api.cognitive.microsofttranslator.com",
      apiKey: field("apiKey"),
      region: field("region").trim()
    };
  }
  if (provider.type === "deepl") {
    return { ...provider, label: field("label").trim() || provider.label,
      endpoint: field("endpoint").trim(), apiKey: field("apiKey").trim() };
  }
  if (provider.type === "google-cloud-translation") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      apiKey: field("apiKey")
    };
  }
  if (provider.type === "openai-compatible" || provider.type === "anthropic-compatible" || provider.type === "index-translate") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      baseURL: field("baseURL").trim(),
      apiKey: field("apiKey"),
      model: field("model").trim(),
      systemPrompt: field("systemPrompt"),
      ...(provider.type === "openai-compatible" ? {
        ollamaCompatibility: field("ollamaCompatibility") === "enabled"
      } : {})
    };
  }
  if (provider.type === "deepseek") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      baseURL: field("baseURL").trim() || "https://api.deepseek.com",
      apiKey: field("apiKey"),
      model: field("model").trim() || "deepseek-flash",
      systemPrompt: field("systemPrompt")
    };
  }
  if (provider.type === "zhipu-glm") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      baseURL: field("baseURL").trim() || "https://open.bigmodel.cn/api/paas/v4",
      apiKey: field("apiKey"),
      model: field("model").trim() || "glm-4-flash-250414",
      systemPrompt: field("systemPrompt")
    };
  }
  return {
    ...provider,
    label: field("label").trim() || provider.label,
    method: field("method") === "GET" ? "GET" : "POST",
    url: field("url").trim(),
    responsePath: field("responsePath").trim(),
    headers: parseHeaders(field("headers")),
    bodyTemplate: field("bodyTemplate")
  };
}

function parseHeaders(value: string): Record<string, string> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("requestHeadersMustBeAJsonObject"));
  }
  if (!Object.values(parsed).every((entry) => typeof entry === "string")) {
    throw new Error(t("requestHeaderValuesMustBeStrings"));
  }
  return parsed as Record<string, string>;
}

function getEditingProvider(): ProviderConfig {
  const provider = settings.providers.find((entry) => entry.id === editingProviderId)
    ?? settings.providers.find((entry) => entry.id === settings.activeProviderId);
  if (!provider) throw new Error(t("currentTranslationServiceNotFound"));
  editingProviderId = provider.id;
  return provider;
}

function setProviderMenuOpen(open: boolean): void {
  providerMenu.hidden = !open;
  providerTrigger.setAttribute("aria-expanded", String(open));
}

function setStatus(value: string, duration?: number): void {
  clearTimeout(statusTimer);
  statusTimer = undefined;
  status.textContent = value;
  if (duration !== undefined) {
    statusTimer = setTimeout(() => {
      status.textContent = "";
      statusTimer = undefined;
    }, duration);
  }
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function renderOptions(values: string[], selected: string): string {
  const options = values.includes(selected) ? values : [selected, ...values];
  return options
    .map((value) =>
      `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`
    )
    .join("");
}

function cloneSettings(value: ExtensionSettings): ExtensionSettings {
  return JSON.parse(JSON.stringify(value)) as ExtensionSettings;
}
