import { t } from "../shared/i18n";
import {
  inputTemplateAcceptsProvider, inputTemplateLabel, inputTemplateProvider, KEEP_INPUT_LANGUAGE,
  MAX_INPUT_TEMPLATE_LABEL, MAX_INPUT_TEMPLATE_PROMPT, MAX_INPUT_TEMPLATES, normalizeInputTranslation,
  type InputTranslationSettings, type InputTranslationTemplate
} from "../shared/input-translation";
import { TARGET_LANGUAGES } from "../shared/languages";
import { randomId } from "../shared/random-id";
import type { ProviderConfig } from "../shared/types";
import { uiIconMarkup, type UiIconName } from "../shared/ui-icons";

export function setupInputTranslationControls(root: HTMLElement) {
  const enabled = root.querySelector<HTMLInputElement>("#inputTranslationEnabled")!;
  const list = root.querySelector<HTMLElement>("#inputTemplates")!;
  const add = root.querySelector<HTMLButtonElement>("#addInputTemplate")!;
  const rows = new Map<Element, ReturnType<typeof addRow>>();
  let providers: readonly ProviderConfig[] = [];

  function addRow(template: InputTranslationTemplate, focus = false) {
    const row = document.createElement("article");
    row.className = "input-template";
    row.dataset.templateId = template.id;
    const heading = document.createElement("div");
    const fields = document.createElement("div");
    heading.className = "input-template-heading";
    fields.className = "input-template-fields";
    const name = document.createElement("input");
    name.type = "text";
    name.value = template.label;
    name.placeholder = inputTemplateLabel({ ...template, label: "" });
    name.maxLength = MAX_INPUT_TEMPLATE_LABEL;
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = template.enabled;
    visible.setAttribute("role", "switch");
    const toggle = label(t("showInputTemplate"), visible);
    toggle.className = "setting-toggle";
    const track = document.createElement("span");
    track.className = "setting-toggle-control";
    track.setAttribute("aria-hidden", "true");
    toggle.append(track);
    const toolbar = document.createElement("div");
    toolbar.className = "input-template-toolbar";
    const actions = document.createElement("div");
    actions.className = "input-template-actions";
    const up = button("arrow-down-03", t("moveInputTemplateUp"));
    up.classList.add("input-template-up");
    const down = button("arrow-down-03", t("moveInputTemplateDown"));
    const remove = button("trash", t("deleteInputTemplate"));
    remove.classList.add("input-template-delete");
    actions.append(up, down, remove);
    toolbar.append(toggle, actions);
    heading.append(label(t("inputTemplateButtonLabel"), name), toolbar);

    const mode = document.createElement("select");
    mode.add(option("machine", t("inputMachineTranslation")));
    mode.add(option("ai", t("inputAiTranslation")));
    mode.value = template.mode;
    const provider = document.createElement("select");
    const target = document.createElement("select");
    const prompt = document.createElement("textarea");
    prompt.rows = 3;
    prompt.maxLength = MAX_INPUT_TEMPLATE_PROMPT;
    prompt.value = template.prompt;
    const promptField = label(t("inputTemplatePrompt"), prompt);
    const serviceHint = document.createElement("p");
    serviceHint.className = "hint";
    serviceHint.textContent = t("inputTemplateChooseService");
    fields.append(label(t("inputTemplateMode"), mode), label(t("translationService"), provider), label(t("targetLanguage"), target));
    row.append(heading, fields, serviceHint, promptField);

    const read = (): InputTranslationTemplate => ({
      id: template.id, label: name.value, enabled: visible.checked, mode: mode.value === "ai" ? "ai" : "machine",
      providerId: provider.value, targetLang: target.value, prompt: prompt.value
    });
    const syncAvailability = () => { serviceHint.hidden = !!inputTemplateProvider(read(), providers); };
    const populate = (providerId: string, targetLang: string) => {
      const current = read();
      const isAi = current.mode === "ai";
      const matches = providers.filter(entry => inputTemplateAcceptsProvider(current, entry));
      provider.replaceChildren(option("", t("inputTemplateSelectService")), ...matches.map(entry =>
        option(entry.id, entry.enabled === false ? t("inputTemplateDisabledService", entry.label) : entry.label)));
      if (providerId && !matches.some(entry => entry.id === providerId)) provider.add(option(providerId, t("inputTemplateMissingService")));
      provider.value = providerId;
      target.replaceChildren(...(isAi ? [option(KEEP_INPUT_LANGUAGE, t("keepInputLanguage"))] : []),
        ...TARGET_LANGUAGES.map(lang => option(lang.code, lang.label)));
      target.value = [...target.options].some(entry => entry.value === targetLang) ? targetLang : "en";
      promptField.hidden = !isAi;
      syncAvailability();
    };
    populate(template.providerId, template.targetLang);
    mode.addEventListener("change", () => populate("", target.value));
    provider.addEventListener("change", syncAvailability);
    up.addEventListener("click", () => move(row, -1, up, name));
    down.addEventListener("click", () => move(row, 1, down, name));
    remove.addEventListener("click", () => {
      const next = row.nextElementSibling ?? row.previousElementSibling;
      rows.delete(row);
      row.remove();
      updateOrderControls();
      (next?.querySelector("input") ?? add).focus();
    });
    const fieldsForRow = { read, up, down };
    rows.set(row, fieldsForRow);
    list.append(row);
    if (focus) name.focus();
    return fieldsForRow;
  }

  function move(row: Element, direction: -1 | 1, control: HTMLButtonElement, name: HTMLInputElement): void {
    const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    list.insertBefore(row, direction < 0 ? sibling : sibling.nextSibling);
    updateOrderControls();
    (control.disabled ? name : control).focus();
  }

  function updateOrderControls(): void {
    for (const [row, fields] of rows) {
      fields.up.disabled = row === list.firstElementChild;
      fields.down.disabled = row === list.lastElementChild;
    }
    add.disabled = rows.size >= MAX_INPUT_TEMPLATES;
  }

  add.addEventListener("click", () => {
    addRow({ id: randomId(), label: "", enabled: true, mode: "machine", providerId: "", targetLang: "en", prompt: "" }, true);
    updateOrderControls();
  });
  return {
    render(value: InputTranslationSettings | undefined, services: readonly ProviderConfig[]) {
      const settings = normalizeInputTranslation(value);
      providers = services;
      enabled.checked = settings.enabled;
      rows.clear();
      list.replaceChildren();
      for (const template of settings.templates) addRow(template);
      updateOrderControls();
    },
    read: () => normalizeInputTranslation({ enabled: enabled.checked, templates: [...list.children].map(row => rows.get(row)?.read()) })
  };
}

function label(caption: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLLabelElement {
  const field = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = caption;
  field.append(text, control);
  return field;
}

function option(value: string, caption: string): HTMLOptionElement {
  return new Option(caption, value);
}

function button(icon: UiIconName, caption: string): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "input-template-action";
  control.title = caption;
  control.setAttribute("aria-label", caption);
  control.innerHTML = uiIconMarkup(icon);
  return control;
}
