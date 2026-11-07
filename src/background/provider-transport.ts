import { t } from "../shared/i18n";
import { anySignal } from "../shared/abort";
import type { ProviderConfig } from "../shared/types";
import { usesOllamaCompatibility, withOllamaCompatibility } from "./ollama-compatibility";
import { ProviderError } from "../shared/errors";

export const API_TRANSLATION_TIMEOUT_MS = 45_000;

const LLM_TRANSLATION_TIMEOUT_MS = 90_000;

const MAX_TRANSLATION_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Some models (o-series, gpt-5, newer Claude) reject `temperature` with 400; retry once without it. */
export async function fetchWithTemperatureFallback(url: string, init: RequestInit, config?: ProviderConfig): Promise<Response> {
  const response = await fetchWithLlmRetry(url, init, config);
  if (response.status !== 400 || typeof init.body !== "string") return response;
  let body: unknown;
  try { body = JSON.parse(init.body); } catch { return response; }
  if (body === null || typeof body !== "object" || !("temperature" in body)) return response;
  let detail: string;
  try {
    detail = await readResponseText(response.clone());
  } catch (error) {
    // The bounded reader cancels the clone. Cancel the original branch too so
    // the tee releases its buffered data and the underlying stream can stop.
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!/temperature/i.test(detail)) return response;
  void response.body?.cancel().catch(() => undefined);
  console.info("[wupage] LLM rejected temperature; retrying once without it");
  const { temperature: _dropped, ...rest } = body as Record<string, unknown>;
  return fetchWithLlmRetry(url, { ...init, body: JSON.stringify(rest) }, config);
}

async function fetchWithLlmRetry(url: string, init: RequestInit, config?: ProviderConfig): Promise<Response> {
  if (config?.type === "openai-compatible" && usesOllamaCompatibility(config)) {
    return withOllamaCompatibility(url, () => fetchLlmWithRetry(url, init));
  }
  return fetchLlmWithRetry(url, init);
}

async function fetchLlmWithRetry(url: string, init: RequestInit): Promise<Response> {
  const deadline = Date.now() + LLM_TRANSLATION_TIMEOUT_MS;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    init.signal?.throwIfAborted();
    const response = await fetchWithTimeout(url, init, Math.max(1, deadline - Date.now()));
    if (response.status !== 429 && response.status !== 503) return response;
    if (attempt === 3) return response;
    const retryDelay = readRetryDelay(response, attempt);
    // An hours-long Retry-After must pause the session rather than occupy a
    // concurrency slot indefinitely. A retry also shares the original deadline.
    if (retryDelay > 30_000 || Date.now() + retryDelay >= deadline) return response;
    await response.body?.cancel().catch(() => undefined);
    await delay(retryDelay, init.signal);
  }
  throw new Error("LLM request retry loop exited unexpectedly.");
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  // fetch resolves at headers. Keep both signals alive through json()/text(),
  // otherwise a stalled body occupies the provider/global queue forever.
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? anySignal([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new ProviderError(t("requestTimeout", Math.round(timeoutMs / 1000)), "service-unavailable");
    }
    if (!signal.aborted && error instanceof TypeError) {
      throw new ProviderError(t("serviceUnreachable"), "service-unavailable");
    }
    throw error;
  }
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

export function httpResponseError(response: Response, message: string): Error {
  // Most providers do not consume an error body. Release it before pausing.
  if (!response.bodyUsed) void response.body?.cancel().catch(() => undefined);
  const code = response.status === 429 ? "rate-limited"
    : response.status === 401 ? "login-required"
    : response.status === 403 ? "permission-required"
    : response.status >= 500 ? "service-unavailable"
    : response.status >= 400 ? "service-rejected" : undefined;
  return code ? new ProviderError(message, code,
    response.status === 429 ? readRetryDelay(response, 0) : undefined) : new Error(message);
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = globalThis.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function readErrorBody(response: Response): Promise<string> {
  const text = await readResponseText(response).catch(() => "");
  if (!text) return "";
  if (looksLikeHtmlDocument(text)) {
    return t("serverReturnedHtml");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const message = readErrorMessage(parsed);
    return (message ? String(message) : text).slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

export async function readJsonResponse<T>(response: Response, providerLabel: string, onUsage?: (payload: unknown) => void): Promise<T> {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (/\btext\/html\b/i.test(contentType)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderError(
      t("providerReturnedHtml", providerLabel), "protocol-changed"
    );
  }

  try {
    // Empty-body responses still use the browser's ordinary JSON error. Stream
    // nonempty bodies with a byte budget before allocating/parsing their text.
    const payload = response.body ? JSON.parse(await readResponseText(response)) as T : await response.json() as T;
    onUsage?.(payload);
    return payload;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
      const failure = new ProviderError(t("serviceResponseInterrupted"), "service-unavailable");
      failure.name = error.name;
      throw failure;
    }
    throw new ProviderError(
      t("providerInvalidJson", providerLabel), "protocol-changed"
    );
  }
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_TRANSLATION_RESPONSE_BYTES) {
        throw new ProviderError(t("responseTooLarge"), "service-rejected");
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

export function looksLikeHtmlDocument(value: string): boolean {
  const normalized = value.trimStart().replace(/^\uFEFF/, "").trimStart();
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(normalized);
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
