import { ProviderError } from "../shared/errors";
import { fetchWithTimeout, httpResponseError, readJsonResponse } from "./provider-transport";

const ORIGINS = ["https://translate.googleapis.com", "https://translate.google.com"] as const;
const ROUTE_TTL_MS = 60_000;
let preferred: { origin: typeof ORIGINS[number]; expires: number } | undefined;

function connectionFailure(error: unknown): boolean {
  return error instanceof ProviderError && error.errorCode === "service-unavailable";
}

/** Same Google protocol and ownership on both hosts. Only transport failures
 * try another host; HTTP rejection, throttling and protocol errors stop here. */
export async function fetchGoogleWebTranslation(text: string, source: string, target: string, signal?: AbortSignal): Promise<unknown[]> {
  const first = preferred && preferred.expires > Date.now() ? preferred.origin : ORIGINS[0];
  const origins = [first, ...ORIGINS.filter(origin => origin !== first)];
  for (const origin of origins) {
    signal?.throwIfAborted();
    const endpoint = new URL("/translate_a/single", origin);
    for (const [key, value] of Object.entries({ client: "gtx", sl: source, tl: target, dt: "t", q: text })) endpoint.searchParams.set(key, value);
    let response: Response;
    try {
      // Both attempts together retain the previous 20-second request budget.
      response = await fetchWithTimeout(endpoint.toString(), { credentials: "omit", signal }, 10_000);
    } catch (error) {
      signal?.throwIfAborted();
      if (!connectionFailure(error)) throw error;
      continue;
    }
    if (!response.ok) throw httpResponseError(response, `谷歌翻译请求被 ${new URL(origin).hostname} 拒绝（HTTP ${response.status}）。`);
    let payload: unknown;
    try { payload = await readJsonResponse<unknown>(response, "Google Web Translate"); }
    catch (error) {
      signal?.throwIfAborted();
      // A fetch body can report its timeout as AbortError. An explicit caller
      // cancellation was already handled above and must never switch hosts.
      if (!connectionFailure(error) && !(error instanceof Error && error.name === "AbortError")) throw error;
      continue;
    }
    signal?.throwIfAborted();
    if (!Array.isArray(payload) || !Array.isArray(payload[0])
      || !payload[0].some(segment => Array.isArray(segment) && typeof segment[0] === "string" && segment[0].trim())) {
      throw new ProviderError("谷歌翻译未返回有效译文，接口格式可能发生变化。", "protocol-changed");
    }
    // Shared across provider instances, but never persisted across browser runs.
    // The short lifetime allows proxy/network changes to recover automatically.
    preferred = { origin, expires: Date.now() + ROUTE_TTL_MS };
    return payload;
  }
  throw new ProviderError("无法连接谷歌翻译，已尝试 translate.googleapis.com 和 translate.google.com。请检查这两个域名的网络或代理规则；能打开 Google 网页不代表翻译接口可用。", "service-unavailable");
}
