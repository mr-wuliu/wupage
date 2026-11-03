import { afterEach, describe, expect, it, vi } from "vitest";
import { installPdfTranslation } from "../src/background/pdf-translation";
import { translateWithSettings, getTranslationDebugSnapshot } from "../src/background/translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { ProviderError } from "../src/shared/errors";
import { PDF_TRANSLATION_PORT, PDF_TRANSLATION_TIMEOUT_MS, requestPdfTranslation } from "../src/shared/pdf-translation";
import type { TranslateBatchResponse } from "../src/shared/types";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    listeners, addListener: (listener: T) => { listeners.add(listener); },
    removeListener: (listener: T) => { listeners.delete(listener); },
    emit: (...args: Parameters<T>) => { for (const listener of [...listeners]) listener(...args); }
  };
}

function runtime(sender = { id: "test", url: "chrome-extension://test/pdf.html?translate=1" }) {
  const onConnect = event<(port: chrome.runtime.Port) => void>();
  const connections: ReturnType<typeof pair>[] = [];
  function pair() {
    let disconnected = false;
    const client = { name: PDF_TRANSLATION_PORT, onMessage: event<(message: unknown) => void>(),
      onDisconnect: event<() => void>(), postMessage: (message: unknown) => send(server, message), disconnect };
    const server = { ...client, sender, onMessage: event<(message: unknown) => void>(), onDisconnect: event<() => void>(),
      postMessage: (message: unknown) => send(client, message) };
    function send(target: typeof client, message: unknown) {
      if (disconnected) throw new Error("Port disconnected");
      queueMicrotask(() => { if (!disconnected) target.onMessage.emit(structuredClone(message)); });
    }
    function disconnect() {
      if (disconnected) return;
      disconnected = true;
      // Chrome fires onDisconnect only at the other end of an explicit close.
      queueMicrotask(() => { client.onDisconnect.emit(); server.onDisconnect.emit(); });
    }
    onConnect.emit(server as unknown as chrome.runtime.Port);
    return { client, server };
  }
  const connect = vi.fn(() => { const connection = pair(); connections.push(connection); return connection.client; });
  vi.stubGlobal("chrome", { runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}`, onConnect, connect } });
  return { connections, connect };
}
const request = { texts: ["Let ⟪WUPAGE0⟫ be fixed."], preservePlaceholders: true, targetLang: "zh-CN" };

describe("PDF translation lifetime", () => {
  it("delivers a result and cleans up the connection and timers", async () => {
    vi.useFakeTimers();
    const host = runtime();
    installPdfTranslation(async () => ({ translations: ["设 ⟪WUPAGE0⟫ 不变。"], cached: 1 }));
    await expect(requestPdfTranslation(request, 7, new AbortController().signal)).resolves.toEqual({ translations: ["设 ⟪WUPAGE0⟫ 不变。"], cached: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const port of Object.values(host.connections[0])) {
      expect(port.onMessage.listeners.size).toBe(0);
      expect(port.onDisconnect.listeners.size).toBe(0);
    }
  });

  it("preserves provider errors and retry information", async () => {
    runtime();
    installPdfTranslation(async () => { throw new ProviderError("稍后重试", "rate-limited", 45_000); });
    await expect(requestPdfTranslation(request, 7, new AbortController().signal)).rejects.toMatchObject({ errorCode: "rate-limited", retryAfterMs: 45_000 });
  });

  it("cancels queued or running work when settings change or the reader closes", async () => {
    vi.useFakeTimers(); runtime();
    let backendSignal!: AbortSignal;
    let finish!: (result: TranslateBatchResponse) => void;
    installPdfTranslation(async (_request, _sender, signal) => {
      backendSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    const pending = requestPdfTranslation(request, 7, controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(backendSignal.aborted).toBe(false);
    controller.abort();
    await failure;
    await vi.advanceTimersByTimeAsync(0);
    expect(backendSignal.aborted).toBe(true);
    finish({ translations: ["Late response"], cached: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the loading state immediately when the background connection is lost", async () => {
    const host = runtime();
    installPdfTranslation(async () => new Promise(() => {}));
    const pending = requestPdfTranslation(request, 7, new AbortController().signal);
    const failure = expect(pending).rejects.toThrow("翻译连接已中断");
    host.connections[0].server.disconnect();
    await failure;
  });

  it("enforces the whole-page deadline in the background even if the reader timer is suspended", async () => {
    vi.useFakeTimers(); const host = runtime();
    let backendSignal!: AbortSignal;
    installPdfTranslation(async (_request, _sender, signal) => {
      backendSignal = signal; return new Promise(() => {});
    });
    const port = host.connect();
    const messages: unknown[] = [];
    port.onMessage.addListener(message => { messages.push(message); });
    port.postMessage({ type: "translate", request, pageNumber: 7 });
    await vi.advanceTimersByTimeAsync(PDF_TRANSLATION_TIMEOUT_MS);
    expect(backendSignal.aborted).toBe(true);
    expect(messages).toContainEqual({ type: "heartbeat" });
    expect(messages.at(-1)).toMatchObject({ type: "result", response: { ok: false, errorCode: "timeout", error: expect.stringContaining("第 7 页") } });
    expect(vi.getTimerCount()).toBe(0);
    port.disconnect();
  });

  it.each([
    { id: "other", url: "chrome-extension://test/pdf.html" },
    { id: "test", url: "https://example.com/pdf.html" },
    { id: "test", url: "chrome-extension://test/options.html" }
  ])("rejects connections from other pages: $url", async sender => {
    runtime(sender);
    const translate = vi.fn(); installPdfTranslation(translate);
    await expect(requestPdfTranslation(request, 7, new AbortController().signal)).rejects.toThrow("翻译连接已中断");
    expect(translate).not.toHaveBeenCalled();
  });

  it("aborts protected-text retries and frees provider slots so a failed page can be retried", async () => {
    vi.useFakeTimers(); runtime();
    const settings = { ...structuredClone(DEFAULT_SETTINGS), cacheEnabled: false, concurrency: 1,
      activeProviderId: "pdf-lifetime", providers: [{ id: "pdf-lifetime", type: "deepseek" as const,
        label: "Test", baseURL: "https://example.test/v1", apiKey: "test-only", model: "test", systemPrompt: "Translate.",
        performanceMode: "custom" as const, concurrency: 1, chunkSize: 3200 }] };
    let retrySignal!: AbortSignal;
    let recover = false;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { texts } = JSON.parse(JSON.parse(String(init.body)).messages.at(-1).content) as { texts: string[] };
      if (recover) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(() => "设 ⟪WUPAGE0⟫ 不变。")) } }] }));
      retrySignal = init.signal!;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50_000);
        retrySignal.addEventListener("abort", () => { clearTimeout(timer); reject(retrySignal.reason); }, { once: true });
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: '["遗漏了公式"]' } }] }));
    });
    vi.stubGlobal("fetch", fetch);
    installPdfTranslation((input, _sender, signal) => translateWithSettings(settings, input, { signal }));
    const first = requestPdfTranslation(request, 7, new AbortController().signal);
    const failure = expect(first).rejects.toMatchObject({ errorCode: "timeout" });
    await vi.advanceTimersByTimeAsync(PDF_TRANSLATION_TIMEOUT_MS);
    await failure;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(retrySignal.aborted).toBe(true);
    const tasks = getTranslationDebugSnapshot().tasks.filter(task => task.providerId === "pdf-lifetime");
    expect(tasks.every(task => task.status === "failed")).toBe(true);
    recover = true;
    const second = requestPdfTranslation(request, 7, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toMatchObject({ translations: ["设 ⟪WUPAGE0⟫ 不变。"] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes a cancelled page from the provider queue before the running page finishes", async () => {
    vi.useFakeTimers(); runtime();
    const settings = { ...structuredClone(DEFAULT_SETTINGS), cacheEnabled: false, concurrency: 1,
      activeProviderId: "pdf-queue-cancel", providers: [{ id: "pdf-queue-cancel", type: "deepseek" as const,
        label: "Test", baseURL: "https://example.test/v1", apiKey: "test-only", model: "test", systemPrompt: "Translate.",
        performanceMode: "custom" as const, concurrency: 1, chunkSize: 3200 }] };
    let release!: () => void;
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ choices: [{ message: { content: '["有效译文"]' } }] }));
    });
    vi.stubGlobal("fetch", fetch);
    installPdfTranslation((input, _sender, signal) => translateWithSettings(settings, input, { signal }));
    const first = requestPdfTranslation({ texts: ["running"], targetLang: "zh-CN" }, 1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const queued = requestPdfTranslation({ texts: ["queued"], targetLang: "zh-CN" }, 2, controller.signal);
    const failure = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getTranslationDebugSnapshot().tasks.find(task => task.providerId === "pdf-queue-cancel" && task.sourceTexts?.[0] === "queued")?.status).toBe("queued");
    controller.abort(); await failure;
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(fetch).toHaveBeenCalledOnce();
    const next = requestPdfTranslation({ texts: ["next"], targetLang: "zh-CN" }, 3, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ translations: ["有效译文"] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
