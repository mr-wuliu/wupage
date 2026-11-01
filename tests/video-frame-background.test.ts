import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureVideoFrame } from "../src/background/video-frame";
import { getSettings } from "../src/shared/settings";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
vi.mock("../src/shared/settings", () => ({ getSettings: vi.fn() }));
const area = { rect: { x: 10, y: 20, width: 640, height: 360 }, viewport: { width: 1000, height: 800 } };
const sender = { url: "https://video.example/player", tab: { id: 5, windowId: 2, url: "https://example.com/" } } as chrome.runtime.MessageSender;
const draw = vi.fn(), close = vi.fn();
const getTab = vi.fn(async () => ({ active: true, windowId: 2, url: sender.tab!.url }));
beforeEach(() => {
  vi.mocked(getSettings).mockResolvedValue({ ...structuredClone(DEFAULT_SETTINGS), imageTranslationEnabled: true });
  getTab.mockResolvedValue({ active: true, windowId: 2, url: sender.tab!.url });
  vi.stubGlobal("chrome", { tabs: { get: getTab, captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,AQID") } });
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2000, height: 1600, close }));
  vi.stubGlobal("OffscreenCanvas", class { constructor(readonly width: number, readonly height: number) {} getContext() { return { drawImage: draw }; } convertToBlob() { return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])); } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("video screenshot background boundary", () => {
  it("captures the sender's window and returns only the video crop at device scale", async () => {
    await expect(captureVideoFrame(area, sender)).resolves.toEqual({ dataUrl: "data:image/png;base64,AQID" });
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(2, { format: "png" });
    expect(draw).toHaveBeenCalledWith(expect.anything(), 20, 40, 1280, 720, 0, 0, expect.any(Number), expect.any(Number));
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not capture for missing sender identity, invalid areas, disabled OCR or background tabs", async () => {
    await expect(captureVideoFrame(area, {})).rejects.toThrow();
    await expect(captureVideoFrame({ ...area, rect: { ...area.rect, x: -1 } }, sender)).rejects.toThrow();
    vi.mocked(getSettings).mockResolvedValueOnce(DEFAULT_SETTINGS);
    await expect(captureVideoFrame(area, sender)).rejects.toThrow("OCR");
    getTab.mockResolvedValueOnce({ active: false, windowId: 2, url: sender.tab!.url });
    await expect(captureVideoFrame(area, sender)).rejects.toThrow("已切换");
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("discards the capture if a tab changes during the browser request", async () => {
    getTab.mockResolvedValueOnce({ active: true, windowId: 2, url: sender.tab!.url })
      .mockResolvedValueOnce({ active: false, windowId: 2, url: sender.tab!.url });
    await expect(captureVideoFrame(area, sender)).rejects.toThrow("已切换");
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it("turns permission failures into a retry instruction", async () => {
    vi.mocked(chrome.tabs.captureVisibleTab).mockRejectedValueOnce(new Error("Denied"));
    await expect(captureVideoFrame(area, sender)).rejects.toThrow("WuPage 图标");
  });
  it("explains the browser screenshot rate limit", async () => {
    vi.mocked(chrome.tabs.captureVisibleTab).mockRejectedValueOnce(new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded"));
    await expect(captureVideoFrame(area, sender)).rejects.toThrow("过于频繁");
  });
});
