import { isLlmProvider } from "./performance";
import type { ExtensionSettings, ProviderConfig } from "./types";

/** Longest text sent in one input translation request. */
export const INPUT_TRANSLATION_MAX_CHARS = 8000;

/** Fixed Chinese ⇄ English writing assistant; the provider adds its own JSON-array output rules. */
export const DEFAULT_INPUT_PROMPT = [
  "You are a writing assistant for text the user is typing into a form field; the text may be rough, non-native or dictated (ASR).",
  "Translate each input item between Chinese and English, and the output language always differs from the input language:",
  "if the item is written mainly in Chinese, the output must be natural English (never Chinese);",
  "if it is English or any other language, the output must be Simplified Chinese.",
  "Do not translate word for word. While translating, rewrite so the result reads like something a native speaker would write for the same purpose:",
  "rephrase awkward or non-native wording, reorder clauses, merge fragments and drop false starts and repetitions.",
  "Leave out filler and verbal tics (嗯, 呃, 那个, 就是, 然后, 对对对, um, uh, you know, like, I mean, sort of) and fix obvious speech-recognition mistakes (homophones, wrong word boundaries) from the context.",
  "Keep every fact, the intent, tone and level of formality; never add, explain or answer anything.",
  "Keep line breaks, paragraph structure, emoji, @mentions, #tags, URLs, numbers, code and placeholders unchanged.",
  "Output only the final translated text, with no explanations or quotation marks added."
].join(" ");

export interface InputTranslationSettings {
  enabled: boolean;
  /** LLM service id; empty uses the default service when it is an LLM, then any other configured LLM. */
  providerId: string;
  prompt: string;
}

export const DEFAULT_INPUT_TRANSLATION: InputTranslationSettings = {
  enabled: true, providerId: "", prompt: DEFAULT_INPUT_PROMPT
};

export function normalizeInputTranslation(value: unknown): InputTranslationSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Record<keyof InputTranslationSettings, unknown>> : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_INPUT_TRANSLATION.enabled,
    providerId: typeof input.providerId === "string" ? input.providerId.trim() : "",
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : DEFAULT_INPUT_PROMPT
  };
}

/** Loopback and private-network endpoints (Ollama, LM Studio…) can run without an API key. */
function isLocalEndpoint(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return host === "localhost" || host === "[::1]" || host.endsWith(".local")
      || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host);
  } catch { return false; }
}

/** An enabled LLM service with an address, a model and an API key (not needed for local endpoints). */
export function isInputTranslationProvider(provider: ProviderConfig): boolean {
  if (!isLlmProvider(provider) || provider.enabled === false || !("baseURL" in provider)) return false;
  return Boolean(provider.baseURL.trim() && provider.model.trim() && (provider.apiKey.trim() || isLocalEndpoint(provider.baseURL)));
}

/** The chosen LLM service, else the default service when it is an LLM, else the first configured LLM. */
export function pickInputProvider(settings: ExtensionSettings): ProviderConfig | undefined {
  const usable = (id: string) => id ? settings.providers.find(provider => provider.id === id && isInputTranslationProvider(provider)) : undefined;
  return usable(normalizeInputTranslation(settings.inputTranslation).providerId)
    ?? usable(settings.activeProviderId)
    ?? settings.providers.find(isInputTranslationProvider);
}

/** Text written mainly in Chinese goes to English; anything else goes to Simplified Chinese. */
export function inputTargetLanguage(text: string): "English" | "Simplified Chinese" {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kanaOrHangul = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const otherLetters = (text.match(/\p{L}/gu)?.length ?? 0) - han - kanaOrHangul;
  // A Chinese character carries roughly a word; three Latin letters per character keeps mixed Chinese notes Chinese.
  return han > 0 && kanaOrHangul * 4 < han && han * 3 >= otherLetters ? "English" : "Simplified Chinese";
}
