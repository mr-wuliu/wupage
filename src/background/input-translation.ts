import { t } from "../shared/i18n";
import { inputTemplateProvider, KEEP_INPUT_LANGUAGE, normalizeInputTranslation } from "../shared/input-translation";
import { getSettings } from "../shared/settings";
import { translateWithSettings } from "./translation";

export async function translateInput(templateId: string, source: string, statisticsPageKey?: string): Promise<string> {
  if (typeof source !== "string" || !source.trim()) throw new Error(t("inputTranslationEmpty"));
  const settings = await getSettings();
  const input = normalizeInputTranslation(settings.inputTranslation);
  const template = input.enabled && input.templates.find(entry => entry.enabled && entry.id === templateId);
  if (!template) throw new Error(t("inputTemplateUnavailable"));
  const provider = inputTemplateProvider(template, settings.providers);
  if (!provider) throw new Error(t("inputTemplateChooseService"));
  const { translations } = await translateWithSettings(settings, {
    texts: [source.trim()], providerId: provider.id, sourceLang: "auto", targetLang: template.targetLang,
    ...(template.mode === "ai" ? { inputTranslation: { prompt: template.prompt, keepLanguage: template.targetLang === KEEP_INPUT_LANGUAGE } } : {})
  }, { priority: true, persistentCache: false, applyGlossary: false, statisticsPageKey });
  const result = translations[0]?.trim();
  if (!result) throw new Error(t("theServiceReturnedNoTranslationTryAgain"));
  return result;
}
