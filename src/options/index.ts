import { BUILT_IN_PROVIDER_IDS, DEFAULT_SETTINGS } from "../shared/defaults";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import { sendRuntimeMessage } from "../shared/messaging";
import type { ExtensionSettings, ProviderConfig, TranslationApiOptions } from "../shared/types";
import { supportsServiceMode, translationApiOptions } from "../shared/translation-service";
import "./styles.css";
import { setImageTranslationToggle, setupOcrControl } from "../shared/ocr-control";
import { setupLocalModelControl } from "../local/control";
import { ensureProviderIconStyles, providerIconMarkup } from "../shared/provider-icons";
import { setupAutoTranslationControls } from "./auto-translation";
import { setupSelectionTranslationControls } from "./selection-translation";
import { renderProviderUsage, updateProviderScheduling } from "./provider-usage";

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
const chunkSize = query<HTMLInputElement>("#chunkSize");
const concurrency = query<HTMLInputElement>("#concurrency");
const pdfTranslationScope = query<HTMLSelectElement>("#pdfTranslationScope");
const pdfTranslationPageRadius = query<HTMLInputElement>("#pdfTranslationPageRadius");
const pdfTranslationPageRadiusField = query<HTMLElement>("#pdfTranslationPageRadiusField");
const pdfTranslationScopeDescription = query<HTMLElement>("#pdfTranslationScopeDescription");
const cacheEnabled = query<HTMLInputElement>("#cacheEnabled");
const floatingBallEnabled = query<HTMLInputElement>("#floatingBallEnabled");
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
const status = query<HTMLParagraphElement>("#status");
const autoTranslationControls = setupAutoTranslationControls(query<HTMLElement>("#autoTranslationSettings"));
const selectionTranslationControls = setupSelectionTranslationControls(query<HTMLElement>("#selectionTranslationSettings"));

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
let disposeLocalControl: (() => void) | undefined;
let activeProviderTest: { providerId: string; status: HTMLElement; message: string } | undefined;

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
  if (imageNotice) imageTranslationEnabled.closest(".image-feature")?.scrollIntoView?.({ block: "center" });

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
    const provider = getActiveProvider();
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
  autoTranslationControls.render(settings.autoTranslation);
  selectionTranslationControls.render(settings.selectionTranslation);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  chunkSize.value = String(settings.chunkSize);
  concurrency.value = String(settings.concurrency);
  pdfTranslationScope.value = settings.pdfTranslationPageRadius === null ? "unlimited" : "nearby";
  pdfTranslationPageRadius.value = String(settings.pdfTranslationPageRadius ?? DEFAULT_SETTINGS.pdfTranslationPageRadius);
  updatePdfTranslationScope();
  cacheEnabled.checked = settings.cacheEnabled;
  floatingBallEnabled.checked = settings.floatingBallEnabled;
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

function updatePdfTranslationScope(): void {
  pdfTranslationPageRadiusField.hidden = pdfTranslationScope.value === "unlimited";
  pdfTranslationPageRadius.disabled = pdfTranslationPageRadiusField.hidden;
  pdfTranslationScopeDescription.textContent = pdfTranslationPageRadiusField.hidden
    ? "翻译整份 PDF，直到全部完成。已完成的同语言、同服务译文会保留。"
    : "开始翻译后，默认处理当前页及前后各 5 页，最多 11 页。滚动后自动补译新范围，范围内完成后等待继续阅读。0 表示仅翻译当前页。";
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
  const activeProvider = getActiveProvider();
  query<HTMLElement>("#providerTriggerIcon").innerHTML = providerIconMarkup(activeProvider);
  providerTriggerLabel.textContent = activeProvider.label;
  providerMenu.innerHTML = settings.providers.map(renderProviderMenuRow).join("");
  setProviderMenuOpen(keepOpen);
}

