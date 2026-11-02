import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupDictionary, playDictionaryAudio, stopDictionaryAudio } from "../src/background/dictionary";
import { ensureOffscreenDocument } from "../src/background/offscreen";

vi.mock("../src/background/offscreen", () => ({ ensureOffscreenDocument: vi.fn(async () => undefined) }));

const runtimeSend = vi.fn(async (_request: unknown): Promise<unknown> => ({ ok: true, data: null }));
beforeEach(() => { runtimeSend.mockReset().mockResolvedValue({ ok: true, data: null }); vi.stubGlobal("chrome", { runtime: { sendMessage: runtimeSend } }); });
afterEach(async () => { await stopDictionaryAudio("tab1"); await stopDictionaryAudio("tab2"); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("dictionary network transport", () => {
  it("uses the fixed Youdao endpoint without cookies and only coalesces requests that are still pending", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const first = lookupDictionary("youdao", "take off");
    const second = lookupDictionary("youdao", "take off");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).hostname).toBe("dict.youdao.com");
    expect(new URL(url).searchParams.get("q")).toBe("take off");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    finish(Response.json({ input: "take off" }));
    await expect(first).resolves.toMatchObject({ query: "take off", meanings: [] }); await second;
    const third = lookupDictionary("youdao", "take off");
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish(Response.json({ input: "take off" })); await third;
  });
  it("sends Bing HTML to the extension runtime and propagates parser failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<title>example - 搜索 词典</title>")));
    runtimeSend.mockResolvedValue({ ok: false, error: "结构已变化" });
    await expect(lookupDictionary("bing", "example")).rejects.toThrow("结构已变化");
    expect(ensureOffscreenDocument).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ target: "dictionary-runtime", action: "parse-bing", query: "example" }));
  });
  it("requests Chinese pinyin and definitions from Youdao even when Bing is the default", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const first = lookupDictionary("bing", "垚");
    const second = lookupDictionary("youdao", "垚");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(new URL(url).hostname).toBe("dict.youdao.com");
    expect(params.get("q")).toBe("垚");
    expect(params.get("le")).toBe("zh");
    expect(JSON.parse(params.get("dicts")!)).toEqual({ count: 3, dicts: [["newhh", "ce", "simple"]] });
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    finish(Response.json({ input: "垚", newhh: { word: "垚", dataList: [{ pinyin: "yáo", sense: [{ def: ["山势高峻。"] }] }] } }));
    await expect(first).resolves.toMatchObject({ provider: "youdao", pronunciations: [{ accent: "pinyin", phonetic: "yáo" }],
      meanings: [{ definition: "山势高峻。" }] });
    await second;
    expect(runtimeSend).not.toHaveBeenCalled();
  });
  it("rejects bad inputs before networking and reports rate limits, malformed JSON and response size limits", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(() => lookupDictionary("evil" as "bing", "example")).toThrow("请选择");
    expect(() => lookupDictionary("youdao", "a".repeat(101))).toThrow("100");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response("limited", { status: 429 }));
    await expect(lookupDictionary("youdao", "rate")).rejects.toThrow("频繁");
    fetcher.mockResolvedValueOnce(new Response("<html>blocked</html>"));
    await expect(lookupDictionary("youdao", "malformed")).rejects.toThrow("无法识别");
    fetcher.mockResolvedValueOnce(new Response("bad", { headers: { "content-length": "2000001" } }));
    await expect(lookupDictionary("youdao", "large")).rejects.toThrow("过大");
  });
  it("only plays bounded audio data from an allowed endpoint inside the extension runtime", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([73, 68, 51, 4]), { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(playDictionaryAudio("youdao", "https://evil.test/audio.mp3", "tab1")).rejects.toThrow("地址无效");
    expect(fetcher).not.toHaveBeenCalled();
    await playDictionaryAudio("youdao", "https://dict.youdao.com/dictvoice?audio=hello&type=1", "tab1");
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ action: "play", dataUrl: "data:audio/mpeg;base64,SUQzBA==" }));
    const calls = runtimeSend.mock.calls.length;
    await stopDictionaryAudio("tab2"); expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(calls);
    await stopDictionaryAudio("tab1"); expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ action: "stop" }));
  });
  it("discards an audio download that finishes after the card closes", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const task = playDictionaryAudio("youdao", "https://dict.youdao.com/dictvoice?audio=hello&type=1", "tab1");
    await stopDictionaryAudio("tab1");
    finish(new Response(new Uint8Array([73, 68, 51, 4]), { headers: { "content-type": "audio/mpeg" } }));
    await task;
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects an HTML error page returned at an audio URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not audio</html>", { headers: { "content-type": "text/html" } })));
    await expect(playDictionaryAudio("bing", "https://cn.bing.com/dict/mediamp3?blob=audio%2Fa.mp3", "tab1")).rejects.toThrow("有效发音");
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
