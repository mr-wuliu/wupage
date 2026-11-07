import { t } from "./i18n";
export type DictionaryProvider = "youdao" | "bing";
export type SelectionTriggerStyle = "dot" | "underline";

export interface SelectionTranslationSettings {
  enabled: boolean;
  provider: DictionaryProvider;
  style: SelectionTriggerStyle;
}

export interface DictionaryPronunciation {
  accent: "uk" | "us" | "default" | "pinyin";
  phonetic?: string;
  audioUrl?: string;
}

export interface DictionaryEntry {
  provider: DictionaryProvider;
  query: string;
  word: string;
  sourceUrl: string;
  pronunciations: DictionaryPronunciation[];
  meanings: { partOfSpeech: string; definition: string; pronunciation?: string }[];
}

export const DICTIONARY_LABELS: Record<DictionaryProvider, string> = { get youdao() { return t("youdaoDictionary"); }, get bing() { return t("bingDictionary"); } };
export const DEFAULT_SELECTION_TRANSLATION: SelectionTranslationSettings = { enabled: true, provider: "youdao", style: "dot" };
export const MAX_DICTIONARY_QUERY_LENGTH = 100;
export const MAX_CHINESE_DICTIONARY_QUERY_LENGTH = 8;
export const MAX_SELECTION_TEXT_LENGTH = 5000;

export function normalizeSelectionText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_SELECTION_TEXT_LENGTH * 4) return "";
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return Array.from(text).length <= MAX_SELECTION_TEXT_LENGTH && /\p{L}/u.test(text)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? text : "";
}

export function isSingleDictionaryWord(value: string): boolean {
  const query = normalizeDictionaryQuery(value);
  // Short Han selections cover characters and words; longer prose goes to translation.
  return isChineseDictionaryQuery(query) || (/^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(query)
    && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query));
}

export function isChineseDictionaryQuery(value: string): boolean {
  const query = normalizeDictionaryQuery(value);
  return /^\p{Script=Han}+$/u.test(query) && Array.from(query).length <= MAX_CHINESE_DICTIONARY_QUERY_LENGTH;
}

/** Chinese readings and definitions come from Youdao's Chinese dictionary. */
export function dictionaryProviderForQuery(provider: DictionaryProvider, query: string): DictionaryProvider {
  return isChineseDictionaryQuery(query) ? "youdao" : provider;
}

export function normalizeSelectionTranslation(value: unknown): SelectionTranslationSettings {
  const input = value && typeof value === "object" ? value as Partial<SelectionTranslationSettings> : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SELECTION_TRANSLATION.enabled,
    provider: input.provider === "bing" ? "bing" : "youdao",
    style: input.style === "underline" ? "underline" : "dot"
  };
}

export function normalizeDictionaryQuery(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000) return "";
  const query = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return Array.from(query).length <= MAX_DICTIONARY_QUERY_LENGTH && /\p{L}/u.test(query)
    && !/[\u0000-\u001f\u007f]/u.test(query) ? query : "";
}

export function dictionarySourceUrl(provider: DictionaryProvider, query: string): string {
  const url = new URL(provider === "bing" ? "https://cn.bing.com/dict/search" : "https://dict.youdao.com/result");
  url.searchParams.set(provider === "bing" ? "q" : "word", query);
  if (provider === "youdao" && isChineseDictionaryQuery(query)) url.searchParams.set("lang", "zh");
  return url.href;
}

/** Audio requests may only reach the two dictionary voice endpoints. */
export function isDictionaryAudioUrl(provider: DictionaryProvider, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (provider === "youdao" ? url.hostname === "dict.youdao.com" && url.pathname === "/dictvoice"
        : provider === "bing" && url.hostname === "cn.bing.com" && url.pathname === "/dict/mediamp3");
  } catch { return false; }
}