function renderProviderMenuRow(provider: ProviderConfig): string {
  const enabled = provider.enabled !== false;
  const builtIn = BUILT_IN_PROVIDER_IDS.has(provider.id);
  return `
    <div class="provider-menu-row" data-built-in="${builtIn}" role="group">
      <button
        class="provider-option"
        type="button"
        role="option"
        data-action="select"
        data-provider-id="${escapeAttr(provider.id)}"
        aria-selected="${provider.id === settings.activeProviderId}"
        ${enabled ? "" : "disabled"}
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
        >-</button>
      `}
    </div>
  `;
}

function renderProviderForm(): void {
  invalidateProviderTest();
  disposeLocalControl?.(); disposeLocalControl = undefined;
  const provider = getActiveProvider();
  providerPerformance.innerHTML = provider.type === "firefox-local"
    ? '<p class="hint">本地翻译使用固定分块大小 800、并发数 1。</p>'
    : renderProviderPerformance(provider);
  providerPerformance.querySelector("[data-field='inheritPerformance']")
    ?.addEventListener("change", updateProviderPerformanceFields);
  updateProviderPerformanceFields();
  if (provider.type === "firefox-local") {
    setProviderFormMarkup(provider, `<div class="grid"><label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label></div><div data-local-model-control></div>`);
    updateLocalControl();
    return;
  }
  if (supportsServiceMode(provider)) {
    const recipient = { "google-web-translate": "Google", "microsoft-web-translate": "微软",
      "tencent-transmart": "腾讯", "yandex-web-translate": "Yandex",
      "volcengine-web-translate": "火山翻译", "mymemory": "MyMemory" }[provider.type];
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
        <label>使用方式 <select data-field="serviceMode" aria-controls="translationApiFields translationFreeHint">
          <option value="free" ${provider.serviceMode !== "api" ? "selected" : ""}>免费服务（默认）</option>
          <option value="api" ${provider.serviceMode === "api" ? "selected" : ""}>API 服务（自备凭据）</option>
        </select></label>
      </div>
      <div id="translationFreeHint" ${provider.serviceMode === "api" ? "hidden" : ""}>
      <p class="hint">免费使用，无需注册或填写 API Key。待翻译文字由扩展直接发送给${recipient}；服务不可用时，可在翻译服务中切换其他选项。</p>
      </div>
      <div id="translationApiFields" ${provider.serviceMode !== "api" ? "hidden" : ""}>
        <p class="hint">${apiLabel}，额度和费用按服务商账号计算。切回免费服务会保留凭据。</p>
        <div class="grid">${fields.map(([name, label, type]) => `<label>${label}<input data-api-field="${name}" type="${type}" value="${escapeAttr(api[name as keyof TranslationApiOptions] ?? "")}" autocomplete="off" /></label>`).join("")}</div>
      </div>
    `);
    providerForm.querySelector<HTMLSelectElement>("[data-field='serviceMode']")!.addEventListener("change", event => {
      const useApi = (event.target as HTMLSelectElement).value === "api";
      providerForm.querySelector<HTMLElement>("#translationApiFields")!.hidden = !useApi;
      providerForm.querySelector<HTMLElement>("#translationFreeHint")!.hidden = useApi;
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
      <p class="hint">使用 DeepSeek Chat Completions，默认关闭思考模式以降低翻译延迟。API 地址默认使用 https://api.deepseek.com。</p>
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

function updateLocalControl(): void {
  const container = providerForm.querySelector<HTMLElement>("[data-local-model-control]");
  if (!container) return;
  disposeLocalControl?.();
  disposeLocalControl = setupLocalModelControl(container, sourceLang.value, targetLang.value);
}

function setProviderFormMarkup(provider: ProviderConfig, markup: string): void {
  providerForm.dataset.providerId = provider.id;
  providerForm.innerHTML = markup;
  const usage = document.createElement("aside"); usage.id = "providerUsage";
  providerForm.append(usage);
  renderProviderUsage(usage, provider);
  updateUsageScheduling();
  if (!providerForm.querySelector("#test")) {
    providerForm.insertAdjacentHTML("beforeend", `<div class="provider-test-action">${renderTestButton()}<p data-role="provider-test-status" class="hint" hidden></p></div>`);
  }
  providerForm.querySelector("#test")?.addEventListener("click", testProvider);
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
  renderProviderUsage(container, readProviderFromForm(getActiveProvider()));
  updateUsageScheduling();
}

function updateUsageScheduling(): void {
  const container = providerForm.querySelector<HTMLElement>("#providerUsage");
  if (!container) return;
  const provider = { ...readProviderFromForm(getActiveProvider()), ...readProviderPerformance() } as ProviderConfig;
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
      <button type="button" class="icon-button add-model" data-action="manage-model" title="添加或修改模型" aria-label="添加或修改模型">+</button>
      ${renderTestButton()}
    </div>
    <p data-role="provider-test-status" class="hint" hidden></p>
  </div>`;
}

async function saveModel(): Promise<void> {
  try {
    const provider = getActiveProvider();
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
  if (!provider || provider.enabled === false) return;
  invalidateProviderTest();
  settings = readSettingsFromForm();
  settings.activeProviderId = providerId;
  await persistSettings(false);
  renderProviderPicker(false);
  renderProviderForm();
  setStatus("已切换当前服务。");
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

async function persistSettings(showSavedStatus: boolean): Promise<void> {
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
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
  invalidateProviderTest();
  const inlineStatus = providerForm.querySelector<HTMLElement>("[data-role='provider-test-status']");
  if (!inlineStatus) return;
  const run = { providerId: settings.activeProviderId, status: inlineStatus, message: "" };
  activeProviderTest = run;
  const isCurrent = (): boolean => activeProviderTest === run
    && settings.activeProviderId === run.providerId && run.status.isConnected;
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
    await persistSettings(false);
    render();
    setStatus("已恢复默认设置。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

function readSettingsFromForm(): ExtensionSettings {
  const activeProvider = {
    ...readProviderFromForm(getActiveProvider()),
    ...(getActiveProvider().type === "firefox-local" ? { performanceMode: "custom", chunkSize: 800, concurrency: 1 } : readProviderPerformance())
  } as ProviderConfig;
  return {
    ...settings,
    autoTranslation: autoTranslationControls.read(),
    selectionTranslation: selectionTranslationControls.read(),
    targetLang: targetLang.value.trim() || "zh-CN",
    sourceLang: sourceLang.value.trim() || "auto",
    activeProviderId: settings.activeProviderId,
    chunkSize: Number(chunkSize.value),
    concurrency: Number(concurrency.value),
    pdfTranslationPageRadius: pdfTranslationScope.value === "unlimited" ? null
      : pdfTranslationPageRadius.value === "" ? DEFAULT_SETTINGS.pdfTranslationPageRadius : Number(pdfTranslationPageRadius.value),
    cacheEnabled: cacheEnabled.checked,
    floatingBallEnabled: floatingBallEnabled.checked,
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

  if (supportsServiceMode(provider)) {
    const api = { ...provider.api };
    providerForm.querySelectorAll<HTMLInputElement>("[data-api-field]").forEach(input => {
      api[input.dataset.apiField as keyof TranslationApiOptions] = input.value.trim();
    });
    return { ...provider, label: field("label").trim() || provider.label,
      serviceMode: field("serviceMode") === "api" ? "api" : "free", api };
  }
  if (provider.type === "firefox-local") {
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

function getActiveProvider(): ProviderConfig {
  const provider = settings.providers.find((entry) => entry.id === settings.activeProviderId);
  if (!provider) throw new Error("找不到当前翻译服务。");
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
