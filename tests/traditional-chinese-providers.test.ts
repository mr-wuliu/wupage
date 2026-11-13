import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";
import { googleHtmlReply, withGoogleAuth } from "./helpers/google-web";

afterEach(() => vi.unstubAllGlobals());

describe.each(["free", "api"] as const)("Traditional Chinese in %s mode", serviceMode => {
  const credentials = { apiKey: "example-key", accessKeyId: "example-ak", secretAccessKey: "example-sk" };
  const languagePairs = [
    { sourceLang: "zh-CN", targetLang: "zh-TW", from: "zh-Hans", to: "zh-Hant" },
    { sourceLang: "zh-TW", targetLang: "zh-CN", from: "zh-Hant", to: "zh-Hans" }
  ];

  it.each(languagePairs)("maps Microsoft $sourceLang → $targetLang to script codes", async pair => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify([{ translations: [{ text: "譯文" }] }])));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "microsoft-web-translate", id: "ms", label: "Microsoft", serviceMode, api: credentials });
    await expect(provider.translateBatch({ texts: ["原文"], ...pair })).resolves.toEqual(["譯文"]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("from")).toBe(pair.from);
    expect(url.searchParams.get("to")).toBe(pair.to);
  });

  it.each(languagePairs)("keeps Google's regional codes for $sourceLang → $targetLang", async pair => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => serviceMode === "free" ? googleHtmlReply("<pre>譯文</pre>")
      : new Response(JSON.stringify({ data: { translations: [{ translatedText: "譯文" }] } })));
    vi.stubGlobal("fetch", withGoogleAuth(fetchMock));
    const provider = createProvider({ type: "google-web-translate", id: "google", label: "Google", serviceMode, api: credentials });
    await expect(provider.translateBatch({ texts: ["原文"], ...pair })).resolves.toEqual(["譯文"]);
    const [url, init] = fetchMock.mock.calls[0];
    if (serviceMode === "free") {
      expect(new URL(url).hostname).toBe("translate-pa.googleapis.com");
      expect(JSON.parse(String(init?.body))[0].slice(1)).toEqual([pair.sourceLang, pair.targetLang]);
    } else {
      expect(JSON.parse(String(init?.body))).toMatchObject({ source: pair.sourceLang, target: pair.targetLang });
    }
  });

  it.each(languagePairs)("maps Volcengine $sourceLang → $targetLang without merging scripts", async pair => {
    const payload = serviceMode === "free" ? { base_resp: { status_code: 0 }, translation: "譯文" }
      : { TranslationList: [{ Translation: "譯文" }] };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "volcengine-web-translate", id: "volc", label: "Volcengine", serviceMode, api: credentials });
    await expect(provider.translateBatch({ texts: ["原文"], ...pair })).resolves.toEqual(["譯文"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const source = pair.from === "zh-Hans" ? "zh" : pair.from;
    const target = pair.to === "zh-Hans" ? "zh" : pair.to;
    expect(body).toMatchObject(serviceMode === "free"
      ? { source_language: source, target_language: target }
      : { SourceLanguage: source, TargetLanguage: target });
  });
});
