import { t, htmlMessage } from "../shared/i18n";
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
  tabs.setAttribute("aria-label", t("translationServiceConfiguration"));
  tabs.innerHTML = `
    <button id="providerGeneralTab" type="button" role="tab" data-provider-tab="general" aria-controls="providerGeneralPanel">${htmlMessage("generalTab")}</button>
    <button id="providerAdvancedTab" type="button" role="tab" data-provider-tab="advanced" aria-controls="providerAdvancedPanel">${htmlMessage("advanced")}</button>`;
  container.append(tabs, general, advanced);

  if (supportsRequestTemplate(provider)) {
    const template = normalizeRequestTemplate(provider.requestTemplate);
    advanced.innerHTML = `
      <label class="request-template-toggle"><input data-field="requestTemplateEnabled" type="checkbox" aria-controls="requestTemplateFields" />${htmlMessage("enableCustomRequestTemplate")}</label>
      <p class="hint">${htmlMessage("appliesToThisServiceOnlyEmptyFieldsShow")}</p>
      <div class="request-template-actions"><button type="button" class="secondary" data-action="load-default-request-template">${htmlMessage("loadDefaultTemplate")}</button></div>
      <fieldset id="requestTemplateFields" class="request-template-fields">
        <legend class="visually-hidden">${htmlMessage("customRequestTemplate")}</legend>
        <label>${htmlMessage("requestHeadersTemplateJson")}<textarea data-field="requestHeadersTemplate" spellcheck="false" aria-describedby="requestHeadersHelp"></textarea></label>
        <p id="requestHeadersHelp" class="hint">${htmlMessage("addOrOverrideDefaultHeadersNamesAreCase")}</p>
        <label>${htmlMessage("requestBodyTemplateJson")}<textarea data-field="requestBodyTemplate" rows="18" spellcheck="false" aria-describedby="requestBodyHelp"></textarea></label>
        <p id="requestBodyHelp" class="hint">${htmlMessage("objectsMergeRecursivelyWithTheDefaultBodyArrays")}</p>
      </fieldset>
      <p data-role="request-template-status" class="request-template-status" role="alert" hidden></p>
      <details class="request-template-help">
        <summary>${htmlMessage("templateVariablesAndExamples")}</summary>
        <p>${htmlMessage("useModelApikeySourcelangTargetlangContextSystempromptAnd")}</p>
        <p>${htmlMessage("anEntireTextsValueBecomesAnArrayOf")}</p>
        <p>${htmlMessage("customRequestHeaders")}</p><pre>{
  "x-opencode-session": "wupage"
}</pre>
        <p>${htmlMessage("examplesOfDisablingThinkingChooseTheFormatYour")}</p>
        <pre>{ "enable_thinking": false }</pre>
        <pre>{ "thinking": { "type": "disabled" } }</pre>
        <p>${htmlMessage("replacingTheMessagesTemplateOpenaiCompatibleFormat")}</p><pre>{
  "messages": [
    { "role": "system", "content": "{{systemPrompt}}" },
    { "role": "user", "content": "{{userPrompt}}" }
  ]
}</pre>
        <p>${htmlMessage("whenEditingMessagesKeepTheInstructionToReturn")}</p>
      </details>
      <div class="request-template-actions">
        <button type="button" class="secondary" data-action="test-provider">${htmlMessage("testService")}</button>
        <button type="button" class="secondary" data-action="reset-request-template" data-settings-feedback>${htmlMessage("restoreDefaultRequest")}</button>
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
    advanced.innerHTML = `<p class="hint">${htmlMessage("customizeTheFullHttpRequestHeadersAndBody")}</p>`;
    for (const field of ["headers", "bodyTemplate"]) {
      const label = general.querySelector(`[data-field='${field}']`)!.closest("label")!;
      advanced.append(label);
    }
  } else {
    advanced.innerHTML = `<p class="hint">${htmlMessage("thisServiceUsesABuiltInProtocolAdd")}</p>`;
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
