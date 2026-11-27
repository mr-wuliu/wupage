import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoubaoWebConfig, TranslateBatchRequest } from "../src/shared/types";

const config: DoubaoWebConfig = { type: "doubao-web", id: "doubao", label: "豆包" };
const request: TranslateBatchRequest = { texts: ["Hello", "World"], sourceLang: "en", targetLang: "zh-CN" };
let doubao: typeof import("../src/background/doubao");
let fetchMock: ReturnType<typeof vi.fn>;
let rules: chrome.declarativeNetRequest.Rule[];
let stored: Record<string, unknown>;

function launch(config: Record<string, unknown> = { ttwid: true, web_id: "server-device" }): Response {
  return Response.json({ code: 0, data: { config, country: "CN" } });
}

function sse(items: Array<{ index: number; res: string; detect_lang?: string }>): Response {
  return new Response(streamText(items), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" }
  });
}

function translation(values: string[] = ["你好"]): Response {
  return sse(values.map((res, index) => ({ index, res, detect_lang: "en" })));
}

async function outcome(texts = request.texts): Promise<unknown> {
  const result = new doubao.DoubaoProvider(config).translateBatch({ ...request, texts }).catch((error) => error);
  await vi.runAllTimersAsync();
  return result;
}

function streamText(items: Array<{ index: number; res: string; detect_lang?: string }> = [{ index: 0, res: "你好" }]): string {
  return "event: json\ndata: " + JSON.stringify({ code: 0, data: { items } }) + "\n\nevent: done\n\n";
}

function translate(text = "Hello", signal?: AbortSignal): Promise<unknown> {
  return new doubao.DoubaoProvider(config).translateBatch({ texts: [text], targetLang: "zh-CN" }, signal)
    .catch((error: unknown) => error);
}

