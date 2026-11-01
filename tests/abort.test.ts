import { afterEach, describe, expect, it, vi } from "vitest";
import { anySignal } from "../src/shared/abort";

const nativeAny = AbortSignal.any;
afterEach(() => { Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: nativeAny }); vi.restoreAllMocks(); });
describe("cancellation compatibility", () => {
  it("forwards reasons and removes listeners without native any", () => {
    Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: undefined });
    const a = new AbortController(), b = new AbortController();
    const removeA = vi.spyOn(a.signal, "removeEventListener");
    const removeB = vi.spyOn(b.signal, "removeEventListener");
    const combined = anySignal([a.signal, b.signal, a.signal]);
    b.abort(new Error("stopped"));
    expect(combined.reason).toBe(b.signal.reason);
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(removeB).toHaveBeenCalledTimes(1);
  });
  it("handles already cancelled inputs before subscribing", () => {
    Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: undefined });
    const a = new AbortController(); a.abort("already stopped");
    const add = vi.spyOn(a.signal, "addEventListener");
    expect(anySignal([a.signal]).reason).toBe("already stopped");
    expect(add).not.toHaveBeenCalled();
  });
  it("does not accumulate listeners for successive batches in the same document", () => {
    Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: undefined });
    const a = new AbortController(), b = new AbortController();
    const add = vi.spyOn(a.signal, "addEventListener");
    const first = anySignal([a.signal, b.signal]);
    for (let batch = 0; batch < 100; batch++) expect(anySignal([a.signal, b.signal])).toBe(first);
    expect(add).toHaveBeenCalledTimes(1);
    a.abort(); expect(first.aborted).toBe(true);
  });
});
