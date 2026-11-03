import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfTranslationQueue, type PdfQueuePage, type PdfQueuePageStatus } from "../src/pdf/translation-queue";
import { ProviderError } from "../src/shared/errors";
import type { TranslateBatchResponse } from "../src/shared/types";

afterEach(() => vi.useRealTimers());
function page(number: number, count = 3): PdfQueuePage {
  return { pageNumber: number, items: Array.from({ length: count }, (_, index) => ({ index, text: `Page ${number} paragraph ${index}.` })), values: Array(count).fill(undefined) };
}
function harness(concurrency = 2, maxChars = 200) {
  const calls: Array<{ page: number; indexes: number[]; signal: AbortSignal; resolve: (value: TranslateBatchResponse) => void; reject: (error: unknown) => void }> = [];
  const updates: Array<{ page: number; status: PdfQueuePageStatus }> = [];
  const idle = vi.fn();
  const queue = new PdfTranslationQueue({ concurrency, maxChars,
    translate: (page, indexes, signal) => new Promise((resolve, reject) => {
      calls.push({ page: page.pageNumber, indexes, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    restore: (_page, _index, value) => { if (value === "broken") throw new Error("Missing formula"); return value; },
    onChange: (page, status) => { updates.push({ page: page.pageNumber, status }); }, onIdle: idle });
  const finish = async (index: number, values?: string[]) => {
    const call = calls[index]; call.resolve({ translations: values ?? call.indexes.map(value => `译文 ${value}`), cached: 0 });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { queue, calls, updates, idle, finish };
}

describe("resumable PDF paragraph queue", () => {
  it("publishes small batches immediately and retains their results when another request fails", async () => {
    vi.useFakeTimers(); const h = harness(2, 25), first = page(1);
    h.queue.setScope([first], 1);
    expect(h.calls.map(call => call.indexes)).toEqual([[0], [1]]);
    await h.finish(0);
    expect(first.values[0]).toBe("译文 0");
    expect(h.updates.some(update => update.status.completed === 1 && update.status.total === 3)).toBe(true);
    h.calls[1].reject(new Error("Permanent paragraph failure"));
    await vi.advanceTimersByTimeAsync(0); await h.finish(2);
    expect(first.values).toEqual(["译文 0", undefined, "译文 2"]);
    expect(h.queue.status(first)).toMatchObject({ completed: 2, total: 3, running: false, pending: false, error: expect.any(Error) });
    expect(h.idle).toHaveBeenCalled();
  });

  it("retries only failed paragraphs once after a transient body interruption", async () => {
    vi.useFakeTimers(); const h = harness(2), first = page(1, 4);
    h.queue.setScope([first], 1);
    expect(h.calls[0].indexes).toEqual([0, 1, 2, 3]);
    h.calls[0].reject(new ProviderError("Interrupted response", "service-unavailable"));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls[1].indexes).toEqual([0]);
    await h.finish(1);
    h.calls[2].reject(new ProviderError("Still unavailable", "service-unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    await h.finish(3); await h.finish(4);
    expect(h.calls).toHaveLength(5);
    expect(first.values).toEqual(["译文 0", undefined, "译文 2", "译文 3"]);
    expect(h.queue.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes only missing paragraphs on explicit retry and preserves manual edits", async () => {
    vi.useFakeTimers(); const first = page(1, 4);
    first.values = ["手动校对", undefined, "已有译文", undefined];
    const h = harness(); h.queue.setScope([first], 1);
    expect(h.calls[0].indexes).toEqual([1, 3]);
    await h.finish(0);
    expect(first.values).toEqual(["手动校对", "译文 1", "已有译文", "译文 3"]);
  });

  it("preempts obsolete requests so a new reading page does not wait for old slow pages", async () => {
    vi.useFakeTimers(); const h = harness(2, 25), pages = [page(1), page(2), page(20)];
    h.queue.setScope(pages.slice(0, 2), 1);
    await h.finish(0);
    expect(pages[0].values[0]).toBe("译文 0");
    h.queue.suspend();
    h.queue.setScope([pages[2]], 20);
    expect(h.calls[1].signal.aborted).toBe(true);
    expect(h.calls[2].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[3].page).toBe(20);
    expect(pages[0].values[0]).toBe("译文 0");
    h.queue.cancel(); await vi.advanceTimersByTimeAsync(0);
    expect(h.queue.activeCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefetches in the direction of reading without exceeding the active-request limit", async () => {
    vi.useFakeTimers(); const h = harness(1), pages = [page(2, 1), page(3, 1), page(4, 1)];
    h.queue.setScope(pages, 3);
    expect(h.calls[0].page).toBe(3);
    await h.finish(0); expect(h.calls[1].page).toBe(4);
    await h.finish(1); expect(h.calls[2].page).toBe(2);
    await h.finish(2); expect(h.queue.activeCount).toBe(0);
  });

  it("keeps other valid items when one translated item loses a protected formula", async () => {
    vi.useFakeTimers(); const h = harness(), first = page(1);
    h.queue.setScope([first], 1);
    await h.finish(0, ["第一段", "broken", "第三段"]);
    expect(first.values).toEqual(["第一段", undefined, "第三段"]);
    expect(h.queue.status(first).completed).toBe(2);
    expect(h.queue.status(first).error).toBeInstanceOf(Error);
  });

  it("pauses after authentication errors even while the viewport is scrolling", async () => {
    vi.useFakeTimers(); const h = harness(), pages = [page(1), page(2), page(3)];
    h.queue.setScope(pages, 1); h.queue.suspend();
    h.calls[0].reject(new ProviderError("Log in", "login-required"));
    await vi.advanceTimersByTimeAsync(0);
    await h.finish(1);
    expect(h.calls).toHaveLength(2);
    expect(h.queue.pauseError?.errorCode).toBe("login-required");
    expect(h.queue.busy).toBe(false);
    expect(h.idle).toHaveBeenCalled();
  });

  it("allows an explicit page retry while other requests are still running", async () => {
    vi.useFakeTimers(); const h = harness(2, 25), pages = [page(1, 2), page(2, 1)];
    h.queue.setScope(pages, 1);
    h.calls[0].reject(new Error("Paragraph failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls[2].page).toBe(2);
    h.queue.retryPage(1);
    expect(h.queue.status(pages[0]).error).toBeUndefined();
    await h.finish(2);
    expect(h.calls[3].page).toBe(1); expect(h.calls[3].indexes).toEqual([0]);
    await h.finish(3); await h.finish(1);
    expect(pages[0].values).toEqual(["译文 0", "译文 1"]);
  });

  it("pauses repeated slow transport failures instead of timing out every remaining paragraph", async () => {
    vi.useFakeTimers(); const h = harness(2, 25), first = page(1, 10);
    h.queue.setScope([first], 1);
    await vi.advanceTimersByTimeAsync(20_000);
    h.calls[0].reject(new ProviderError("Interrupted", "service-unavailable"));
    h.calls[1].reject(new ProviderError("Interrupted", "service-unavailable"));
    await vi.advanceTimersByTimeAsync(20_000);
    h.calls[2].reject(new ProviderError("Interrupted", "service-unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(3);
    expect(h.queue.pauseError?.errorCode).toBe("service-unavailable");
    expect(h.queue.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