/** A slow response that stays alive until the body finishes or is cancelled. */
function delayedStream(duration: number, onFinish: () => void): Response {
  let finish: ReturnType<typeof setTimeout>;
  let heartbeat: ReturnType<typeof setInterval>;
  let closed = false;
  const cleanup = () => {
    clearTimeout(finish);
    clearInterval(heartbeat);
    if (!closed) { closed = true; onFinish(); }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(": ping\n\n")), 10_000);
      finish = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(streamText()));
        controller.close();
        cleanup();
      }, duration);
    },
    cancel: cleanup
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  rules = [];
  stored = {};
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://wupage-test${path}` },
    storage: { local: {
      get: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((item) => item in stored).map((item) => [item, stored[item]]));
    }),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); })
    } },
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => [...rules]),
      updateSessionRules: vi.fn(async (options: Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0]) => {
        rules = rules.filter((rule) => !options.removeRuleIds?.includes(rule.id));
        rules.push(...(options.addRules ?? []));
      })
    }
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  doubao = await import("../src/background/doubao");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Doubao web provider", () => {
  it("reports a withheld Doubao site before making a credentialed request", async () => {
    const contains = vi.fn(async () => false);
    Object.assign(chrome, { permissions: { contains } });

    expect(await outcome()).toMatchObject({
      errorCode: "permission-required", message: expect.stringContaining("https://www.doubao.com")
    });
    expect(contains).toHaveBeenCalledWith({ origins: ["https://www.doubao.com:443/*"] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rules).toEqual([]);
  });

  it("uses browser credentials with fixed endpoints and a native ordered article array", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(sse([
      { index: 1, res: "世界" }, { index: 0, res: "你好" }
    ]));
    expect(await outcome()).toEqual(["你好", "世界"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [launchUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [articleUrl, article] = fetchMock.mock.calls[1] as [string, RequestInit];
    const launchAddress = new URL(launchUrl);
    const articleAddress = new URL(articleUrl);
    expect(launchAddress.origin + launchAddress.pathname).toBe("https://www.doubao.com/alice/user/launch");
    expect(articleAddress.origin + articleAddress.pathname).toBe("https://www.doubao.com/samantha/plugin/stream_article_translate");
    expect(init).toMatchObject({ method: "POST", credentials: "include", redirect: "error" });
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ "Agw-Js-Conv": "str", "Content-Type": "application/json" });
    expect(article).toMatchObject({ method: "POST", credentials: "include", redirect: "error" });
    expect(JSON.parse(String(article.body))).toEqual({ raw_text: ["Hello", "World"], target_lang: "zh", translate_service: "1" });
    expect(new Headers(article.headers).has("Cookie")).toBe(false);
    expect(launchAddress.searchParams.get("device_id")).toBe("0");
    expect(articleAddress.searchParams.get("device_id")).toBe("server-device");
    expect(articleAddress.searchParams.get("region")).toBe("CN");
    expect(articleAddress.searchParams.get("sys_region")).toBe("CN");
    expect(articleAddress.searchParams.get("tea_uuid")).toMatch(/^\d{18}$/);
    expect(articleAddress.searchParams.get("web_id")).toBe(articleAddress.searchParams.get("tea_uuid"));
    expect(launchAddress.searchParams.get("web_tab_id")).toBe(articleAddress.searchParams.get("web_tab_id"));
    expect(Object.keys(stored)).toEqual(["wupage.doubao.device"]);
    expect(stored["wupage.doubao.device"]).toBe(articleAddress.searchParams.get("web_id"));
    expect(rules).toEqual([]);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "ready", checkedAt: Date.now() });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses device_id zero for anonymous launch and still validates a real translation", async () => {
    stored["wupage.doubao.device"] = "123456789123456789";
    fetchMock.mockResolvedValueOnce(launch({ ttwid: false, web_id: "not-a-login" }))
      .mockResolvedValueOnce(translation(["你好", "世界"]));
    expect(await outcome()).toEqual(["你好", "世界"]);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("device_id")).toBe("0");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("repairs only missing slots once, preserving duplicate inputs and original ordering", async () => {
    fetchMock.mockResolvedValueOnce(launch())
      .mockResolvedValueOnce(sse([{ index: 2, res: "丙" }, { index: 0, res: "甲" }]))
      .mockResolvedValueOnce(translation(["乙"]));
    expect(await outcome(["same", "same", "other"])).toEqual(["甲", "乙", "丙"]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).raw_text).toEqual(["same"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["network", "503"])("recovers a transient article failure once and restores ready status: %s", async (failure) => {
    fetchMock.mockResolvedValueOnce(launch());
    if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("network offline"));
    else fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchMock.mockResolvedValueOnce(translation(["你好", "世界"]));
    expect(await outcome()).toEqual(["你好", "世界"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "ready", checkedAt: Date.now() });
  });

  it.each(["missing-then-5xx", "5xx-then-missing"])("shares one additional attempt between repair and retry: %s", async (order) => {
    fetchMock.mockResolvedValueOnce(launch());
    if (order === "missing-then-5xx") {
      fetchMock.mockResolvedValueOnce(sse([{ index: 0, res: "你好" }])).mockResolvedValueOnce(new Response(null, { status: 503 }));
    } else {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(sse([{ index: 0, res: "你好" }]));
    }
    expect(await outcome()).toMatchObject({ errorCode: order === "missing-then-5xx" ? "network-error" : "incomplete" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not replenish retry budget for a later physical group", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(translation(["第一段"]))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    expect(await outcome(["a".repeat(2000), "b".repeat(2000)])).toMatchObject({ errorCode: "network-error" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry HTTP 408", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 408 }));
    expect(await outcome()).toMatchObject({ errorCode: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rules).toEqual([]);
  });

  it.each([
    { code: 710012000, message: "private account information" },
    { code: 0, data: null },
    { code: "0", data: { config: {} } }
  ])("propagates initialization failure without sending article text: %j", async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    const result = await outcome();
    expect(result).toMatchObject({ errorCode: payload.code === 710012000 ? "login-required" : "protocol-changed" });
    expect(String(result)).not.toContain("private account information");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects HTML login pages without exposing the response content", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response("<html>private account information</html>", {
      headers: { "Content-Type": "text/html" }
    }));
    const result = await outcome();
    expect(result).toMatchObject({ errorCode: "protocol-changed" });
    expect(String(result)).not.toContain("private account information");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a JSON business error without treating it as malformed SSE or retrying", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(Response.json({ code: 710022002 }));
    expect(await outcome()).toMatchObject({ errorCode: "service-rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("splits long paragraphs and rejoins their exact source boundaries", async () => {
    let translated = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (!init.body) return launch();
      const { raw_text } = JSON.parse(String(init.body)) as { raw_text: string[] };
      expect(raw_text.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(2000);
      expect(raw_text.length).toBeLessThanOrEqual(10);
      return translation(raw_text.map(() => `节${++translated}`));
    });
    expect(await outcome(["a".repeat(4001), " \n", "Hello"])).toEqual(["节1节2节3", " \n", "节4"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps empty and punctuation-only paragraphs local", async () => {
    expect(await outcome(["", " \n", "…", "⟪WUPAGE0⟫"])).toEqual(["", " \n", "…", "⟪WUPAGE0⟫"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("rejects unsupported targets before storage or network access", async () => {
    const result = new doubao.DoubaoProvider(config).translateBatch({ ...request, targetLang: "xx" }).catch((error) => error);
    expect(await result).toMatchObject({ errorCode: "unsupported-language" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("keeps the Chromium experiment unavailable in Firefox", async () => {
    chrome.runtime.getURL = () => "moz-extension://test-uuid/";
    const provider = new doubao.DoubaoProvider(config);
    expect(provider.validateConfig().ok).toBe(false);
    expect(await provider.translateBatch(request).catch((error) => error)).toMatchObject({ errorCode: "unsupported-browser" });
    expect(await doubao.checkDoubao()).toMatchObject({ state: "unsupported-browser" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["invalid-utf8", "oversized-body"])("stops bounded response consumption for %s", async (kind) => {
    const data = kind === "invalid-utf8" ? Uint8Array.of(0xC3, 0x28) : new Uint8Array(1_000_001);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); }, cancel });
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    expect(await outcome()).toMatchObject({ errorCode: "protocol-changed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rules).toEqual([]);
  });

  it("decodes UTF-8 code points split between response chunks", async () => {
    const text = "event: json\ndata: " + JSON.stringify({ code: 0, data: { items: [{ index: 0, res: "你好🌏" }] } }) + "\n\n";
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    expect(await outcome(["Hello"])).toEqual(["你好🌏"]);
  });
});

describe("Doubao shared queue and recovery", () => {
  it("shares initialization and one full-body network slot across provider instances and probes", async () => {
    const starts: number[] = [];
    let active = 0;
    let maximum = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      starts.push(Date.now());
      if (!init.body) return launch();
      active++;
      maximum = Math.max(maximum, active);
      expect(rules).toHaveLength(1);
      return delayedStream(1500, () => { active--; });
    });
    const first = translate();
    const second = translate();
    const probe = doubao.checkDoubao();
    await vi.runAllTimersAsync();
    expect(await first).toEqual(["你好"]);
    expect(await second).toEqual(["你好"]);
    expect(await probe).toMatchObject({ state: "ready" });
    expect(fetchMock.mock.calls.filter(([_url, init]) => !init.body)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maximum).toBe(1);
    for (let index = 1; index < starts.length; index++) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(1000);
    expect(active).toBe(0);
    expect(rules).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[401, "login-required"], [403, "service-rejected"]])
  ("rejects queued ordinary jobs after HTTP %i and permits a deduplicated recovery check", async (httpStatus, errorCode) => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: httpStatus as number }));
    const first = translate();
    const waiting = translate();
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ errorCode });
    expect(await waiting).toMatchObject({ errorCode });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(launch());
    fetchMock.mockResolvedValueOnce(translation());
    const probe = doubao.checkDoubao();
    expect(doubao.checkDoubao()).toBe(probe);
    expect(doubao.getDoubaoStatus().state).toBe("checking");
    await vi.runAllTimersAsync();
    expect(await probe).toMatchObject({ state: "ready", checkedAt: Date.now() });
    expect(fetchMock.mock.calls.filter(([_url, init]) => !init.body)).toHaveLength(2);
    const afterCheck = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(afterCheck);
    fetchMock.mockResolvedValueOnce(translation());
    const manual = translate();
    await vi.runAllTimersAsync();
    expect(await manual).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(afterCheck + 1);
  });

  it("honors Retry-After, rejects waiting jobs, and only runs new manual work after cooldown", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, {
      status: 429, headers: { "Retry-After": "120" }
    }));
    const first = translate();
    const waiting = translate();
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ errorCode: "rate-limited", retryAfterMs: 120_000 });
    expect(await waiting).toMatchObject({ errorCode: "rate-limited" });
    expect(doubao.getDoubaoStatus().retryAt).toBe(Date.now() + 120_000);
    expect(await doubao.checkDoubao()).toMatchObject({ state: "rate-limited", checkedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(await translate()).toMatchObject({ errorCode: "rate-limited", retryAfterMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(translation());
    const manual = translate();
    await vi.runAllTimersAsync();
    expect(await manual).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "ready" });
    expect(doubao.getDoubaoStatus().retryAt).toBeUndefined();
  });

  it.each(["invalid", "5", "-1"])("uses at least the default cooldown for Retry-After %s", async (value) => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": value } }));
    const pending = translate();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ errorCode: "rate-limited", retryAfterMs: 60_000 });
    expect(doubao.getDoubaoStatus().retryAt).toBe(Date.now() + 60_000);
  });

  it("accepts a future Retry-After HTTP date", async () => {
    const until = Date.now() + 180_000;
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, {
      status: 429, headers: { "Retry-After": new Date(until).toUTCString() }
    }));
    const pending = translate();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ errorCode: "rate-limited", retryAfterMs: until - Date.now() });
    expect(doubao.getDoubaoStatus().retryAt).toBe(until);
  });

  it("does not cancel shared launch while another caller still needs it", async () => {
    let completeLaunch!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { completeLaunch = resolve; }))
      .mockResolvedValueOnce(translation());
    const controller = new AbortController();
    const first = translate("Hello", controller.signal);
    const second = translate();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await first).toMatchObject({ errorCode: "cancelled" });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    completeLaunch(launch());
    await vi.runAllTimersAsync();
    expect(await second).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes a cancelled queued job before it can send source text", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => !init.body ? launch() : delayedStream(5000, () => undefined));
    const first = translate();
    await vi.advanceTimersByTimeAsync(1000);
    const controller = new AbortController();
    const waiting = translate("Hello", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(await waiting).toMatchObject({ errorCode: "cancelled" });
    await vi.runAllTimersAsync();
    expect(await first).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rules).toEqual([]);
  });

  it("records a new checkedAt on failed checks and does not mistake launch for ready", async () => {
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(translation());
    const first = doubao.checkDoubao();
    await vi.advanceTimersByTimeAsync(0);
    expect(doubao.getDoubaoStatus().state).toBe("checking");
    await vi.runAllTimersAsync();
    const ready = await first;
    expect(ready.state).toBe("ready");
    await vi.advanceTimersByTimeAsync(30_000);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const second = doubao.checkDoubao();
    await vi.runAllTimersAsync();
    expect(await second).toMatchObject({ state: "service-rejected", checkedAt: Date.now() });
    expect((await second).checkedAt).toBeGreaterThan(ready.checkedAt!);
  });
});

