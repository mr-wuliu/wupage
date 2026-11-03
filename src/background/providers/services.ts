import type { DualServiceProviderConfig, GoogleCloudTranslationConfig, GoogleWebTranslateConfig, MicrosoftTranslatorConfig, MicrosoftWebTranslateConfig, ProviderConfig, TranslateBatchRequest, TranslatorProvider, ValidationResult } from "../../shared/types";
import { chatCompletionsEndpoint } from "../ollama-compatibility";
import { TranslationResponseError } from "../translation-response";
import { translationApiOptions } from "../../shared/translation-service";
import { signVolcengineTranslation } from "../volcengine-signing";
import { alignGoogleContext, googleContextSource } from "../google-context";
import { ProviderError } from "../../shared/errors";
import { fetchWithTimeout, httpResponseError, readJsonResponse, API_TRANSLATION_TIMEOUT_MS } from "../provider-transport";

const GOOGLE_WEB_REQUEST_CONCURRENCY = 4;

const WEB_TRANSLATION_TIMEOUT_MS = 20_000;

export class GoogleWebTranslateProvider implements TranslatorProvider {
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
    const fetchText = async (text: string): Promise<GoogleWebTranslateResponse> => {
      signal?.throwIfAborted();
      const endpoint = new URL("https://translate.googleapis.com/translate_a/single");
      endpoint.searchParams.set("client", "gtx");
      endpoint.searchParams.set("sl", normalizeGoogleLang(request.sourceLang ?? "auto"));
      endpoint.searchParams.set("tl", normalizeGoogleLang(request.targetLang));
      endpoint.searchParams.set("dt", "t");
      endpoint.searchParams.set("q", text);

      const response = await fetchWithTimeout(endpoint.toString(), { signal }, WEB_TRANSLATION_TIMEOUT_MS);
      if (!response.ok) throw httpResponseError(response, `Google Web Translate request failed: ${response.status}`);
      return readJsonResponse<GoogleWebTranslateResponse>(response, "Google Web Translate");
    };
    let aligned: Array<string | undefined> = request.texts.map(() => undefined);
    if (request.context && request.texts.length) {
      const { source, ranges } = googleContextSource(request.context, request.texts);
      const payload = await fetchText(source);
      signal?.throwIfAborted();
      aligned = alignGoogleContext(payload, source, ranges);
    }
    return mapWithConcurrency(request.texts, GOOGLE_WEB_REQUEST_CONCURRENCY, async (text, index) => {
      const value = aligned[index];
      // Auto-detection over mixed-language context can leave foreign text intact.
      if (value !== undefined && (request.sourceLang && request.sourceLang !== "auto" || value.trim() !== text.trim())) return value;
      return parseGoogleWebResponse(await fetchText(text));
    });
  }
}

export class MicrosoftWebTranslateProvider implements TranslatorProvider {
  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label;
  }

  constructor(private readonly config: MicrosoftWebTranslateConfig) {}

  validateConfig(): ValidationResult {
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    if (!request.texts.length) return [];
    const endpoint = new URL("https://edge.microsoft.com/translate/translatetext");
    endpoint.searchParams.set("from", request.sourceLang && request.sourceLang !== "auto"
      ? normalizeMicrosoftLang(request.sourceLang) : "");
    endpoint.searchParams.set("to", normalizeMicrosoftLang(request.targetLang));
    endpoint.searchParams.set("isEnterpriseClient", "false");
    const prepared = request.texts.map(prepareMicrosoftWebText);

    // This browser endpoint interprets angle brackets as markup even for plain
    // text. Escape them before transport and decode the returned text once.
    const response = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prepared.map((item) => item.text)),
      signal
    }, WEB_TRANSLATION_TIMEOUT_MS);
    if (!response.ok) throw httpResponseError(response, `Microsoft 免费翻译请求失败 (${response.status})。请稍后重试或切换翻译服务。`);
    const payload = await readJsonResponse<MicrosoftTranslateResponse>(response, "Microsoft Web Translate");
    if (!Array.isArray(payload) || payload.length !== request.texts.length) {
      throw new TranslationResponseError("Microsoft Web Translate response count does not match source text count.");
    }
    return payload.map((entry, index) => {
      const text = entry?.translations?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new TranslationResponseError("Microsoft Web Translate response did not include translated text.");
      }
      return restoreLiteralEntities(decodeHtmlEntities(text), prepared[index].entities);
    });
  }
}

