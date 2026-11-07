import type { DeepLConfig } from "./types";

/** Accept an API host, a /v2 base URL, or the complete translation endpoint. */
export function deepLEndpoint(config: Pick<DeepLConfig, "endpoint" | "apiKey">): string {
  const address = config.endpoint.trim()
    || (config.apiKey.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com");
  const url = new URL(address);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Invalid DeepL endpoint");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v2\/translate$/.test(path) ? path : /\/v2$/.test(path) ? `${path}/translate` : `${path}/v2/translate`;
  return url.href;
}

export function deepLLanguage(code: string, target: boolean): string {
  const language = code.trim().replace(/_/g, "-").toUpperCase();
  if (!target) return language.split("-")[0];
  if (["ZH", "ZH-CN", "ZH-SG", "ZH-HANS"].includes(language)) return "ZH-HANS";
  if (["ZH-TW", "ZH-HK", "ZH-MO", "ZH-HANT"].includes(language)) return "ZH-HANT";
  return language === "EN" ? "EN-US" : language === "PT" ? "PT-PT" : language;
}
