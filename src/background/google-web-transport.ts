import { t } from "../shared/i18n";
import { anySignal } from "../shared/abort";
import { ProviderError } from "../shared/errors";
import { fetchWithTimeout, httpResponseError, readJsonResponse, readResponseText } from "./provider-transport";
import { googleHtmlSource, parseGoogleHtml } from "./google-context";
import { splitTranslationText } from "./text-segmentation";

const HTML_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const DICTIONARY_ENDPOINT = "https://clients5.google.com/translate_a/t";
const ELEMENT_SCRIPT = "https://translate.googleapis.com/translate_a/element.js?cb=googleTranslateElementInit";
const KEY_TTL_MS = 20 * 60_000;
const ROUTE_TTL_MS = 60_000;
let key: { value: string; expires: number } | undefined;
let pendingKey: Promise<string> | undefined;
let dictionaryUntil = 0;

const protocolError = () => new ProviderError(t("googleTranslateReturnedNoValidTranslationItsResponse"), "protocol-changed");

function active(signal?: AbortSignal): void { signal?.throwIfAborted(); }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function checkedFetch(url: string, init: RequestInit, timeout = 6_000): Promise<Response> {
  const response = await fetchWithTimeout(url, { ...init, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }, timeout);
  if (!response.ok) throw httpResponseError(response, t("rejectedTheGoogleTranslateRequestHttp", new URL(url).hostname, response.status));
  return response;
}

