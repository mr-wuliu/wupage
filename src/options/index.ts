import { BUILT_IN_PROVIDER_IDS, DEFAULT_SETTINGS } from "../shared/defaults";
import { normalizeFrameTranslation } from "../shared/frame-session";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import { sendRuntimeMessage } from "../shared/messaging";
import type { DoubaoStatus, ExtensionSettings, ProviderConfig, TranslationApiOptions } from "../shared/types";
import { supportsServiceMode, translationApiOptions } from "../shared/translation-service";
import "./styles.css";
import type { OcrStatus } from "../shared/ocr";
import { setImageTranslationToggle, setupOcrControl } from "../shared/ocr-control";
import { setupLocalModelControl } from "../local/control";
import { ensureProviderIconStyles, providerIconMarkup } from "../shared/provider-icons";
import { setupAutoTranslationControls } from "./auto-translation";
import { renderProviderUsage, updateProviderScheduling } from "./provider-usage";
import { setupSettingsNavigation } from "./navigation";
import { setupShortcutSettings } from "./shortcuts";
import { setupAppearanceControls } from "./appearance";
import "../shared/appearance.css";
import { normalizeSelectionTranslation, type DictionaryProvider, type SelectionTriggerStyle } from "../shared/dictionary";
import { RequestTemplateError, supportsRequestTemplate, validateRequestTemplate } from "../shared/request-template";
import { readRequestTemplate, setupProviderTabs } from "./provider-advanced";
import { isDoubaoBrowserSupported } from "../shared/doubao";
import { formatDoubaoStatus, isDoubaoProviderUnavailable, syncDoubaoTargetControls } from "../shared/doubao-ui";
import { renderUiIcons, uiIconMarkup } from "../shared/ui-icons";
import {
  createSettingsBackup,
  parseSettingsBackup,
  SETTINGS_BACKUP_MAX_BYTES,
  settingsBackupFileName
} from "../shared/settings-backup";

renderUiIcons();

const settingsNavigation = setupSettingsNavigation(query<HTMLElement>(".settings"));
const shortcutControls = setupShortcutSettings(query<HTMLElement>("#shortcutSettings"));
const appearanceControls = setupAppearanceControls(query<HTMLElement>("#appearanceSettings"));

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
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
const restoreButton = query<HTMLButtonElement>("#restore");
const exportSettingsButton = query<HTMLButtonElement>("#exportSettings");
const importSettingsButton = query<HTMLButtonElement>("#importSettings");
const importSettingsFile = query<HTMLInputElement>("#importSettingsFile");
const backupStatus = query<HTMLParagraphElement>("#backupStatus");
const status = query<HTMLParagraphElement>("#status");
const autoTranslationControls = setupAutoTranslationControls(
  query<HTMLElement>("#autoTranslationSettings"), field => {
    settingsNavigation.reveal(field);
    field.scrollIntoView?.({ block: "center" });
  }
);
const frameTranslationEnabled = query<HTMLInputElement>("#frameTranslationEnabled");
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
let editingProviderId: string | undefined;
let disposeLocalControl: (() => void) | undefined;
let activeProviderTest: { providerId: string; status: HTMLElement; message: string } | undefined;
let providerFormVersion = 0;
let doubaoStatus: DoubaoStatus = { state: "unknown" };
let doubaoCheck: Promise<void> | undefined;
let doubaoStatusRevision = 0;
let doubaoRetryTimer: ReturnType<typeof setTimeout> | undefined;
let optionsClosed = false;

window.addEventListener("pagehide", () => {
  optionsClosed = true;
  clearTimeout(doubaoRetryTimer);
}, { once: true });