function prepareMicrosoftWebText(source: string): {
  text: string;
  entities: Array<{ marker: string; literal: string }>;
} {
  const prepared = protectLiteralEntities(source);
  return { ...prepared, text: prepared.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
}

function protectLiteralEntities(source: string): {
  text: string;
  entities: Array<{ marker: string; literal: string }>;
} {
  // Literal entity text (such as documentation showing &lt;) must not be
  // interpreted or decoded by the upstream HTML processor.
  let prefix = "WUPAGEENTITY";
  while (source.includes(prefix)) prefix += "X";
  const entities: Array<{ marker: string; literal: string }> = [];
  const protectedText = source.replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/gi, (literal) => {
    const marker = `⟪${prefix}${entities.length}⟫`;
    entities.push({ marker, literal });
    return marker;
  });
  return { text: protectedText, entities };
}

function restoreLiteralEntities(text: string, entities: Array<{ marker: string; literal: string }>): string {
  for (const { marker, literal } of entities) {
    if (text.split(marker).length !== 2) {
      throw new TranslationResponseError("Translation response did not preserve literal entities.");
    }
    text = text.replace(marker, () => literal);
  }
  return text;
}

export class CloudTranslationProvider implements TranslatorProvider {
  constructor(private readonly config: DualServiceProviderConfig) {}
  get id(): string { return this.config.id; }
  get label(): string { return this.config.label; }

