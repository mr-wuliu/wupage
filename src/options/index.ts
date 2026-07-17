import { sendRuntimeMessage } from "../shared/messaging";
import { TARGET_LANGUAGES } from "../shared/languages";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";
import "./styles.css";

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLInputElement>("#sourceLang");
const chunkSize = query<HTMLInputElement>("#chunkSize");
const concurrency = query<HTMLInputElement>("#concurrency");
const cacheEnabled = query<HTMLInputElement>("#cacheEnabled");
const floatingBallEnabled = query<HTMLInputElement>("#floatingBallEnabled");
const providerSelect = query<HTMLSelectElement>("#provider");
const providerForm = query<HTMLDivElement>("#providerForm");
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

let settings: ExtensionSettings;

void init();

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  render();
  providerSelect.addEventListener("change", () => {
    settings.activeProviderId = providerSelect.value;
    renderProviderForm();
  });
  saveButton.addEventListener("click", () => {
    void save();
  });
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
  providerSelect.innerHTML = settings.providers
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  providerSelect.value = settings.activeProviderId;
  renderProviderForm();
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

  if (provider.type === "openai-compatible") {
    providerForm.innerHTML = `
      <div class="grid">
        <label>显示名称 <input data-field="label" type="text" value="${escapeAttr(provider.label)}" /></label>
        <label>Base URL <input data-field="baseURL" type="url" value="${escapeAttr(provider.baseURL)}" /></label>
        <label>API key <input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey)}" /></label>
        <label>模型
          <input data-field="model" type="text" list="wupage-model-options" value="${escapeAttr(provider.model)}" />
          <datalist id="wupage-model-options">
            ${LLM_MODEL_OPTIONS.map((model) => `<option value="${escapeAttr(model)}"></option>`).join("")}
          </datalist>
        </label>
      </div>
      <label>系统提示词 <textarea data-field="systemPrompt">${escapeHtml(provider.systemPrompt)}</textarea></label>
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
          <select data-field="model">
            ${renderOptions(ZHIPU_MODEL_OPTIONS, provider.model)}
          </select>
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

async function save(showSavedStatus = true): Promise<void> {
  try {
    const nextSettings = readSettingsFromForm();
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings: nextSettings });
    settings = nextSettings;
    render();
    if (showSavedStatus) setStatus("已保存。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function testProvider(): Promise<void> {
  try {
    setStatus("测试中...");
    await save(false);
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
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
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
    activeProviderId: providerSelect.value,
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
  const form = providerForm;
  const field = (name: string) => form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${name}"]`)?.value ?? "";

  if (provider.type === "google-web-translate") {
    return {
      ...provider,
      label: field("label").trim() || provider.label
    };
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

  if (provider.type === "openai-compatible") {
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
  const provider = settings.providers.find((entry) => entry.id === providerSelect.value);
  if (!provider) throw new Error("找不到当前翻译服务。");
  return provider;
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