async function loadKey(): Promise<string> {
  // Read Google's loader and its current module as data. No downloaded script
  // is executed or persisted, and no third-party/public fallback key is bundled.
  const loader = await readResponseText(await checkedFetch(ELEMENT_SCRIPT, {}, 4_000));
  const raw = /\b_loadJs\(\s*(['"])(.*?)\1\s*\)/s.exec(loader)?.[2];
  if (!raw) throw protocolError();
  const decoded = raw.replace(/\\x([\da-f]{2})|\\u([\da-f]{4})|\\([/\\'"])/gi,
    (_match, hex: string | undefined, unicode: string | undefined, literal: string | undefined) =>
      literal ?? String.fromCharCode(Number.parseInt(hex ?? unicode!, 16)));
  let url: URL;
  try { url = new URL(decoded); } catch { throw protocolError(); }
  if (url.origin !== "https://translate.googleapis.com" || !url.pathname.startsWith("/_/translate_http/_/js/")
    || url.username || url.password || url.hash) throw protocolError();
  const script = await readResponseText(await checkedFetch(url.href, {}, 4_000));
  const value = /['"]x-goog-api-key['"]\s*:\s*['"]([\w-]{39})['"]/i.exec(script)?.[1];
  if (!value) throw new ProviderError(t("googleWebKeyUnavailable"), "protocol-changed");
  key = { value, expires: Date.now() + KEY_TTL_MS };
  return value;
}

async function getKey(signal: AbortSignal): Promise<string> {
  active(signal);
  if (key && key.expires > Date.now()) return key.value;
  // Concurrent batches share public-script discovery. Cancelling one caller
  // stops that caller immediately without aborting discovery for other callers.
  pendingKey ??= loadKey().finally(() => { pendingKey = undefined; });
  return abortable(pendingKey, signal);
}

async function translateHtml(texts: string[], source: string, target: string, context: string | undefined, signal: AbortSignal): Promise<string[]> {
  const auth = await getKey(signal);
  active(signal);
  let response: Response;
  try {
    response = await checkedFetch(HTML_ENDPOINT, { method: "POST", signal,
      headers: { "Content-Type": "application/json+protobuf", "X-goog-api-key": auth },
      body: JSON.stringify([[googleHtmlSource(texts, context), source, target], "te"]) });
  } catch (error) {
    if (error instanceof ProviderError && ["login-required", "permission-required"].includes(error.errorCode)
      && key?.value === auth) key = undefined;
    throw error;
  }
  const payload = await readJsonResponse<unknown>(response, "Google Web Translate");
  active(signal);
  const output = parseGoogleHtml(payload, texts.length, !!context?.trim());
  if (!output) throw protocolError();
  return output;
}

async function translateDictionary(texts: string[], source: string, target: string, signal: AbortSignal): Promise<string[]> {
  // This endpoint swallows newlines. Keep line boundaries/edge whitespace local,
  // and bound encoded GET URLs, including CJK text and surrogate pairs.
  const pieces = texts.map(text => text.split(/(\r\n|\r|\n)/).flatMap(line => splitTranslationText(line, 600) ?? [line]));
  const jobs = pieces.flatMap((parts, index) => parts.flatMap((text, part) => text.trim() ? [{ text: text.trim(), index, part }] : []));
  for (let start = 0; start < jobs.length;) {
    active(signal);
    const url = new URL(DICTIONARY_ENDPOINT);
    for (const [name, value] of Object.entries({ client: "dict-chrome-ex", sl: source, tl: target })) url.searchParams.set(name, value);
    let end = start;
    while (end < jobs.length && end - start < 32) {
      const candidate = new URL(url);
      candidate.searchParams.append("q", jobs[end].text);
      if (candidate.href.length > 7_500) break;
      url.searchParams.append("q", jobs[end++].text);
    }
    if (end === start) throw new ProviderError(t("googleWebInputTooLong"), "input-too-long");
    const payload = await readJsonResponse<unknown>(await checkedFetch(url.href, { signal }), "Google Web Translate");
    active(signal);
    if (!Array.isArray(payload) || payload.length !== end - start) throw protocolError();
    const translations = payload.map(value => typeof value === "string" ? value
      : Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" ? value[0] : undefined);
    if (!translations.every((value): value is string => typeof value === "string" && !!value.trim())) throw protocolError();
    translations.forEach((translation, offset) => {
      const { index, part } = jobs[start + offset];
      const original = pieces[index][part];
      pieces[index][part] = original.match(/^\s*/u)![0] + translation.trim() + original.match(/\s*$/u)![0];
    });
    start = end;
  }
  return pieces.map(parts => parts.join(""));
}

/** Primary HTML batch protocol, then one bounded dictionary-protocol fallback.
 * An endpoint rejection can be specific to a client/protocol, including 429.
 * Successful fallback is remembered briefly; there is no same-endpoint retry.
 */
export async function fetchGoogleWebTranslation(texts: string[], source: string, target: string, context?: string, signal?: AbortSignal): Promise<string[]> {
  active(signal);
  if (!texts.length) return [];
  const deadline = anySignal([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  try {
    if (dictionaryUntil > Date.now()) return await translateDictionary(texts, source, target, deadline);
    try { return await translateHtml(texts, source, target, context, deadline); }
    catch (primary) {
      active(deadline);
      const recoverable = primary instanceof ProviderError
        && ["service-unavailable", "protocol-changed", "login-required", "permission-required", "rate-limited"].includes(primary.errorCode)
        || primary instanceof TypeError || primary instanceof Error && ["AbortError", "TimeoutError"].includes(primary.name);
      if (!recoverable) throw primary;
      try {
        const result = await translateDictionary(texts, source, target, deadline);
        dictionaryUntil = Date.now() + Math.max(ROUTE_TTL_MS, primary instanceof ProviderError ? primary.retryAfterMs ?? 0 : 0);
        return result;
      } catch (secondary) {
        active(deadline);
        // Preserve throttling/Retry-After so the outer page queue can pause.
        if (primary instanceof ProviderError && primary.errorCode === "rate-limited"
          && (!(secondary instanceof ProviderError) || secondary.errorCode !== "rate-limited"
            || (primary.retryAfterMs ?? 0) > (secondary.retryAfterMs ?? 0))) throw primary;
        throw secondary;
      }
    }
  } catch (error) {
    active(signal);
    if (deadline.aborted) throw new ProviderError(t("requestTimeout", 20), "service-unavailable");
    throw error;
  }
}
