import { defaultLlmRequestTemplate, normalizeRequestTemplate, supportsRequestTemplate } from "../shared/request-template";
import type { LlmRequestTemplate, ProviderConfig } from "../shared/types";

let selectedTab = "general";

export function setupProviderTabs(container: HTMLElement, provider: ProviderConfig): void {
  const general = document.createElement("div");
  general.append(...container.childNodes);
  general.id = "providerGeneralPanel";
  general.className = "provider-tab-panel";
  general.setAttribute("role", "tabpanel");
  general.setAttribute("aria-labelledby", "providerGeneralTab");
  const advanced = document.createElement("div");
  advanced.id = "providerAdvancedPanel";
  advanced.className = "provider-tab-panel";
  advanced.setAttribute("role", "tabpanel");
  advanced.setAttribute("aria-labelledby", "providerAdvancedTab");
  const tabs = document.createElement("div");
  tabs.className = "provider-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "翻译服务配置");
  tabs.innerHTML = `
    <button id="providerGeneralTab" type="button" role="tab" data-provider-tab="general" aria-controls="providerGeneralPanel">常规</button>
    <button id="providerAdvancedTab" type="button" role="tab" data-provider-tab="advanced" aria-controls="providerAdvancedPanel">高级</button>`;
  container.append(tabs, general, advanced);

  if (supportsRequestTemplate(provider)) {
    const template = normalizeRequestTemplate(provider.requestTemplate);
    advanced.innerHTML = `
      <label class="request-template-toggle"><input data-field="requestTemplateEnabled" type="checkbox" aria-controls="requestTemplateFields" />启用自定义请求模板</label>
      <p class="hint">仅影响当前服务。空配置会展示此服务的默认文本请求模板，变量使用「常规」中的配置。关闭后使用默认请求，并保留已修改的模板。</p>
      <div class="request-template-actions"><button type="button" class="secondary" data-action="load-default-request-template">载入默认模板</button></div>
      <fieldset id="requestTemplateFields" class="request-template-fields">
        <legend class="visually-hidden">自定义请求模板</legend>
        <label>请求头模板（JSON）<textarea data-field="requestHeadersTemplate" spellcheck="false" aria-describedby="requestHeadersHelp"></textarea></label>
        <p id="requestHeadersHelp" class="hint">在默认请求头上添加或覆盖，名称不区分大小写；值为字符串，null 删除该请求头。默认认证头随「常规」中的 API Key 配置生成。</p>
        <label>请求体参数模板（JSON）<textarea data-field="requestBodyTemplate" rows="18" spellcheck="false" aria-describedby="requestBodyHelp"></textarea></label>
        <p id="requestBodyHelp" class="hint">在默认请求体上合并：对象逐层合并，数组和其他值整体替换，null 删除字段。留空或 {} 使用默认值。仅支持非流式响应。</p>
      </fieldset>
      <p data-role="request-template-status" class="request-template-status" role="alert" hidden></p>
      <details class="request-template-help">
        <summary>模板变量与示例</summary>
        <p>变量写在 JSON 字符串内，可使用 {{model}}、{{apiKey}}、{{sourceLang}}、{{targetLang}}、{{context}}、{{systemPrompt}} 和 {{userPrompt}}。引号与换行会自动转义。</p>
        <p>完整的 "{{texts}}" 会替换为文本数组；"{{json texts}}" 为 JSON 编码后的文本字符串。{{userPrompt}} 包含默认的语言、上下文与输入文本。变量仅替换值，不替换字段名。</p>
        <p>自定义请求头：</p><pre>{
  "x-opencode-session": "wupage"
}</pre>
        <p>关闭思考的常见写法（按服务商接口要求选择）：</p>
        <pre>{ "enable_thinking": false }</pre>
        <pre>{ "thinking": { "type": "disabled" } }</pre>
        <p>替换消息模板（OpenAI 兼容格式）：</p><pre>{
  "messages": [
    { "role": "system", "content": "{{systemPrompt}}" },
    { "role": "user", "content": "{{userPrompt}}" }
  ]
}</pre>
        <p>修改消息时，保留返回与输入顺序、数量一致的 JSON 字符串数组要求。</p>
      </details>
      <div class="request-template-actions">
        <button type="button" class="secondary" data-action="test-provider">测试服务</button>
        <button type="button" class="secondary" data-action="reset-request-template" data-settings-feedback>恢复默认请求</button>
      </div>`;
    const enabled = advanced.querySelector<HTMLInputElement>("[data-field='requestTemplateEnabled']")!;
    const fields = advanced.querySelector<HTMLFieldSetElement>("fieldset")!;
    const headers = advanced.querySelector<HTMLTextAreaElement>("[data-field='requestHeadersTemplate']")!;
    const body = advanced.querySelector<HTMLTextAreaElement>("[data-field='requestBodyTemplate']")!;
    const currentDefaults = () => defaultLlmRequestTemplate({ ...provider,
      apiKey: general.querySelector<HTMLInputElement>("[data-field='apiKey']")?.value ?? provider.apiKey });
    const setDefault = (input: HTMLTextAreaElement, value: string, reference: boolean): void => {
      input.value = value;
      if (reference) input.dataset.defaultTemplate = value;
      else delete input.dataset.defaultTemplate;
    };
    const defaults = currentDefaults();
    for (const [input, value, fallback] of [
      [headers, template?.headers, defaults.headers], [body, template?.body, defaults.body]
    ] as const) {
      if (!value?.trim() || value.trim() === "{}") setDefault(input, fallback, true);
      else input.value = value;
    }
    enabled.checked = template?.enabled === true;
    const update = (): void => { fields.disabled = !enabled.checked; };
    enabled.addEventListener("change", update);
    update();
    const loadDefaults = (reference: boolean): void => {
      const defaults = currentDefaults();
      setDefault(headers, defaults.headers, reference);
      setDefault(body, defaults.body, reference);
      enabled.checked = !reference;
      update();
      advanced.dispatchEvent(new Event("input", { bubbles: true }));
    };
    advanced.querySelector("[data-action='load-default-request-template']")!.addEventListener("click", () => loadDefaults(false));
    advanced.querySelector("[data-action='reset-request-template']")!.addEventListener("click", () => {
      loadDefaults(true);
    });
    const refreshDefaults = (event: Event): void => {
      if (!(event.target instanceof HTMLInputElement) || event.target.dataset.field !== "apiKey") return;
      if (headers.value === headers.dataset.defaultTemplate) setDefault(headers, currentDefaults().headers, true);
    };
    general.addEventListener("input", refreshDefaults);
    general.addEventListener("change", refreshDefaults);
    advanced.addEventListener("input", () => {
      advanced.querySelector<HTMLElement>("[data-role='request-template-status']")!.hidden = true;
      for (const input of advanced.querySelectorAll("textarea")) input.removeAttribute("aria-invalid");
    });
  } else if (provider.type === "http-template") {
    advanced.innerHTML = '<p class="hint">自定义完整的 HTTP 请求。请求头与请求体支持 {{sourceLang}}、{{targetLang}}、{{context}}、{{texts}} 和 {{json texts}}；请求体中的文本数组请使用不加引号的 {{json texts}}。</p>';
    for (const field of ["headers", "bodyTemplate"]) {
      const label = general.querySelector(`[data-field='${field}']`)!.closest("label")!;
      advanced.append(label);
    }
  } else {
    advanced.innerHTML = '<p class="hint">当前服务使用内置翻译协议，无可修改的请求模板。如需自定义接口，可添加 LLM 服务或使用 HTTP Template。</p>';
  }

  const buttons = [...tabs.querySelectorAll<HTMLButtonElement>("[role='tab']")];
  const select = (value: string): void => {
    selectedTab = value;
    general.hidden = value !== "general";
    advanced.hidden = value !== "advanced";
    for (const button of buttons) {
      const active = button.dataset.providerTab === value;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
  };
  for (const button of buttons) button.addEventListener("click", () => select(button.dataset.providerTab!));
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].click();
    buttons[next].focus();
  });
  select(selectedTab);
}

export function readRequestTemplate(container: HTMLElement): LlmRequestTemplate | undefined {
  const enabled = container.querySelector<HTMLInputElement>("[data-field='requestTemplateEnabled']");
  if (!enabled) return undefined;
  const read = (name: string): string => {
    const input = container.querySelector<HTMLTextAreaElement>(`[data-field='${name}']`)!;
    // Display defaults as a reference without persisting a stale copy as overrides.
    return input.value === input.dataset.defaultTemplate ? "{}" : input.value;
  };
  const headers = read("requestHeadersTemplate");
  const body = read("requestBodyTemplate");
  if (!enabled.checked && [headers, body].every(value => !value.trim() || value.trim() === "{}")) return undefined;
  return { enabled: enabled.checked, headers, body };
}
