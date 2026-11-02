import type { HttpTemplateConfig, TranslateBatchRequest, TranslatorProvider, ValidationResult } from "../../shared/types";
import { readPath, renderTemplate } from "../template";
import { fetchWithTimeout, API_TRANSLATION_TIMEOUT_MS, httpResponseError, readJsonResponse } from "../provider-transport";

export class HttpTemplateProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: HttpTemplateConfig) {}

  validateConfig(): ValidationResult {
    if (!this.config.url.trim()) return { ok: false, message: "URL is required." };
    if (!this.config.responsePath.trim()) {
      return { ok: false, message: "Response path is required." };
    }
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal, onUsage?: (payload: unknown) => void): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const context = {
      texts: request.texts,
      context: request.context ?? "",
      sourceLang: request.sourceLang ?? "auto",
      targetLang: request.targetLang
    };
    const url = renderTemplate(this.config.url, context);
    const headers = Object.fromEntries(
      Object.entries(this.config.headers).map(([key, value]) => [key, renderTemplate(value, context)])
    );

    const response = await fetchWithTimeout(url, {
      method: this.config.method,
      signal,
      headers,
      body:
        this.config.method === "POST"
          ? renderTemplate(this.config.bodyTemplate, context)
          : undefined
    }, API_TRANSLATION_TIMEOUT_MS);

    if (!response.ok) throw httpResponseError(response, `HTTP template request failed: ${response.status}`);
    const payload = await readJsonResponse<unknown>(response, "HTTP template provider", onUsage);
    const translations = readPath(payload, this.config.responsePath);
    if (!Array.isArray(translations) || !translations.every((item) => typeof item === "string")) {
      throw new Error("Response path must resolve to an array of strings.");
    }
    if (translations.length !== request.texts.length) {
      throw new Error("Translation count does not match source text count.");
    }
    return translations;
  }
}
