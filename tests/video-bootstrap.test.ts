// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initEmbeddedVideoSubtitles } from "../src/content/video-bootstrap";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", { runtime: { id: "wupage", getURL: vi.fn() } });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("stops a dormant frame's polling before a late video can use the invalid runtime", async () => {
  initEmbeddedVideoSubtitles();
  expect(vi.getTimerCount()).toBe(1);
  Object.defineProperty(chrome.runtime, "id", { value: undefined });
  document.body.innerHTML = '<video width="640" height="360"></video>';
  await vi.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.getURL).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  document.querySelector("video")!.dispatchEvent(new Event("playing", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(20000);
  expect(vi.getTimerCount()).toBe(0);
});

it("catches synchronous getURL failure if reload happens while a module is starting", async () => {
  document.body.innerHTML = '<video width="640" height="360"></video>';
  vi.mocked(chrome.runtime.getURL).mockImplementation(() => {
    Object.defineProperty(chrome.runtime, "id", { value: undefined });
    throw new Error("Extension context invalidated.");
  });
  initEmbeddedVideoSubtitles();
  await vi.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.getURL).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
