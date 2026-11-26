import { t } from "./i18n";
import { TARGET_LANGUAGES } from "./languages";
import { supportsRequestTemplate } from "./request-template";
import type { ProviderConfig } from "./types";

export const KEEP_INPUT_LANGUAGE = "original";
export const MAX_INPUT_TEMPLATES = 100;
export const MAX_INPUT_TEMPLATE_LABEL = 80;
export const MAX_INPUT_TEMPLATE_PROMPT = 8000;

export interface InputTranslationTemplate {
  id: string;
  label: string;
  enabled: boolean;
  mode: "machine" | "ai";
  providerId: string;
  targetLang: string;
  prompt: string;
}

export interface InputTranslationSettings {
  enabled: boolean;
  templates: InputTranslationTemplate[];
}

export const DEFAULT_INPUT_TRANSLATION: InputTranslationSettings = {
  enabled: true,
  templates: [
    { id: "english", label: "", enabled: true, mode: "machine", providerId: "microsoft-web-translate", targetLang: "en", prompt: "" },
    { id: "meow", label: "", enabled: true, mode: "ai", providerId: "", targetLang: KEEP_INPUT_LANGUAGE,
      prompt: "Use a lightly playful, catlike voice. Add an occasional cat sound natural to the language, such as 喵 in Chinese or meow in English. Keep the meaning and details and avoid overdoing the effect." }
  ]
};

export function inputTemplateLabel(template: InputTranslationTemplate): string {
  return template.label || (template.id === "english" ? t("inputTemplateEnglish")
    : template.id === "meow" ? t("inputTemplateMeow") : t("newInputTemplate"));
}

export function inputTemplateAcceptsProvider(template: InputTranslationTemplate, provider: ProviderConfig): boolean {
  return (template.mode === "ai") === supportsRequestTemplate(provider);
}

export function inputTemplateProvider(template: InputTranslationTemplate, providers: readonly ProviderConfig[]): ProviderConfig | undefined {
  return providers.find(provider => provider.id === template.providerId && provider.enabled !== false
    && inputTemplateAcceptsProvider(template, provider)
    && (provider.type !== "http-template" || !!provider.url.trim())
    && (!supportsRequestTemplate(provider) || !!(provider.baseURL.trim() && provider.model.trim())));
}

export function normalizeInputTranslation(value: unknown): InputTranslationSettings {
  const input = record(value);
  const entries = Array.isArray(input?.templates) ? input.templates : DEFAULT_INPUT_TRANSLATION.templates;
  const ids = new Set<string>();
  const templates: InputTranslationTemplate[] = [];
  for (const entry of entries.slice(0, MAX_INPUT_TEMPLATES)) {
    const item = record(entry);
    if (!item || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) continue;
    ids.add(item.id);
    const mode = item.mode === "ai" ? "ai" : "machine";
    const targetLang = typeof item.targetLang === "string" && ((mode === "ai" && item.targetLang === KEEP_INPUT_LANGUAGE)
      || TARGET_LANGUAGES.some(lang => lang.code === item.targetLang)) ? item.targetLang : "en";
    templates.push({
      id: item.id,
      label: typeof item.label === "string" ? item.label.trim().slice(0, MAX_INPUT_TEMPLATE_LABEL) : "",
      enabled: item.enabled !== false,
      mode,
      providerId: typeof item.providerId === "string" ? item.providerId : "",
      targetLang,
      prompt: typeof item.prompt === "string" ? item.prompt.trim().slice(0, MAX_INPUT_TEMPLATE_PROMPT) : ""
    });
  }
  return { enabled: input?.enabled !== false, templates };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
