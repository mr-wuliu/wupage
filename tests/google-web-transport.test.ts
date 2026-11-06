import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let translate: typeof import("../src/background/google-web-transport").fetchGoogleWebTranslation;
const reply = () => new Response(JSON.stringify([[["你好", "Hello"]]]));
const call = (signal?: AbortSignal) => translate("Hello", "en", "zh-CN", signal);

beforeEach(async () => {
  vi.resetModules();
  translate = (await import("../src/background/google-web-transport")).fetchGoogleWebTranslation;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Google web host recovery", () => {
  it("keeps the existing protocol and omits cookies", async () => {
    const fetch = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetch);
    expect(await call()).toEqual([[["你好", "Hello"]]]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).hostname).toBe("translate.googleapis.com");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ client: "gtx", sl: "en", tl: "zh-CN", dt: "t", q: "Hello" });
    expect(init.credentials).toBe("omit");
  });
  it("tries the other Google host on connection failure and briefly remembers the working route", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => reply());
    vi.stubGlobal("fetch", fetch);
    await call(); await call();
    expect(fetch.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
      "translate.googleapis.com", "translate.google.com", "translate.google.com"
    ]);
    clock.mockReturnValue(161_000); await call();
    expect(new URL(fetch.mock.calls[3][0]).hostname).toBe("translate.googleapis.com");
  });
  it("reports both hosts after bounded connection attempts", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")); vi.stubGlobal("fetch", fetch);
    await expect(call()).rejects.toMatchObject({ errorCode: "service-unavailable", message: expect.stringContaining("translate.google.com") });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["translate.googleapis.com", "translate.google.com"]);
  });
  it.each([401, 403, 429, 503])("does not switch hosts after HTTP %s", async status => {
    const fetch = vi.fn(async () => new Response("Rejected", { status })); vi.stubGlobal("fetch", fetch);
    await expect(call()).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["<html>Sign in</html>", "not JSON", "null", "{}", "[null]"])("does not switch hosts after an invalid response: %s", async body => {
    const fetch = vi.fn(async () => new Response(body)); vi.stubGlobal("fetch", fetch);
    await expect(call()).rejects.toMatchObject({ errorCode: "protocol-changed" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("recovers when the primary response stream breaks after its headers", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("Connection reset")); }
    }))).mockImplementation(async () => reply());
    vi.stubGlobal("fetch", fetch);
    await expect(call()).resolves.toEqual([[["你好", "Hello"]]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["TimeoutError", "AbortError"])("recovers after a response body timeout reported as %s", async name => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException("Response timed out", name)); }
    }))).mockImplementation(async () => reply());
    vi.stubGlobal("fetch", fetch);
    await expect(call()).resolves.toEqual([[["你好", "Hello"]]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not switch hosts when the caller cancels while reading the response body", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      pull(stream) { controller.abort(); stream.error(controller.signal.reason); }
    })));
    vi.stubGlobal("fetch", fetch);
    await expect(call(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("tries the alternate host after a request timeout", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(10));
    const fetch = vi.fn().mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })).mockImplementation(async () => reply());
    vi.stubGlobal("fetch", fetch);
    await expect(call()).resolves.toEqual([[["你好", "Hello"]]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not try another host after user cancellation", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetch);
    await expect(call(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(call(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