  validateConfig(): ValidationResult {
    const api = translationApiOptions(this.config);
    if (this.config.type === "volcengine-web-translate") {
      return api.accessKeyId?.trim() && api.secretAccessKey?.trim()
        ? { ok: true } : { ok: false, message: "请填写火山引擎 Access Key ID 和 Secret Access Key。" };
    }
    if (!api.apiKey?.trim()) return { ok: false, message: "请填写 API Key，或切换到免费服务。" };
    if (this.config.type === "tencent-transmart") {
      try {
        const url = new URL(api.endpoint ?? "");
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { return { ok: false, message: "请填写有效的 HTTPS Base URL。" }; }
      if (!api.model?.trim()) return { ok: false, message: "请填写 TokenHub 翻译模型。" };
    }
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal, onUsage?: (payload: unknown) => void): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);
    signal?.throwIfAborted();
    if (!request.texts.length) return [];
    const api = translationApiOptions(this.config);
    if (this.config.type === "tencent-transmart") {
      return mapWithConcurrency(request.texts, 1, async text => {
        const payload = await this.request<{ choices?: Array<{ message?: { content?: unknown } }> }>(
          chatCompletionsEndpoint(api.endpoint!), { "Content-Type": "application/json", Authorization: `Bearer ${api.apiKey}` },
          { model: api.model, stream: false, messages: [{ role: "user", content:
            `Translate the following text${request.sourceLang && request.sourceLang !== "auto" ? ` from ${request.sourceLang}` : ""} into ${request.targetLang}. Preserve placeholders, numbers, links and formatting. Return only the translated text.\n\n${text}` }] }, signal, onUsage);
        const translated = payload.choices?.[0]?.message?.content;
        if (typeof translated !== "string" || !translated.trim()) throw new Error("TokenHub 未返回完整译文。");
        return translated;
      });
    }
    const result: string[] = [];
    const limit = this.config.type === "volcengine-web-translate" ? 5000 : 10000;
    // Respect both the item count and character limit of the official batch endpoints.
    for (let cursor = 0; cursor < request.texts.length;) {
      const texts: string[] = []; let length = 0;
      while (cursor < request.texts.length && texts.length < 16 && length + request.texts[cursor].length <= limit) {
        const text = request.texts[cursor++]; texts.push(text); length += text.length;
      }
      if (!texts.length) throw new Error(`${this.label} 单段文本超过 ${limit} 字符，请减小分块大小。`);
      const source = request.sourceLang && request.sourceLang !== "auto" ? normalizePublicLanguage(request.sourceLang) : undefined;
      if (this.config.type === "yandex-web-translate") {
        const payload = await this.request<{ translations?: Array<{ text?: unknown }> }>(
          "https://translate.api.cloud.yandex.net/translate/v2/translate",
          { "Content-Type": "application/json", Authorization: `Api-Key ${api.apiKey}` },
          { texts, targetLanguageCode: normalizePublicLanguage(request.targetLang), format: "PLAIN_TEXT",
            ...(source ? { sourceLanguageCode: source } : {}), ...(api.folderId ? { folderId: api.folderId } : {}) }, signal);
        result.push(...this.checkTranslations(payload.translations?.map(entry => entry.text), texts.length));
      } else {
        const body = { TextList: texts, TargetLanguage: normalizeVolcengineLang(request.targetLang),
          ...(source ? { SourceLanguage: normalizeVolcengineLang(source) } : {}) };
        const headers = await signVolcengineTranslation(JSON.stringify(body), api.accessKeyId!, api.secretAccessKey!, api.region || "cn-north-1");
        const payload = await this.request<{ TranslationList?: Array<{ Translation?: unknown }>;
          ResponseMetadata?: { Error?: { Code?: string; Message?: string } } }>(
          "https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01", headers, body, signal);
        if (payload.ResponseMetadata?.Error) throw new Error(`火山引擎 API 请求失败：${payload.ResponseMetadata.Error.Code || "未知错误"}`);
        result.push(...this.checkTranslations(payload.TranslationList?.map(entry => entry.Translation), texts.length));
      }
    }
    return result;
  }

  private checkTranslations(values: unknown[] | undefined, count: number): string[] {
    if (!Array.isArray(values) || values.length !== count || values.some(text => typeof text !== "string" || !text.trim())) {
      throw new Error(`${this.label} API 未返回完整译文。`);
    }
    return values as string[];
  }

  private async request<T>(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, onUsage?: (payload: unknown) => void): Promise<T> {
    signal?.throwIfAborted();
    const response = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", redirect: "error", signal }, API_TRANSLATION_TIMEOUT_MS);
    if (!response.ok) throw httpResponseError(response, `${this.label} API 请求失败 (${response.status})，请检查凭据、额度或使用方式。`);
    return readJsonResponse<T>(response, this.label, onUsage);
  }
}

type PublicTranslationConfig = Extract<ProviderConfig, {
  type: "tencent-transmart" | "yandex-web-translate" | "volcengine-web-translate" | "mymemory";
}>;

let transmartClientId: string | undefined;

export class PublicTranslationProvider implements TranslatorProvider {
  constructor(private readonly config: PublicTranslationConfig) {}

