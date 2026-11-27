export const DOUBAO_PROTOCOL_VERSION = 1;
export const DOUBAO_ORIGIN = "https://www.doubao.com";
export const DOUBAO_LAUNCH_ENDPOINT = `${DOUBAO_ORIGIN}/alice/user/launch`;
export const DOUBAO_TRANSLATE_ENDPOINT = `${DOUBAO_ORIGIN}/samantha/plugin/stream_article_translate`;
export const DOUBAO_TARGET_LANGUAGES: Readonly<Record<string, string>> = {
  "zh-CN": "zh", en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es", ru: "ru"
};

export function isDoubaoBrowserSupported(): boolean {
  try {
    return typeof chrome !== "undefined"
      && new URL(chrome.runtime.getURL("/")).protocol === "chrome-extension:";
  } catch {
    return false;
  }
}