void init().catch((error: unknown) => {
  setStatus(error instanceof Error ? error.message : String(error));
});

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  render();
  setupOcrControl(imageTranslationEnabled, () => { settings.imageTranslationEnabled = false; setImageTranslationToggle(imageTranslationEnabled, false); });
  const imageNotice = new URLSearchParams(location.search).get("imageTranslationNotice");
  if (imageNotice === "setup") setStatus("使用右键图片翻译前，请先点击扳手安装 OCR 模型，开启图片翻译并保存。");
  if (imageNotice === "refresh") setStatus("无法连接图片所在页面。请刷新刚才的网页，再右键点击图片翻译；部分嵌入页面暂不支持。");
  if (imageNotice) {
    settingsNavigation.reveal(imageTranslationEnabled);
    imageTranslationEnabled.closest(".image-feature")?.scrollIntoView?.({ block: "center" });
  }
  if (new URLSearchParams(location.search).get("pageTranslationNotice") === "refresh") {
    setStatus("无法连接网页。请刷新刚才的网页，再右键选择全文翻译。");
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
  saveButton.addEventListener("click", () => { void save().catch(() => {}); });
  restoreButton.addEventListener("click", restoreDefaults);
  exportSettingsButton.addEventListener("click", () => { void exportSettingsBackup(); });
  importSettingsButton.addEventListener("click", () => importSettingsFile.click());
  importSettingsFile.addEventListener("change", () => { void importSettingsBackup(); });
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
  shortcutControls.render(settings.shortcuts, settings.shortcutEnabled, settings.localShortcuts);
  appearanceControls.render(settings.appearance);
  autoTranslationControls.render(settings.autoTranslation);
  const frameTranslation = normalizeFrameTranslation(settings.frameTranslation);
  frameTranslationEnabled.checked = frameTranslation.enabled;
  frameTranslationExcluded.value = frameTranslation.excludeMatches.join("\n");
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  chunkSize.value = String(settings.chunkSize);
  concurrency.value = String(settings.concurrency);
  pdfTranslationScope.value = settings.pdfTranslationPageRadius === null ? "unlimited" : "nearby";
  pdfTranslationPageRadius.value = String(settings.pdfTranslationPageRadius ?? DEFAULT_SETTINGS.pdfTranslationPageRadius);
  updatePdfTranslationScope();
  cacheEnabled.checked = settings.cacheEnabled;
  floatingBallEnabled.checked = settings.floatingBallEnabled;
  const selection = normalizeSelectionTranslation(settings.selectionTranslation);
  selectionTranslationEnabled.checked = selection.enabled;
  selectionTranslationFields.disabled = !selection.enabled;
  selectionDictionary.value = selection.provider;
  selectionTriggerStyle.value = selection.style;
  setImageTranslationToggle(imageTranslationEnabled, settings.imageTranslationEnabled === true);
  translateCodeComments.checked = settings.translateCodeComments;
  translationDisplayMode.innerHTML = TRANSLATION_DISPLAY_MODES
    .map((mode) => `<option value="${mode.value}">${mode.label}</option>`)
    .join("");
  translationDisplayMode.value = settings.translationDisplayMode;
  updateTranslationDisplayModeDescription();
  renderProviderPicker(false);
  renderProviderForm();
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
        title="${unavailable ? "此浏览器暂不支持豆包翻译" : `${escapeAttr(provider.label)}${enabled ? "" : "（已停用，可编辑）"}`}"
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
        title="${enabled ? "停用" : "启用"} ${escapeAttr(provider.label)}"
        aria-label="${enabled ? "停用" : "启用"} ${escapeAttr(provider.label)}"
      ></button>
      ${builtIn ? "" : `
        <button
          class="provider-delete"
          type="button"
          data-action="delete"
          data-provider-id="${escapeAttr(provider.id)}"
          title="删除 ${escapeAttr(provider.label)}"
          aria-label="删除 ${escapeAttr(provider.label)}"
        >${uiIconMarkup("trash")}</button>
      `}
    </div>
  `;
}

function renderProviderForm(): void {
  invalidateProviderTest();
  const version = ++providerFormVersion;
  clearTimeout(doubaoRetryTimer);
  disposeLocalControl?.(); disposeLocalControl = undefined;
  const provider = getEditingProvider();
  providerPerformance.innerHTML = provider.type === "firefox-local"
    ? '<p class="hint">本地翻译使用固定分块大小 800、并发数 1。</p>'
    : provider.type === "doubao-web"
      ? '<p class="hint">豆包翻译使用固定分块大小 1200、并发数 1。</p>'
      : renderProviderPerformance(provider);
  providerPerformance.querySelector("[data-field='inheritPerformance']")
    ?.addEventListener("change", updateProviderPerformanceFields);
  updateProviderPerformanceFields();
  syncDoubaoTargetControls(settings, targetLang);
  if (provider.type === "doubao-web") {
    setProviderFormMarkup(provider, `
      <div class="grid"><label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label></div>
      <div class="doubao-setup">
        <h3>豆包（实验性）</h3>
        <p>无需 API Key。在当前浏览器打开豆包并登录，即可开始翻译。连接异常时可点击“重新检测”。</p>
        <p>翻译会将待译文本发送到豆包；检测只发送固定短文本。</p>
        <div class="doubao-actions">
          <button type="button" data-action="open-doubao">打开豆包并登录</button>
          <button id="test" type="button" data-action="check-doubao">重新检测</button>
        </div>
        <p data-role="doubao-status" role="status" aria-live="polite"></p>
        <p class="hint">如提示登录失效，请重新登录后重试翻译，或点击重新检测；如遇限流，请等待。登录状态由浏览器管理，无需复制 Cookie。</p>
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
    setProviderFormMarkup(provider, `<div class="grid"><label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label></div><div data-local-model-control></div>`);
    updateLocalControl();
    return;
  }
  if (supportsServiceMode(provider)) {
    const api = translationApiOptions(provider);
    const fields = provider.type === "microsoft-web-translate"
      ? [["endpoint", "Endpoint", "url"], ["apiKey", "API Key", "password"], ["region", "Azure 区域（可选）", "text"]]
      : provider.type === "tencent-transmart"
        ? [["endpoint", "Base URL", "url"], ["apiKey", "TokenHub API Key", "password"], ["model", "翻译模型", "text"]]
        : provider.type === "yandex-web-translate"
          ? [["apiKey", "Yandex Cloud API Key", "password"], ["folderId", "Folder ID（按账号要求填写）", "text"]]
          : provider.type === "volcengine-web-translate"
            ? [["accessKeyId", "Access Key ID", "password"], ["secretAccessKey", "Secret Access Key", "password"], ["region", "区域", "text"]]
            : [["apiKey", provider.type === "mymemory" ? "RapidAPI Key" : "Google Cloud API Key", "password"]];
    const apiLabel = { "microsoft-web-translate": "Microsoft Translator API（Azure）", "google-web-translate": "Google Cloud Translation API",
      "tencent-transmart": "腾讯 TokenHub 翻译 API", "yandex-web-translate": "Yandex Cloud Translate API",
      "volcengine-web-translate": "火山引擎机器翻译 API", "mymemory": "MyMemory（RapidAPI）" }[provider.type];
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>使用方式 <select data-field="serviceMode" aria-controls="translationApiFields">
          <option value="free" ${provider.serviceMode !== "api" ? "selected" : ""}>免费服务（默认）</option>
          <option value="api" ${provider.serviceMode === "api" ? "selected" : ""}>API 服务（自备凭据）</option>
        </select></label>
      </div>
      <div id="translationApiFields" ${provider.serviceMode !== "api" ? "hidden" : ""}>
        <p class="hint">${apiLabel}，额度和费用按服务商账号计算。切回免费服务会保留凭据。</p>
        <div class="grid">${fields.map(([name, label, type]) => `<label>${label}<input data-api-field="${name}" type="${type}" value="${escapeAttr(api[name as keyof TranslationApiOptions] ?? "")}" autocomplete="off" /></label>`).join("")}</div>
      </div>
    `);
    providerForm.querySelector<HTMLSelectElement>("[data-field='serviceMode']")!.addEventListener("change", event => {
      const useApi = (event.target as HTMLSelectElement).value === "api";
      providerForm.querySelector<HTMLElement>("#translationApiFields")!.hidden = !useApi;
    });
    return;
  }

  if (provider.type === "microsoft-translator") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Endpoint <input data-field="endpoint" type="url" value="${escapeAttr(provider.endpoint)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>区域 <input data-field="region" type="text" value="${escapeAttr(provider.region)}" placeholder="global 或 Azure 区域" /></label>
      </div>
    `);
    return;
  }

  if (provider.type === "google-cloud-translation") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
      </div>
    `);
    return;
  }

  if (provider.type === "openai-compatible" || provider.type === "anthropic-compatible") {
    const isAnthropic = provider.type === "anthropic-compatible";
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key（可选） <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      ${isAnthropic ? "" : `
        <label>Ollama 兼容
          <select data-field="ollamaCompatibility">
            <option value="enabled" ${provider.type === "openai-compatible" && provider.ollamaCompatibility !== false ? "selected" : ""}>开启（默认）</option>
            <option value="disabled" ${provider.type === "openai-compatible" && provider.ollamaCompatibility === false ? "selected" : ""}>关闭</option>
          </select>
        </label>
        <p class="hint">默认开启，支持 IPv4、IPv6、自定义端口和完整 Chat Completions 地址。</p>
      `}
      <p class="hint">接口格式：${isAnthropic ? "Anthropic Messages" : "OpenAI Chat Completions"}。</p>
    `);
    return;
  }

  if (provider.type === "deepseek") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">使用 DeepSeek Chat Completions，默认关闭思考模式以降低翻译延迟，可在「高级」中覆盖。API 地址默认使用 https://api.deepseek.com。</p>
    `);
    return;
  }

  if (provider.type === "zhipu-glm") {
    setProviderFormMarkup(provider, `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        ${renderModelControl(provider)}
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">使用智谱 GLM Chat Completions。API 地址默认使用 https://open.bigmodel.cn/api/paas/v4。</p>
    `);
    return;
  }

  setProviderFormMarkup(provider, `
    <div class="grid">
      <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
      <label>请求方法
        <select data-field="method">
          <option value="POST" ${provider.method === "POST" ? "selected" : ""}>POST</option>
          <option value="GET" ${provider.method === "GET" ? "selected" : ""}>GET</option>
        </select>
      </label>
      <label>URL <input data-field="url" type="url" value="${escapeAttr(provider.url)}" /></label>
      <label>响应路径 <input data-field="responsePath" type="text" value="${escapeAttr(provider.responsePath)}" /></label>
    </div>
    <label>请求头 JSON <textarea data-field="headers">${escapeHtml(JSON.stringify(provider.headers, null, 2))}</textarea></label>
    <label>请求体模板 <textarea data-field="bodyTemplate">${escapeHtml(provider.bodyTemplate)}</textarea></label>
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
  const container = providerForm.querySelector<HTMLElement>("#providerUsage");
  if (!container) return;
  const provider = { ...readProviderFromForm(getEditingProvider()), ...readProviderPerformance() } as ProviderConfig;
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
  if (provider.type === "deepseek") return DEEPSEEK_MODEL_OPTIONS;
  if (provider.type === "zhipu-glm") return ZHIPU_MODEL_OPTIONS;
  return provider.type === "openai-compatible" ? LLM_MODEL_OPTIONS : [];
}

