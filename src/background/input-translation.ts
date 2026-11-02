import { INPUT_TRANSLATION_MAX_CHARS, inputTargetLanguage, normalizeInputTranslation, pickInputProvider } from "../shared/input-translation";
import type { ExtensionSettings } from "../shared/types";
import { translateWithSettings } from "./translation";

export interface InputTranslationResult {
  translation: string;
  providerLabel: string;
}

/** One uncached LLM request through the shared scheduler; typed text never enters the translation cache. */
export async function translateInput(settings: ExtensionSettings, text: string, signal?: AbortSignal): Promise<InputTranslationResult> {
  const options = normalizeInputTranslation(settings.inputTranslation);
  if (!options.enabled) throw new Error("输入框翻译已关闭，可在「设置 → 输入框翻译」中开启。");
  if (!text.trim()) throw new Error("输入框里没有可翻译的文字。");
  if (text.length > INPUT_TRANSLATION_MAX_CHARS) {
    throw new Error(`文字过长（上限 ${INPUT_TRANSLATION_MAX_CHARS} 字符），请选中一部分后再翻译。`);
  }
  const provider = pickInputProvider(settings);
  if (!provider) {
    throw new Error("输入框翻译需要大模型服务，请先在设置中配置：在「翻译服务」中填写 OpenAI 兼容或 Anthropic 兼容服务的地址、模型和 API Key。");
  }
  const { translations } = await translateWithSettings({
    ...settings,
    providers: settings.providers.map(item => item.id === provider.id ? { ...item, systemPrompt: options.prompt } as typeof item : item)
  }, {
    texts: [text], sourceLang: "auto", targetLang: inputTargetLanguage(text), providerId: provider.id
  }, { signal, priority: true, persistentCache: false });
  const translation = translations[0];
  if (!translation?.trim()) throw new Error("大模型没有返回译文。");
  return { translation, providerLabel: provider.label };
}