describe("Doubao physical and logical deadlines", () => {
  it.each(["headers", "idle", "total"])("cancels a %s timeout and releases the full-body queue slot and DNR rule", async (stage) => {
    const began = Date.now();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(launch());
    if (stage === "headers") fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    else if (stage === "idle") fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "text/event-stream" }
    }));
    else fetchMock.mockImplementationOnce(async () => delayedStream(90_000, cancel));
    const pending = translate();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ errorCode: "timeout" });
    expect(Date.now() - began).toBe(stage === "headers" ? 26_000 : stage === "idle" ? 21_000 : 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    if (stage !== "headers") expect(cancel).toHaveBeenCalledTimes(1);
    expect(rules).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockResolvedValueOnce(translation());
    const later = translate();
    await vi.runAllTimersAsync();
    expect(await later).toEqual(["你好"]);
  });

  it("counts queue waits and prior groups in 110 seconds and never sends the expired remainder", async () => {
    const began = Date.now();
    let finished = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => !init.body ? launch()
      : delayedStream(55_000, () => { finished++; }));
    const first = new doubao.DoubaoProvider(config).translateBatch({ ...request, texts: ["a".repeat(2000), "b".repeat(2000)] })
      .catch((error) => error);
    const second = translate();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(await first).toMatchObject({ errorCode: "timeout" });
    expect(await second).toMatchObject({ errorCode: "timeout" });
    expect(Date.now() - began).toBe(110_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(finished).toBe(2);
    expect(rules).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the shared initializer after its last caller leaves and can initialize again", async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const first = translate("Hello", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await first).toMatchObject({ errorCode: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(rules).toEqual([]);
    fetchMock.mockResolvedValueOnce(launch()).mockResolvedValueOnce(translation());
    const second = translate();
    await vi.runAllTimersAsync();
    expect(await second).toEqual(["你好"]);
    expect(fetchMock.mock.calls.filter(([_url, init]) => !init.body)).toHaveLength(2);
  });
});