function renderTestButton(): string {
  return '<button id="test" type="button" class="secondary">测试服务</button>';
}

function renderModelControl(provider: ModelProvider): string {
  const models = [...new Set([...modelPresets(provider), ...(provider.customModels ?? [])])];
  return `<div class="model-field">
    <label for="providerModel">模型</label>
    <div class="model-toolbar">
      <select id="providerModel" data-field="model">${renderOptions(models, provider.model)}</select>
      <button type="button" class="icon-button add-model" data-action="manage-model" title="添加或修改模型" aria-label="添加或修改模型">${uiIconMarkup("plus")}</button>
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
      query<HTMLElement>("#modelStatus").textContent = "请填写模型名称。";
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
    setStatus(`已保存模型：${model}`);
  } catch (error) {
    query<HTMLElement>("#modelStatus").textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderProviderPerformance(provider: ProviderConfig): string {
  const inherited = provider.performanceMode !== "custom";
  return `
    <fieldset class="provider-performance">
      <legend>当前服务：${escapeHtml(provider.label)}</legend>
      <label class="setting-toggle performance-inherit">
        <span>继承通用性能设置</span>
        <input data-field="inheritPerformance" type="checkbox" role="switch" ${inherited ? "checked" : ""} />
        <span class="setting-toggle-control" aria-hidden="true"></span>
      </label>
      <div class="grid performance-overrides" data-role="performanceOverrides" ${inherited ? "hidden" : ""}>
        <label>分块大小
          <input data-field="chunkSize" type="number" min="200" max="4000" value="${provider.chunkSize ?? settings.chunkSize}" />
        </label>
        <label>服务商并发数
          <input data-field="concurrency" type="number" min="1" max="${settings.concurrency}" value="${provider.concurrency ?? settings.concurrency}" />
        </label>
      </div>
      <p class="hint">服务商并发数不会超过通用设置中的全局最大并发数。</p>
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
  setStatus(provider.enabled === false ? "已选中停用服务，可编辑配置。" : "已切换当前服务。");
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
      setStatus("至少需要启用一个翻译服务。");
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
  setStatus(nextEnabled ? "已启用服务。" : "已停用服务。");
}

