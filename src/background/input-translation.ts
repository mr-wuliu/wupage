import { INPUT_TRANSLATION_MAX_CHARS, inputProviderCandidates, inputTargetLanguage, normalizeInputTranslation } from "../shared/input-translation";
import { isLlmProvider } from "../shared/performance";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";
import { createProvider } from "./providers";
import { translateWithSettings } from "./translation";

export interface InputTranslationResult {
  translation: string;
  providerLabel: string;
}

/** One uncached request through the shared scheduler; typed text never enters the translation cache. */
export async function translateInput(settings: ExtensionSettings, text: string, signal?: AbortSignal): Promise<InputTranslationResult> {
  const options = normalizeInputTranslation(settings.inputTranslation);
  if (!options.enabled) throw new Error("输入框翻译已关闭，可在「设置 → 输入框翻译」中开启。");
  if (!text.trim()) throw new Error("输入框里没有可翻译的文字。");
  if (text.length > INPUT_TRANSLATION_MAX_CHARS) {
    throw new Error(`文字过长（上限 ${INPUT_TRANSLATION_MAX_CHARS} 字符），请选中一部分后再翻译。`);
  }
  const candidates = inputProviderCandidates(settings);
  if (!candidates.length) throw new Error("输入框翻译需要可用的翻译服务，请先在「翻译服务」中启用一个服务。");
  // Incomplete services are skipped with their reason; the first usable one translates.
  let provider: ProviderConfig | undefined;
  let reason = "";
  for (const candidate of candidates) {
    const validation = createProvider(candidate).validateConfig();
    if (validation.ok) { provider = candidate; break; }
    reason ||= validation.message ?? "服务配置不完整";
  }
  if (!provider) throw new Error(`输入框翻译没有可用的翻译服务：${reason}。请在「翻译服务」中完成配置。`);
  // The input prompt asks an LLM for a native rewrite; machine translation receives the plain text only.
  const chosen = provider;
  const { translations } = await translateWithSettings({
    ...settings,
    providers: isLlmProvider(chosen)
      ? settings.providers.map(item => item.id === chosen.id ? { ...item, systemPrompt: options.prompt } as typeof item : item)
      : settings.providers
  }, {
    texts: [text], sourceLang: "auto", targetLang: inputTargetLanguage(text), providerId: provider.id
  }, { signal, priority: true, persistentCache: false });
  const translation = translations[0];
  if (!translation?.trim()) throw new Error("翻译服务没有返回译文。");
  return { translation, providerLabel: provider.label };
}
