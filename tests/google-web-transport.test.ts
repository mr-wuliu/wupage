import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleAuthResponse, googleHtmlReply, GOOGLE_TEST_KEY, GOOGLE_TEST_MODULE } from "./helpers/google-web";

let translate: typeof import("../src/background/google-web-transport").fetchGoogleWebTranslation;
const call = (signal?: AbortSignal) => translate(["Hello", "World"], "en", "zh-CN", undefined, signal);
const html = () => googleHtmlReply("<pre>你好</pre>", "<pre>世界</pre>");
const dict = () => new Response(JSON.stringify(["你好", "世界"]));

beforeEach(async () => {
  vi.resetModules();
  translate = (await import("../src/background/google-web-transport")).fetchGoogleWebTranslation;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((url: string, init: RequestInit) => googleAuthResponse(url) ?? handler(url, init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Google web protocol selection", () => {
  it("discovers a key, prefers HTML batch translation, and omits cookies on every request", async () => {
    const fetch = mockFetch(async () => html());
    await expect(call()).resolves.toEqual(["你好", "世界"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[2];
    expect(url).toBe("https://translate-pa.googleapis.com/v1/translateHtml");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json+protobuf", "X-goog-api-key": GOOGLE_TEST_KEY } });
    expect(JSON.parse(String(init.body))).toEqual([[["<pre>Hello</pre>", "<pre>World</pre>"], "en", "zh-CN"], "te"]);
    for (const [url, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      expect(url).not.toContain(GOOGLE_TEST_KEY);
    }
  });

  it("reads escaped current module URLs without executing downloaded scripts", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/element.js")) return new Response("_loadJs('https:\\/\\/translate.googleapis.com\\/_\\/translate_http\\/_\\/js\\/k\\x3dfixture\\/m\\u003del_main'); globalThis.unsafeGoogleScript = true;");
      return googleAuthResponse(url) ?? html();
    });
    vi.stubGlobal("fetch", fetch);
    await call();
    expect(fetch.mock.calls[1][0]).toBe(GOOGLE_TEST_MODULE);
    expect((globalThis as { unsafeGoogleScript?: boolean }).unsafeGoogleScript).toBeUndefined();
  });

  it("shares key discovery across concurrent batches and caches it for twenty minutes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetch = mockFetch(async () => html());
    await Promise.all([call(), call()]);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/element.js"))).toHaveLength(1);
    await call();
    expect(fetch).toHaveBeenCalledTimes(5);
    clock.mockReturnValue(100_000 + 20 * 60_000 + 1);
    await call();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/element.js"))).toHaveLength(2);
  });

  it.each([401, 403, 429, 503])("uses dictionary translation after primary HTTP %s, then retries HTML after recovery time", async status => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    let failed = true;
    const fetch = mockFetch(async url => url.includes("/translateHtml")
      ? failed ? new Response("Rejected", { status }) : html() : dict());
    await expect(call()).resolves.toEqual(["你好", "世界"]);
    await call();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/translateHtml"))).toHaveLength(1);
    const dictionary = fetch.mock.calls.filter(([url]) => url.includes("clients5.google.com"));
    expect(dictionary).toHaveLength(2);
    expect(Object.fromEntries(new URL(dictionary[0][0]).searchParams)).toMatchObject({ client: "dict-chrome-ex", sl: "en", tl: "zh-CN" });
    expect(new URL(dictionary[0][0]).searchParams.getAll("q")).toEqual(["Hello", "World"]);
    expect(dictionary[0][1].method).toBeUndefined();
    failed = false; clock.mockReturnValue(161_000);
    await call();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/translateHtml"))).toHaveLength(2);
  });

  it("honors Retry-After before probing the primary again", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetch = mockFetch(async url => url.includes("/translateHtml")
      ? new Response("Limited", { status: 429, headers: { "Retry-After": "120" } }) : dict());
    await call(); clock.mockReturnValue(161_000); await call();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/translateHtml"))).toHaveLength(1);
    clock.mockReturnValue(221_000); await call();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/translateHtml"))).toHaveLength(2);
  });

  it.each(["connection", "body", "timeout", "json", "shape"])("falls back after primary %s failure", async kind => {
    const fetch = mockFetch(async url => {
      if (url.includes("clients5.google.com")) return dict();
      if (kind === "connection") throw new TypeError("Failed to fetch");
      if (kind === "body" || kind === "timeout") return new Response(new ReadableStream({ start(controller) {
        controller.error(kind === "body" ? new TypeError("Connection reset") : new DOMException("Timeout", "AbortError"));
      } }));
      return new Response(kind === "json" ? "broken" : "{}");
    });
    await expect(call()).resolves.toEqual(["你好", "世界"]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects an untrusted module URL and sends text only to the Google fallback", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("/element.js")
      ? new Response("_loadJs('https://example.test/steal.js')") : dict());
    vi.stubGlobal("fetch", fetch);
    await call();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => new URL(url).hostname.endsWith(".google.com") || new URL(url).hostname === "translate.googleapis.com")).toBe(true);
  });

  it("does not retry invalid inputs via another protocol", async () => {
    const fetch = mockFetch(async () => new Response("Bad input", { status: 400 }));
    await expect(call()).rejects.toMatchObject({ errorCode: "request-rejected" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves the longest rate-limit delay when both protocols fail, without paragraph retries", async () => {
    const fetch = mockFetch(async url => new Response("Limited", { status: 429,
      headers: { "Retry-After": url.includes("/translateHtml") ? "3600" : "120" } }));
    await expect(call()).rejects.toMatchObject({ errorCode: "rate-limited", retryAfterMs: 3_600_000 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([[], ["one"], ["one", ""], ["one", null], {}, [[["old single response"]]]])("rejects malformed fallback: %j", async payload => {
    mockFetch(async url => url.includes("/translateHtml") ? new Response("Limited", { status: 503 }) : new Response(JSON.stringify(payload)));
    await expect(call()).rejects.toMatchObject({ errorCode: "protocol-changed" });
  });

  it("accepts detected-language tuples and preserves literal entities, whitespace and line breaks", async () => {
    const seen: string[] = [];
    mockFetch(async url => {
      if (url.includes("/translateHtml")) return new Response("Unavailable", { status: 503 });
      const parts = new URL(url).searchParams.getAll("q"); seen.push(...parts);
      return new Response(JSON.stringify(parts.map(part => [`译${part}`, "en"])));
    });
    await expect(translate([" Hello \r\n\n &lt;tag&gt; ", "World"], "auto", "zh-TW"))
      .resolves.toEqual([" 译Hello \r\n\n 译&lt;tag&gt; ", "译World"]);
    expect(seen).toEqual(["Hello", "&lt;tag&gt;", "World"]);
  });

  it("bounds fallback URLs and reconstructs oversized CJK/emoji input in order", async () => {
    const source = "译🐈".repeat(1500);
    const urls: string[] = [];
    mockFetch(async url => {
      if (url.includes("/translateHtml")) return new Response("Unavailable", { status: 503 });
      urls.push(url);
      return new Response(JSON.stringify(new URL(url).searchParams.getAll("q")));
    });
    await expect(translate([source], "zh-CN", "en")).resolves.toEqual([source]);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every(url => url.length <= 7500)).toBe(true);
  });

  it("cancels one key waiter immediately without disrupting another batch", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (url: string) => url.includes("/element.js")
      ? new Promise<Response>(resolve => { finish = resolve; }) : googleAuthResponse(url) ?? html());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const cancelled = call(controller.signal), survivor = call();
    const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    finish(googleAuthResponse("/translate_a/element.js?")!);
    await expect(survivor).resolves.toEqual(["你好", "世界"]);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/translateHtml"))).toHaveLength(1);
  });

  it("never starts fallback after caller cancellation during response-body reading", async () => {
    const controller = new AbortController();
    const fetch = mockFetch(async () => new Response(new ReadableStream({ pull(stream) {
      controller.abort(); stream.error(controller.signal.reason);
    } })));
    await expect(call(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("keeps one overall deadline through headers and response bodies (fallback=%s)", async fallback => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 20_000 ? 30 : 1000));
    let requestSignal: AbortSignal | null | undefined;
    const fetch = mockFetch(async (url, init) => {
      if (fallback && url.includes("/translateHtml")) return new Response("Unavailable", { status: 503 });
      requestSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        requestSignal!.addEventListener("abort", () => controller.error(requestSignal!.reason), { once: true });
      } }));
    });
    await expect(call()).rejects.toMatchObject({ errorCode: "service-unavailable" });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(fallback ? 4 : 3);
  });

  it("does not start requests for cancelled or empty batches", async () => {
    const fetch = mockFetch(async () => html());
    const controller = new AbortController(); controller.abort();
    await expect(call(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(translate([], "en", "zh-CN")).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
