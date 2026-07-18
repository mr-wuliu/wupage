import { BUILT_IN_PROVIDER_IDS, DEFAULT_SETTINGS } from "../shared/defaults";
import { TARGET_LANGUAGES } from "../shared/languages";
import { sendRuntimeMessage } from "../shared/messaging";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";
import "./styles.css";

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLInputElement>("#sourceLang");
const chunkSize = query<HTMLInputElement>("#chunkSize");
const concurrency = query<HTMLInputElement>("#concurrency");
const cacheEnabled = query<HTMLInputElement>("#cacheEnabled");
const floatingBallEnabled = query<HTMLInputElement>("#floatingBallEnabled");
const providerPicker = query<HTMLDivElement>("#providerPicker");
const providerTrigger = query<HTMLButtonElement>("#providerTrigger");
const providerTriggerLabel = query<HTMLSpanElement>("#providerTriggerLabel");
const providerMenu = query<HTMLDivElement>("#providerMenu");
const addProviderButton = query<HTMLButtonElement>("#addProvider");
const providerForm = query<HTMLDivElement>("#providerForm");
const providerDialog = query<HTMLDialogElement>("#providerDialog");
const providerDialogForm = query<HTMLFormElement>("#providerDialogForm");
const cancelProviderButton = query<HTMLButtonElement>("#cancelProvider");
const customProviderName = query<HTMLInputElement>("#customProviderName");
const customProviderKind = query<HTMLSelectElement>("#customProviderKind");
const customLlmFormatField = query<HTMLLabelElement>("#customLlmFormatField");
const customLlmFormat = query<HTMLSelectElement>("#customLlmFormat");
const saveButton = query<HTMLButtonElement>("#save");
const testButton = query<HTMLButtonElement>("#test");
const restoreButton = query<HTMLButtonElement>("#restore");
const status = query<HTMLParagraphElement>("#status");

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
const DEFAULT_LLM_PROMPT =
  "You are a translation engine. Translate each input item into {{targetLang}}. Preserve meaning, numbers, links, code-like tokens, placeholders like ⟪WUPAGE0⟫, and formatting. Return only a JSON array of strings in the same order.";

let settings: ExtensionSettings;

void init();

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  render();

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
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !providerPicker.contains(event.target)) {
      setProviderMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setProviderMenuOpen(false);
  });
  saveButton.addEventListener("click", () => void save());
  testButton.addEventListener("click", testProvider);
  restoreButton.addEventListener("click", restoreDefaults);
}

function render(): void {
  const languages = TARGET_LANGUAGES.some((entry) => entry.code === settings.targetLang)
    ? TARGET_LANGUAGES
    : [{ code: settings.targetLang, label: settings.targetLang }, ...TARGET_LANGUAGES];
  targetLang.innerHTML = languages
    .map((entry) => `<option value="${escapeHtml(entry.code)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  targetLang.value = settings.targetLang;
  sourceLang.value = settings.sourceLang;
  chunkSize.value = String(settings.chunkSize);
  concurrency.value = String(settings.concurrency);
  cacheEnabled.checked = settings.cacheEnabled;
  floatingBallEnabled.checked = settings.floatingBallEnabled;
  renderProviderPicker(false);
  renderProviderForm();
}

function renderProviderPicker(keepOpen: boolean): void {
  const activeProvider = getActiveProvider();
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
        <span class="provider-option-label">${escapeHtml(provider.label)}</span>
        <span class="provider-option-type">${escapeHtml(getProviderTypeLabel(provider))}</span>
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
  const provider = getActiveProvider();
  if (provider.type === "google-web-translate") {
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
      </div>
      <p class="hint">该服务使用非官方网页翻译接口，不需要 API key，但可能被限流或被厂商调整。</p>
    `;
    return;
  }

  if (provider.type === "microsoft-translator") {
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Endpoint <input data-field="endpoint" type="url" value="${escapeAttr(provider.endpoint)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>区域 <input data-field="region" type="text" value="${escapeAttr(provider.region)}" placeholder="global 或 Azure 区域" /></label>
      </div>
    `;
    return;
  }

  if (provider.type === "google-cloud-translation") {
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
      </div>
    `;
    return;
  }

  if (provider.type === "openai-compatible" || provider.type === "anthropic-compatible") {
    const isAnthropic = provider.type === "anthropic-compatible";
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key（可选） <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>模型
          <input data-field="model" type="text" ${isAnthropic ? "" : "list=\"wupage-model-options\""} value="${escapeAttr(provider.model)}" />
          ${isAnthropic ? "" : `
            <datalist id="wupage-model-options">
              ${LLM_MODEL_OPTIONS.map((model) => `<option value="${escapeAttr(model)}"></option>`).join("")}
            </datalist>
          `}
        </label>
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">接口格式：${isAnthropic ? "Anthropic Messages" : "OpenAI Chat Completions"}。</p>
    `;
    return;
  }

  if (provider.type === "zhipu-glm") {
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>模型
          <select data-field="model">${renderOptions(ZHIPU_MODEL_OPTIONS, provider.model)}</select>
        </label>
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
      <p class="hint">使用智谱 GLM Chat Completions。API 地址默认使用 https://open.bigmodel.cn/api/paas/v4。</p>
    `;
    return;
  }

  providerForm.innerHTML = `
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
  `;
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
    baseURL: "https://api.openai.com/v1",
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

async function testProvider(): Promise<void> {
  try {
    setStatus("测试中...");
    settings = readSettingsFromForm();
    await persistSettings(false);
    const result = await sendRuntimeMessage<{ translation: string }>({
      type: "TEST_PROVIDER",
      providerId: settings.activeProviderId
    });
    setStatus(`测试通过：${result.translation}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
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
  const activeProvider = readProviderFromForm(getActiveProvider());
  return {
    ...settings,
    targetLang: targetLang.value.trim() || "zh-CN",
    sourceLang: sourceLang.value.trim() || "auto",
    activeProviderId: settings.activeProviderId,
    chunkSize: Number(chunkSize.value),
    concurrency: Number(concurrency.value),
    cacheEnabled: cacheEnabled.checked,
    floatingBallEnabled: floatingBallEnabled.checked,
    providers: settings.providers.map((provider) =>
      provider.id === activeProvider.id ? activeProvider : provider
    )
  };
}

function readProviderFromForm(provider: ProviderConfig): ProviderConfig {
  const field = (name: string) =>
    providerForm.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-field="${name}"]`
    )?.value ?? "";

  if (provider.type === "google-web-translate") {
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

function getProviderTypeLabel(provider: ProviderConfig): string {
  if (provider.type === "openai-compatible") return "OpenAI";
  if (provider.type === "anthropic-compatible") return "Anthropic";
  if (provider.type === "zhipu-glm") return "GLM";
  if (provider.type === "http-template") return "HTTP";
  if (provider.type === "google-web-translate") return "Web";
  return "API";
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
