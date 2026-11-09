import { t } from "../../shared/i18n";
import { deepLEndpoint, deepLLanguage } from "../../shared/deepl";
import type { DeepLConfig, TranslateBatchRequest, TranslatorProvider, ValidationResult } from "../../shared/types";
import { API_TRANSLATION_TIMEOUT_MS, fetchWithTimeout, httpResponseError, readJsonResponse } from "../provider-transport";
import { TranslationResponseError } from "../translation-response";
import { withProviderOriginCompatibility } from "../ollama-compatibility";

// Leave room for HTTP headers below DeepL's 128 KiB total request limit.
const MAX_BODY_BYTES = 120 * 1024;
const MAX_TEXTS = 50;

export class DeepLProvider implements TranslatorProvider {
  constructor(private readonly config: DeepLConfig) {}
  get id(): string { return this.config.id; }
  get label(): string { return this.config.label; }

  validateConfig(): ValidationResult {
    if (!this.config.apiKey.trim()) return { ok: false, message: t("apiKeyRequired") };
    try { deepLEndpoint(this.config); }
    catch { return { ok: false, message: t("deepLInvalidEndpoint") }; }
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal, onUsage?: (payload: unknown) => void): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);
    signal?.throwIfAborted();
    const source = request.sourceLang?.trim();
    const parameters = {
      target_lang: deepLLanguage(request.targetLang, true),
      ...(source && source.toLowerCase() !== "auto" ? { source_lang: deepLLanguage(source, false) } : {}),
      ...(request.context ? { context: request.context } : {})
    };
    const encode = (text: string[]) => JSON.stringify({ ...parameters, text });
    const bytes = new TextEncoder();
    const batches: { body: string; count: number }[] = [];
    let texts: string[] = [];
    // Validate all groups before sending any billable requests.
    for (const text of request.texts) {
      const next = [...texts, text];
      if (next.length > MAX_TEXTS || bytes.encode(encode(next)).byteLength > MAX_BODY_BYTES) {
        if (texts.length) batches.push({ body: encode(texts), count: texts.length });
        texts = [text];
        if (bytes.encode(encode(texts)).byteLength > MAX_BODY_BYTES) throw new Error(t("deepLRequestTooLarge"));
      } else texts = next;
    }
    if (texts.length) batches.push({ body: encode(texts), count: texts.length });

    const translations: string[] = [];
    for (const batch of batches) {
      signal?.throwIfAborted();
      const endpoint = deepLEndpoint(this.config);
      const response = await withProviderOriginCompatibility(endpoint, () => fetchWithTimeout(endpoint, {
        method: "POST", signal, credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${this.config.apiKey.trim()}` },
        body: batch.body
      }, API_TRANSLATION_TIMEOUT_MS));
      if (!response.ok) {
        const message = response.status === 403 ? t("deepLAuthenticationFailed")
          : response.status === 456 ? t("deepLQuotaExceeded")
          : response.status === 400 ? t("deepLInvalidRequest")
          : t("httpRequestFailed", response.status);
        throw httpResponseError(response, message, response.status === 456 ? "service-rejected" : undefined);
      }
      const payload = await readJsonResponse<{ translations?: { text?: unknown }[] }>(response, "DeepL", onUsage);
      const result = payload?.translations;
      if (!Array.isArray(result) || result.length !== batch.count
        || !result.every(entry => typeof entry?.text === "string" && entry.text.trim())) {
        throw new TranslationResponseError(t("deepLInvalidResponse"));
      }
      translations.push(...result.map(entry => entry.text as string));
    }
    return translations;
  }
}
