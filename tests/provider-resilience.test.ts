import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/background/providers";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const request = { texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" };
const machine = () => createProvider({ id: "microsoft", type: "microsoft-web-translate", label: "Microsoft" });
const llm = () => createProvider({ id: "test", type: "deepseek", label: "Test", baseURL: "https://example.test/v1",
  apiKey: "test-only", model: "test", systemPrompt: "Translate." });

// Model a server that flushes headers and then stalls mid-body. Aborting fetch
// must still abort its body after the headers promise has already resolved.
function stalledBody(status = 200) {
  let signal: AbortSignal | undefined;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
      }
    }), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, signal: () => signal };
}

describe("translation transport recovery", () => {
  it("cancels HTML responses and pauses a misconfigured endpoint instead of requesting every paragraph", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html>")); }, cancel
    }), { headers: { "content-type": "text/html" } })));
    await expect(machine().translateBatch(request)).rejects.toMatchObject({ errorCode: "protocol-changed" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels an in-progress response body after headers arrive", async () => {
    const f = stalledBody();
    const controller = new AbortController();
    const result = machine().translateBatch(request, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.signal()).toBeDefined());
    controller.abort();
    await rejected;
    expect(f.signal()!.aborted).toBe(true);
  });

  it("keeps the response-body deadline after headers arrive", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
    stalledBody();
    await expect(machine().translateBatch(request)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("bounds response allocation and cancels an oversized stream", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel
    }))));
    await expect(machine().translateBatch(request)).rejects.toMatchObject({ errorCode: "request-rejected" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("bounds HTTP 400 inspection and cancels both response branches (temperature=%s)", async temperature => {
    let downloadedBytes = 0;
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    if (temperature) chunk.set(new TextEncoder().encode("temperature is not supported"));
    const fetch = vi.fn()
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (downloadedBytes >= 16 * 1024 * 1024) { controller.close(); return; }
          downloadedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel
      }), { status: 400 }))
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '["你好"]' } }] })));
    vi.stubGlobal("fetch", fetch);

    await expect(llm().translateBatch(request)).rejects.toMatchObject({
      errorCode: "request-rejected", message: expect.stringContaining("响应过大")
    });
    expect(downloadedBytes).toBeLessThan(16 * 1024 * 1024);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves cancellation while inspecting an LLM HTTP 400 body", async () => {
    const f = stalledBody(400);
    const controller = new AbortController();
    const result = llm().translateBatch(request, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.signal()).toBeDefined());
    controller.abort();
    await rejected;
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("keeps the response-body deadline while inspecting an LLM HTTP 400 body", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
    const f = stalledBody(400);
    await expect(llm().translateBatch(request)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([[400, "request-rejected"], [401, "login-required"], [403, "permission-required"], [413, "input-too-long"],
    [414, "input-too-long"], [422, "request-rejected"], [429, "rate-limited"], [500, "service-unavailable"]] as const)
    ("distinguishes request and provider errors for HTTP %s", async (status, errorCode) => {
      const fetch = vi.fn(async () => new Response("unavailable", { status, headers: { "Retry-After": "120" } }));
      vi.stubGlobal("fetch", fetch);
      await expect(machine().translateBatch(request)).rejects.toMatchObject({ errorCode });
      expect(fetch).toHaveBeenCalledOnce();
    });

  it("pauses on malformed JSON instead of retrying every paragraph", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken")));
    await expect(machine().translateBatch(request)).rejects.toMatchObject({ errorCode: "protocol-changed" });
  });

  it("classifies an offline connection as a recoverable page-wide pause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(machine().translateBatch(request)).rejects.toMatchObject({ errorCode: "service-unavailable" });
  });

  it("reports long Retry-After values without keeping the LLM queue occupied", async () => {
    const fetch = vi.fn(async () => new Response("quota", { status: 429, headers: { "Retry-After": "3600" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(llm().translateBatch(request)).rejects.toMatchObject({ errorCode: "rate-limited", retryAfterMs: 3_600_000 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a pending LLM retry delay without sending another request", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "1" } }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const result = llm().translateBatch(request, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves invalid numeric HTML entities instead of crashing translation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { translations: [
      { translatedText: "Text &#999999999; and &#xFFFFFFF;." }
    ] } }))));
    const provider = createProvider({ id: "google", type: "google-cloud-translation", label: "Google", apiKey: "test-only" });
    await expect(provider.translateBatch(request)).resolves.toEqual(["Text &#999999999; and &#xFFFFFFF;."]);
  });
});