  get id(): string { return this.config.id; }
  get label(): string { return this.config.label; }
  validateConfig(): ValidationResult {
    return this.config.type === "mymemory" && this.config.serviceMode === "api" && !this.config.api?.apiKey?.trim()
      ? { ok: false, message: "请填写 RapidAPI Key，或切换到免费服务。" } : { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);
    signal?.throwIfAborted();
    if (!request.texts.length) return [];
    const from = request.sourceLang && request.sourceLang !== "auto" ? normalizePublicLanguage(request.sourceLang) : "auto";
    const to = normalizePublicLanguage(request.targetLang);
    if (this.config.type === "tencent-transmart") {
      transmartClientId ??= `browser-chrome-120.0.0-Windows-${crypto.randomUUID()}-${Date.now()}`;
      const payload = await this.requestJson<{ header?: { ret_code?: string }; auto_translation?: unknown }>(
        "https://transmart.qq.com/api/imt", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            header: { fn: "auto_translation", client_key: transmartClientId },
            type: "plain", model_category: "normal",
            source: { text_list: request.texts, lang: from }, target: { lang: to }
          })
        }, signal
      );
      if (payload?.header?.ret_code !== "succ") throw new Error("腾讯 TranSmart 暂时无法翻译，请稍后重试或切换服务。");
      return validatePublicTranslations(payload.auto_translation, request.texts.length);
    }
    if (this.config.type === "mymemory") return this.translateMyMemory(request, signal);
    return mapWithConcurrency(request.texts, 1, async text => {
      signal?.throwIfAborted();
      if (this.config.type === "yandex-web-translate") {
        const url = new URL("https://translate.yandex.net/api/v1/tr.json/translate");
        url.search = new URLSearchParams({ id: `${crypto.randomUUID().replace(/-/g, "")}-0-0`, srv: "android",
          target_lang: to, text, ...(from !== "auto" ? { source_lang: from } : {}) }).toString();
        const payload = await this.requestJson<{ code?: number; text?: unknown }>(url.toString(), { method: "POST" }, signal);
        if (payload?.code !== 200) throw new Error(`Yandex 免费翻译暂时不可用 (${payload?.code ?? "未知错误"})，请稍后重试或切换服务。`);
        return validatePublicTranslations(payload.text, 1)[0];
      }
      const payload = await this.requestJson<{ translation?: unknown; base_resp?: { status_code?: number } }>(
        "https://translate.volcengine.com/crx/translate/v1", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_language: normalizeVolcengineLang(from), target_language: normalizeVolcengineLang(to), text })
        }, signal
      );
      if (payload?.base_resp?.status_code !== 0) throw new Error("火山免费翻译暂时不可用，请稍后重试或切换服务。");
      return validatePublicTranslations([payload.translation], 1)[0];
    });
  }

  private async requestJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const response = await fetchWithTimeout(url, { ...init, credentials: "omit", signal }, WEB_TRANSLATION_TIMEOUT_MS);
    if (!response.ok) {
      if (this.config.type === "mymemory" && response.status === 429) throw this.myMemoryQuotaError();
      throw httpResponseError(response, `${this.label} 请求失败 (${response.status})，请稍后重试或切换服务。`);
    }
    return readJsonResponse<T>(response, this.label);
  }

  private async translateMyMemory(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    let source = request.sourceLang;
    if (!source || source === "auto") {
      if (typeof chrome === "undefined" || !chrome.i18n?.detectLanguage) {
        throw new Error("MyMemory 无法自动识别源语言，请手动选择源语言后重试。");
      }
      const detected = await chrome.i18n.detectLanguage(request.texts.join("\n").slice(0, 12000));
      signal?.throwIfAborted();
      const best = detected.languages[0];
      if (!best || best.language === "und" || best.percentage < 50) {
        throw new Error("MyMemory 无法可靠识别源语言，请手动选择源语言后重试。");
      }
      source = best.language;
    }
    if (normalizePublicLanguage(source) === normalizePublicLanguage(request.targetLang)) return [...request.texts];
    const langpair = `${source}|${request.targetLang}`;
    return mapWithConcurrency(request.texts, 1, async text => {
      const prepared = protectLiteralEntities(text);
      const pieces = splitMyMemoryText(prepared.text);
      const translated = await mapWithConcurrency(pieces, 1, async piece => {
        signal?.throwIfAborted();
        if (!piece.trim()) return piece;
        const leading = piece.match(/^\s*/u)![0];
        const trailing = piece.match(/\s*$/u)![0];
        const useApi = this.config.serviceMode === "api";
        const host = "translated-mymemory---translation-memory.p.rapidapi.com";
        const url = new URL(useApi ? `https://${host}/api/get` : "https://api.mymemory.translated.net/get");
        url.search = new URLSearchParams({ q: piece.trim(), langpair }).toString();
        const headers: Record<string, string> = useApi
          ? { "X-RapidAPI-Key": this.config.api?.apiKey ?? "", "X-RapidAPI-Host": host } : {};
        const payload = await this.requestJson<{ responseStatus?: number | string; quotaFinished?: boolean; responseDetails?: string;
          responseData?: { translatedText?: unknown } }>(url.toString(), { method: "GET", headers, redirect: "error" }, signal);
        if (payload?.quotaFinished === true || Number(payload?.responseStatus) === 429
          || (Number(payload?.responseStatus) === 403 && /quota|used all|limit|next available/i.test(payload?.responseDetails ?? ""))) {
          throw this.myMemoryQuotaError();
        }
        if (Number(payload?.responseStatus) !== 200) throw new Error("MyMemory 暂时无法翻译，请检查源语言或切换服务。");
        return leading + decodeHtmlEntities(validatePublicTranslations([payload.responseData?.translatedText], 1)[0]).trim() + trailing;
      });
      return restoreLiteralEntities(translated.join(""), prepared.entities);
    });
  }

  private myMemoryQuotaError(): Error {
    return new ProviderError(this.config.serviceMode === "api"
      ? "MyMemory API 额度已用完，请检查 RapidAPI 订阅或切换服务。"
      : "MyMemory 免费额度已用完，请次日重试或切换服务。", "rate-limited");
  }
}

