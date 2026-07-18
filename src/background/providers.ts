import type {
  AnthropicCompatibleConfig,
  GoogleCloudTranslationConfig,
  GoogleWebTranslateConfig,
  HttpTemplateConfig,
  MicrosoftTranslatorConfig,
  OpenAICompatibleConfig,
  ProviderConfig,
  TranslateBatchRequest,
  TranslatorProvider,
  ValidationResult,
  ZhipuGlmConfig
} from "../shared/types";
import { readPath, renderTemplate } from "./template";

export function createProvider(config: ProviderConfig): TranslatorProvider {
  if (config.type === "google-web-translate") return new GoogleWebTranslateProvider(config);
  if (config.type === "microsoft-translator") return new MicrosoftTranslatorProvider(config);
  if (config.type === "google-cloud-translation") {
    return new GoogleCloudTranslationProvider(config);
  }
  if (config.type === "openai-compatible") return new OpenAICompatibleProvider(config);
  if (config.type === "anthropic-compatible") return new AnthropicCompatibleProvider(config);
  if (config.type === "zhipu-glm") return new ZhipuGlmProvider(config);
  return new HttpTemplateProvider(config);
}

class GoogleWebTranslateProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: GoogleWebTranslateConfig) {}

  validateConfig(): ValidationResult {
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    return Promise.all(
      request.texts.map(async (text) => {
        const endpoint = new URL("https://translate.googleapis.com/translate_a/single");
        endpoint.searchParams.set("client", "gtx");
        endpoint.searchParams.set("sl", normalizeGoogleLang(request.sourceLang ?? "auto"));
        endpoint.searchParams.set("tl", normalizeGoogleLang(request.targetLang));
        endpoint.searchParams.set("dt", "t");
        endpoint.searchParams.set("q", text);

        const response = await fetch(endpoint.toString(), { signal });
        if (!response.ok) throw new Error(`Google Web Translate request failed: ${response.status}`);
        const payload = (await response.json()) as GoogleWebTranslateResponse;
        return parseGoogleWebResponse(payload);
      })
    );
  }
}

class MicrosoftTranslatorProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: MicrosoftTranslatorConfig) {}

  validateConfig(): ValidationResult {
    if (!this.config.endpoint.trim()) return { ok: false, message: "Endpoint is required." };
    if (!this.config.apiKey.trim()) return { ok: false, message: "API key is required." };
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const endpoint = new URL("/translate", this.config.endpoint.replace(/\/$/, ""));
    endpoint.searchParams.set("api-version", "3.0");
    endpoint.searchParams.set("to", normalizeMicrosoftLang(request.targetLang));
    if (request.sourceLang && request.sourceLang !== "auto") {
      endpoint.searchParams.set("from", normalizeMicrosoftLang(request.sourceLang));
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": this.config.apiKey
    };
    if (this.config.region.trim()) {
      headers["Ocp-Apim-Subscription-Region"] = this.config.region.trim();
    }

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(request.texts.map((text) => ({ Text: text })))
    });

    if (!response.ok) throw new Error(`Microsoft Translator request failed: ${response.status}`);
    const payload = (await response.json()) as MicrosoftTranslateResponse;
    if (!Array.isArray(payload) || payload.length !== request.texts.length) {
      throw new Error("Microsoft Translator response count does not match source text count.");
    }

    return payload.map((entry) => {
      const text = entry.translations?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error("Microsoft Translator response did not include translated text.");
      }
      return text;
    });
  }
}

class GoogleCloudTranslationProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: GoogleCloudTranslationConfig) {}

  validateConfig(): ValidationResult {
    if (!this.config.apiKey.trim()) return { ok: false, message: "API key is required." };
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const endpoint = new URL("https://translation.googleapis.com/language/translate/v2");
    endpoint.searchParams.set("key", this.config.apiKey);

    const body: Record<string, string | string[]> = {
      q: request.texts,
      target: normalizeGoogleLang(request.targetLang),
      format: "text"
    };
    if (request.sourceLang && request.sourceLang !== "auto") {
      body.source = normalizeGoogleLang(request.sourceLang);
    }

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`Google Cloud Translation request failed: ${response.status}`);
    const payload = (await response.json()) as GoogleTranslateResponse;
    const translations = payload.data?.translations;
    if (!Array.isArray(translations) || translations.length !== request.texts.length) {
      throw new Error("Google Cloud Translation response count does not match source text count.");
    }

    return translations.map((entry) => {
      if (typeof entry.translatedText !== "string") {
        throw new Error("Google Cloud Translation response did not include translated text.");
      }
      return decodeHtmlEntities(entry.translatedText);
    });
  }
}

class OpenAICompatibleProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: OpenAICompatibleConfig) {}

  validateConfig(): ValidationResult {
    if (!this.config.baseURL.trim()) return { ok: false, message: "Base URL is required." };
    if (!this.config.model.trim()) return { ok: false, message: "Model is required." };
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const endpoint = `${this.config.baseURL.replace(/\/$/, "")}/chat/completions`;
    const systemPrompt = renderTemplate(withPlaceholderInstruction(this.config.systemPrompt), {
      texts: request.texts,
      sourceLang: request.sourceLang ?? "auto",
      targetLang: request.targetLang
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.config.apiKey.trim()) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const init: RequestInit = {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              sourceLang: request.sourceLang ?? "auto",
              targetLang: request.targetLang,
              texts: request.texts
            })
          }
        ]
      })
    };

    const response = await fetchWithLlmRetry(endpoint, init);
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}. ${await readErrorBody(response)}`);
    }
    const payload = (await response.json()) as OpenAIChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response did not include content.");

    return parseTranslationArray(content, request.texts.length);
  }
}

class AnthropicCompatibleProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: AnthropicCompatibleConfig) {}

  validateConfig(): ValidationResult {
    if (!this.config.baseURL.trim()) return { ok: false, message: "Base URL is required." };
    if (!this.config.model.trim()) return { ok: false, message: "Model is required." };
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const endpoint = `${this.config.baseURL.replace(/\/$/, "")}/messages`;
    const systemPrompt = renderTemplate(withPlaceholderInstruction(this.config.systemPrompt), {
      texts: request.texts,
      sourceLang: request.sourceLang ?? "auto",
      targetLang: request.targetLang
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01"
    };
    if (this.config.apiKey.trim()) headers["x-api-key"] = this.config.apiKey;
    const response = await fetchWithLlmRetry(endpoint, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 8192,
        temperature: 0,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              sourceLang: request.sourceLang ?? "auto",
              targetLang: request.targetLang,
              texts: request.texts
            })
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(
        `LLM request failed: ${response.status} ${response.statusText}. ${await readErrorBody(response)}`
      );
    }
    const payload = (await response.json()) as AnthropicMessagesResponse;
    const content = payload.content
      ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("");
    if (!content) throw new Error("LLM response did not include content.");
    return parseTranslationArray(content, request.texts.length);
  }
}

class ZhipuGlmProvider extends OpenAICompatibleProvider {
  constructor(config: ZhipuGlmConfig) {
    super({
      type: "openai-compatible",
      id: config.id,
      label: config.label,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: config.systemPrompt
    });
  }
}

class HttpTemplateProvider implements TranslatorProvider {
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

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const context = {
      texts: request.texts,
      sourceLang: request.sourceLang ?? "auto",
      targetLang: request.targetLang
    };
    const url = renderTemplate(this.config.url, context);
    const headers = Object.fromEntries(
      Object.entries(this.config.headers).map(([key, value]) => [key, renderTemplate(value, context)])
    );

    const response = await fetch(url, {
      method: this.config.method,
      signal,
      headers,
      body:
        this.config.method === "POST"
          ? renderTemplate(this.config.bodyTemplate, context)
          : undefined
    });

    if (!response.ok) throw new Error(`HTTP template request failed: ${response.status}`);
    const payload = (await response.json()) as unknown;
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

function parseTranslationArray(content: string, expectedLength: number): string[] {
  const trimmed = stripCodeFence(content.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    if (expectedLength === 1 && trimmed) return [trimmed];
    throw new Error("LLM response was not valid JSON.");
  }
  if (expectedLength === 1 && typeof parsed === "string") return [parsed];
  if (
    expectedLength === 1
    && Array.isArray(parsed)
    && parsed.length > 0
    && parsed.every((item) => typeof item === "string")
  ) {
    return [parsed.join("\n")];
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("LLM response must be a JSON array of strings.");
  }
  if (parsed.length !== expectedLength) {
    throw new Error(
      `LLM response count does not match source text count (expected ${expectedLength}, received ${parsed.length}).`
    );
  }
  return parsed;
}

function stripCodeFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? value;
}

function withPlaceholderInstruction(prompt: string): string {
  return `${prompt}\nPreserve placeholders matching ⟪WUPAGE0⟫, ⟪WUPAGE1⟫, etc. exactly and keep them in the most natural translated position.`;
}

async function fetchWithLlmRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 && response.status !== 503) return response;
    if (attempt === 3) return response;
    await delay(readRetryDelay(response, attempt));
  }
  throw new Error("LLM request retry loop exited unexpectedly.");
}

function readRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 1000 * 2 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    const message = readErrorMessage(parsed);
    return message ? String(message) : text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

function readErrorMessage(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    return errorRecord.message ?? errorRecord.code;
  }
  return record.message ?? record.msg ?? record.code;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface AnthropicMessagesResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

type GoogleWebTranslateResponse = unknown[];

interface MicrosoftTranslateResponse extends Array<{
  translations?: Array<{
    text?: string;
    to?: string;
  }>;
}> {}

interface GoogleTranslateResponse {
  data?: {
    translations?: Array<{
      translatedText?: string;
      detectedSourceLanguage?: string;
    }>;
  };
}

function normalizeMicrosoftLang(value: string): string {
  return value === "zh-CN" ? "zh-Hans" : value;
}

function normalizeGoogleLang(value: string): string {
  return value === "zh-CN" ? "zh-CN" : value;
}

function parseGoogleWebResponse(payload: GoogleWebTranslateResponse): string {
  const segments = payload[0];
  if (!Array.isArray(segments)) {
    throw new Error("Google Web Translate response did not include translated segments.");
  }
  const text = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : ""))
    .join("");
  if (!text) throw new Error("Google Web Translate response did not include translated text.");
  return text;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'"
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return namedEntities[entity] ?? match;
  });
}