async function deleteProvider(providerId: string): Promise<void> {
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) return;
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (!provider || !window.confirm(`删除“${provider.label}”？`)) return;
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
  setStatus("已删除自定义服务。");
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
    setStatus("已添加自定义服务，请完成配置后保存。");
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
      label: name || "自定义 HTTP",
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
      label: name || "自定义 Anthropic LLM",
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
    label: name || "自定义 OpenAI LLM",
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

async function save(showSavedStatus = true): Promise<void> {
  try {
    settings = readSettingsFromForm();
    await persistSettings(false);
    render();
    if (showSavedStatus) setStatus("已保存。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Commits the panel state only after the runtime accepted the settings. */
async function persistSettings(showSavedStatus: boolean, next: ExtensionSettings = settings): Promise<void> {
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings: next });
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  if (showSavedStatus) setStatus("已保存。");
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
    report("测试中...");
    await persistSettings(false);
    if (!isCurrent()) return;
    const result = await sendRuntimeMessage<{ translation: string }>({
      type: "TEST_PROVIDER",
      providerId: run.providerId
    });
    report(`测试通过：${result.translation}`);
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  }
}

async function restoreDefaults(): Promise<void> {
  try {
    settings = cloneSettings(DEFAULT_SETTINGS);
    editingProviderId = undefined;
    await persistSettings(false);
    render();
    setStatus("已恢复默认设置。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

let exportInFlight = false;

/**
 * Reads the saved settings again instead of exporting the panel copy: provider actions and the
 * model dialog move that copy to the form draft, and another entry point may have saved since load.
 */
async function exportSettingsBackup(): Promise<void> {
  if (exportInFlight) return;
  exportInFlight = true;
  try {
    if (typeof URL.createObjectURL !== "function") throw new Error("当前浏览器不支持下载文件。");
    const stored = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
    const exportedAt = new Date();
    const backup = createSettingsBackup(stored, exportedAt);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = settingsBackupFileName(exportedAt);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    backupStatus.textContent = `已导出当前设置（${backup.settings.providers.length} 个翻译服务）。`;
  } catch (error) {
    backupStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    exportInFlight = false;
  }
}

/**
 * Reads the model state before saving: SAVE_SETTINGS rejects image translation without the model,
 * and an import cannot carry the model, so the toggle has to be checked against this browser.
 */
async function ocrModelInstalled(): Promise<boolean> {
  try {
    return (await sendRuntimeMessage<OcrStatus>({ type: "GET_OCR_STATUS" })).state === "installed";
  } catch {
    // An unreadable model state is treated as missing: the toggle can be turned back on later,
    // while a rejected save would drop the providers and keys along with it.
    return false;
  }
}

/**
 * The panel state is replaced only after the runtime stored the file, so a rejected save leaves the
 * old settings, the provider selection and the form untouched.
 */
async function importSettingsBackup(): Promise<void> {
  const file = importSettingsFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > SETTINGS_BACKUP_MAX_BYTES) throw new Error("导入失败：文件过大，这不是设置备份文件。");
    const incoming = parseSettingsBackup(await file.text());
    // The model lives in this browser's cache, not in the file, so a backup taken where it was
    // installed cannot restore the toggle. SAVE_SETTINGS rejects the whole write in that case and
    // the providers and keys would be lost with it, so keep the rest and leave the toggle off.
    const missingModel = incoming.imageTranslationEnabled && !await ocrModelInstalled();
    const restored = missingModel ? { ...incoming, imageTranslationEnabled: false } : incoming;
    await persistSettings(false, restored);
    editingProviderId = undefined;
    invalidateProviderTest();
    render();
    const summary = `已导入设置（${settings.providers.length} 个翻译服务），当前服务：${getEditingProvider().label}。`;
    backupStatus.textContent = missingModel
      ? `${summary}本机未安装 OCR 模型，图片翻译保持关闭，装好模型后可在设置里开启。`
      : summary;
    setStatus("已导入设置。");
  } catch (error) {
    backupStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    importSettingsFile.value = "";
  }
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
  return {
    ...settings,
    appearance,
    shortcuts: shortcutControls.read(),
    localShortcuts: shortcutControls.readLocal(),
    shortcutEnabled: shortcutControls.readEnabled(),
    autoTranslation: autoTranslationControls.read(),
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
  if (provider.type === "google-cloud-translation") {
    return {
      ...provider,
      label: field("label").trim() || provider.label,
      apiKey: field("apiKey")
    };
  }
  if (provider.type === "openai-compatible" || provider.type === "anthropic-compatible") {
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
    throw new Error("请求头必须是 JSON 对象。");
  }
  if (!Object.values(parsed).every((entry) => typeof entry === "string")) {
    throw new Error("请求头的值必须是字符串。");
  }
  return parsed as Record<string, string>;
}

function getEditingProvider(): ProviderConfig {
  const provider = settings.providers.find((entry) => entry.id === editingProviderId)
    ?? settings.providers.find((entry) => entry.id === settings.activeProviderId);
  if (!provider) throw new Error("找不到当前翻译服务。");
  editingProviderId = provider.id;
  return provider;
}

function setProviderMenuOpen(open: boolean): void {
  providerMenu.hidden = !open;
  providerTrigger.setAttribute("aria-expanded", String(open));
}

function setStatus(value: string): void {
  status.textContent = value;
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