describe("Doubao startup and fresh user requests", () => {
  it.each([[401, "login-required"], [403, "service-rejected"]] as const)
  ("recovers a new ordinary request after HTTP %i while keeping old queued work failed", async (httpStatus, errorCode) => {
    let resumeOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { resumeOld = resolve; });
    // The signal is created before failure, just as it is when waiting in the
    // shared translation scheduler before reaching the Doubao provider.
    const old = doubao.withDoubaoDeadline(async (signal) => {
      await oldGate;
      return translate("Old queued paragraph", signal);
    }).catch((error: unknown) => error);

    fetchMock.mockResolvedValueOnce(launch({ ttwid: true, web_id: "stale-device" }))
      .mockResolvedValueOnce(new Response(null, { status: httpStatus }));
    const first = translate("Failed paragraph");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ errorCode });
    // The failed task does not silently retry an authorization/rejection error.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(launch({ ttwid: true, web_id: "refreshed-device" }))
      .mockResolvedValueOnce(translation(["新的第一段"]))
      .mockResolvedValueOnce(translation(["新的第二段"]));
    const freshA = translate("Fresh paragraph A");
    const freshB = translate("Fresh paragraph B");
    await vi.advanceTimersByTimeAsync(5000);
    const freshResults = await Promise.all([freshA, freshB]);
    const recoveredStatus = doubao.getDoubaoStatus();
    const callsBeforeOld = fetchMock.mock.calls.length;

    resumeOld();
    await vi.advanceTimersByTimeAsync(0);
    const oldResult = await old;

    expect(freshResults).toEqual([["新的第一段"], ["新的第二段"]]);
    expect(recoveredStatus.state).toBe("ready");
    expect(fetchMock.mock.calls.filter(([_url, init]) => !init.body)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.slice(3).map(([url]) => new URL(url).searchParams.get("device_id")))
      .toEqual(["refreshed-device", "refreshed-device"]);
    expect(oldResult).toMatchObject({ errorCode });
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeOld);
    expect(doubao.getDoubaoStatus()).toEqual(recoveredStatus);
    expect(rules).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a transient launch failure once using the original text and normal request spacing", async () => {
    const starts: number[] = [];
    fetchMock.mockImplementationOnce(async () => {
      starts.push(Date.now());
      throw new TypeError("connection interrupted");
    }).mockImplementationOnce(async () => { starts.push(Date.now()); return launch(); })
      .mockImplementationOnce(async () => { starts.push(Date.now()); return translation(); });
    const result = translate("Original page text");
    await vi.runAllTimersAsync();

    expect(await result).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([_url, init]) => !init.body)).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).raw_text).toEqual(["Original page text"]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "ready" });
    expect(rules).toEqual([]);
  });

  it("shares the launch retry budget with article retries instead of multiplying attempts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(launch())
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const result = translate();
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ errorCode: "network-error" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([_url, init]) => init.body)).toHaveLength(1);
    expect(rules).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a stalled launch retry on timeout without a third attempt or delayed article", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection interrupted"))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const result = translate();
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ errorCode: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([_url, init]) => !init.body)).toBe(true);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(rules).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a timeout while cancelling launch and lets an immediate fresh task initialize again", async () => {
    const { ProviderError } = await import("../src/shared/errors");
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(launch())
      .mockResolvedValueOnce(translation());
    const parent = new AbortController();
    const first = doubao.withDoubaoDeadline((signal) => new doubao.DoubaoProvider(config).translateBatch({
      texts: ["Timed out paragraph"], targetLang: "zh-CN"
    }, signal), parent.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    parent.abort(new ProviderError("Task deadline reached", "timeout"));
    expect(await first).toMatchObject({ errorCode: "timeout" });
    // Start immediately, before the abandoned initializer's final Promise
    // continuations run. A new task must not inherit that cancelled Promise.
    const fresh = translate("Fresh paragraph after timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "timeout" });

    await vi.runAllTimersAsync();
    expect(await fresh).toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(doubao.getDoubaoStatus()).toMatchObject({ state: "ready" });
    expect(rules).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
