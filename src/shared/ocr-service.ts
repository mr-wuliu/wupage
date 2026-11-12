import { t } from "./i18n";

export interface OcrSettings {
  mode: "builtin" | "http";
  /** Complete recognition URL; no path is appended. */
  endpoint: string;
  model: string;
  apiKey: string;
  /** Change this after replacing weights on the server to invalidate caches. */
  modelRevision: string;
}

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  mode: "builtin", endpoint: "", model: "", apiKey: "", modelRevision: "1"
};

export function normalizeOcrSettings(value: unknown): OcrSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const string = (key: keyof OcrSettings, fallback = ""): string => typeof input[key] === "string" ? input[key] as string : fallback;
  return { mode: input.mode === "http" ? "http" : "builtin", endpoint: string("endpoint").trim(),
    model: string("model").trim(), apiKey: string("apiKey").trim(), modelRevision: string("modelRevision", "1").trim() };
}

export function validateOcrService(config: OcrSettings): void {
  let url: URL;
  try { url = new URL(config.endpoint); } catch { throw new Error(t("ocrServiceInvalidEndpoint")); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || config.endpoint.length > 2048) {
    throw new Error(t("ocrServiceInvalidEndpoint"));
  }
  if (!config.model || config.model.length > 200 || !config.modelRevision || config.modelRevision.length > 200
    || config.apiKey.length > 8192 || /[\r\n]/u.test(config.apiKey)) throw new Error(t("ocrServiceInvalidConfig"));
}

export function ocrSettingsIdentity(value: unknown): string {
  const config = normalizeOcrSettings(value);
  return JSON.stringify(config.mode === "builtin" ? { mode: "builtin" } : config);
}

export interface OcrImageInput { dataUrl: string; width: number; height: number }

export function validateOcrImage(input: OcrImageInput): void {
  if (typeof input?.dataUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(input.dataUrl)
    || input.dataUrl.length > 12 * 1024 * 1024 * 4 / 3 + 100
    || !Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width <= 0 || input.height <= 0 || input.width > 4096 || input.height > 4096
    || input.width * input.height > 16_000_000) throw new Error(t("unsupportedImageFormatOrDimensionsTryASmaller"));
}