function normalizePublicLanguage(value: string): string {
  return /^(?:zh|zh-cn|zh-hans)$/i.test(value) ? "zh" : value;
}

function validatePublicTranslations(value: unknown, count: number): string[] {
  if (!Array.isArray(value) || value.length !== count || value.some(text => typeof text !== "string" || !text.trim())) {
    throw new TranslationResponseError("Translation response did not include the expected nonempty text items.");
  }
  return value as string[];
}

function splitMyMemoryText(text: string): string[] {
  const encoder = new TextEncoder();
  const output: string[] = [];
  let current = "";
  // Keep Unicode code points and translation placeholders intact at the byte boundary.
  for (const token of text.match(/⟪WUPAGE[^⟫]*⟫|[\s\S]/gu) ?? []) {
    if (encoder.encode(token).byteLength > 500) throw new Error("MyMemory 无法处理过长的受保护文本，请切换翻译服务。");
    while (encoder.encode(current + token).byteLength > 500) {
      let boundary = 0;
      for (const match of current.matchAll(/[\s.!?。！？]+/gu)) boundary = match.index + match[0].length;
      const split = boundary > current.length / 2 ? boundary : current.length;
      output.push(current.slice(0, split));
      current = current.slice(split);
    }
    current += token;
  }
  if (current) output.push(current);
  return output;
}

export class MicrosoftTranslatorProvider implements TranslatorProvider {
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
    try {
      const url = new URL(this.config.endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { return { ok: false, message: "请填写有效的 HTTPS Endpoint。" }; }
    return { ok: true };
  }

  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    const validation = this.validateConfig();
    if (!validation.ok) throw new Error(validation.message);

    const base = this.config.endpoint.replace(/\/+$/, "");
    const endpoint = new URL(base.endsWith("/translate") ? base : `${base}/translate`);
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

    const response = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      signal,
      credentials: "omit",
      redirect: "error",
      headers,
      body: JSON.stringify(request.texts.map((text) => ({ Text: text })))
    }, API_TRANSLATION_TIMEOUT_MS);

    if (!response.ok) throw httpResponseError(response, `Microsoft Translator request failed: ${response.status}`);
    const payload = await readJsonResponse<MicrosoftTranslateResponse>(
      response,
      "Microsoft Translator"
    );
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

export class GoogleCloudTranslationProvider implements TranslatorProvider {
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

    const response = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      signal,
      credentials: "omit",
      redirect: "error",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, API_TRANSLATION_TIMEOUT_MS);

    if (!response.ok) throw httpResponseError(response, `Google Cloud Translation request failed: ${response.status}`);
    const payload = await readJsonResponse<GoogleTranslateResponse>(
      response,
      "Google Cloud Translation"
    );
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

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = Array<R>(values.length);
  let cursor = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try { output[index] = await mapper(values[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
  );
  return output;
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
  if (value === "zh-CN") return "zh-Hans";
  return value === "zh-TW" ? "zh-Hant" : value;
}

function normalizeVolcengineLang(value: string): string {
  return value === "zh-TW" ? "zh-Hant" : normalizePublicLanguage(value);
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
      const point = Number.parseInt(entity.slice(2), 16);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    if (entity.startsWith("#")) {
      const point = Number.parseInt(entity.slice(1), 10);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return namedEntities[entity] ?? match;
  });
}
