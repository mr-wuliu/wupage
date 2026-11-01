// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePausedVideo } from "../src/content/video-frame-capture";
import { sendRuntimeRequest } from "../src/content/runtime";
import { validVideoFrameArea } from "../src/shared/video-frame";
import { installFrameVisibilityBridge } from "../src/content/frame-visibility";
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
let video: HTMLVideoElement;
const drawImage = vi.fn();
beforeEach(() => {
  document.body.innerHTML = '<video></video>';
  video = document.querySelector("video")!;
  Object.defineProperties(video, { videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 }, readyState: { configurable: true, value: 4 } });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 20, 640, 360));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AQID");
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); Reflect.deleteProperty(HTMLImageElement.prototype, "decode"); document.body.replaceChildren(); });

describe("video frame capture", () => {
  it("reads the decoded video pixels directly without capturing the webpage", async () => {
    const hide = vi.fn();
    const result = await capturePausedVideo(video, new AbortController().signal, hide);
    expect(result).toMatchObject({ width: 1920, height: 1080, objectFit: "contain" });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(sendRuntimeRequest).not.toHaveBeenCalled(); expect(hide).not.toHaveBeenCalled();
  });
  it("crops a tab screenshot when cross-origin media taints canvas, restoring the tools", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
    vi.mocked(sendRuntimeRequest).mockResolvedValue({ dataUrl: "data:image/png;base64,AQID" });
    HTMLImageElement.prototype.decode = vi.fn(async function (this: HTMLImageElement) {
      Object.defineProperties(this, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
    });
    const hide = vi.fn();
    const frame = await capturePausedVideo(video, new AbortController().signal, hide);
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "CAPTURE_VIDEO_FRAME", rect: { x: 30, y: 20, width: 640, height: 360 }, viewport: { width: innerWidth, height: innerHeight } });
    expect(frame).toMatchObject({ width: 1280, height: 720, objectFit: "fill" });
    expect(hide.mock.calls).toEqual([[true], [false]]);
  });
  it("restores the tools after screenshot failure and rejects clipped screenshots", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
    vi.mocked(sendRuntimeRequest).mockRejectedValue(new Error("Capture denied"));
    const hide = vi.fn();
    await expect(capturePausedVideo(video, new AbortController().signal, hide)).rejects.toThrow("Capture denied");
    expect(hide.mock.calls).toEqual([[true], [false]]);
    vi.mocked(sendRuntimeRequest).mockClear();
    vi.mocked(video.getBoundingClientRect).mockReturnValue(new DOMRect(-20, 20, 640, 360));
    await expect(capturePausedVideo(video, new AbortController().signal, hide)).rejects.toThrow("完整视频");
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });
  it("does not capture unready, playing, seeking, protected or aborted video", async () => {
    for (const props of [{ readyState: 1 }, { paused: false }, { seeking: true }, { mediaKeys: {} }]) {
      const saved = Object.getOwnPropertyDescriptors(video);
      for (const [key, value] of Object.entries(props)) Object.defineProperty(video, key, { configurable: true, value });
      await expect(capturePausedVideo(video, new AbortController().signal, vi.fn())).rejects.toThrow();
      for (const key of Object.keys(props)) {
        if (saved[key]) Object.defineProperty(video, key, saved[key]); else Reflect.deleteProperty(video, key);
      }
    }
    const controller = new AbortController(); controller.abort();
    await expect(capturePausedVideo(video, controller.signal, vi.fn())).rejects.toThrow();
    expect(drawImage).not.toHaveBeenCalled();
  });
  it("rejects a screenshot taken while the video moves, before sending its pixels to OCR", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
    vi.mocked(sendRuntimeRequest).mockImplementation(async () => {
      vi.mocked(video.getBoundingClientRect).mockReturnValue(new DOMRect(40, 20, 640, 360));
      return { dataUrl: "data:image/png;base64,AQID" };
    });
    const hide = vi.fn();
    await expect(capturePausedVideo(video, new AbortController().signal, hide)).rejects.toThrow("视频位置已变化");
    expect(hide.mock.calls).toEqual([[true], [false]]);
  });
});

describe("video screenshot coordinates", () => {
  it("rejects malformed or partly offscreen areas", () => {
    const area = { rect: { x: 10, y: 20, width: 640, height: 360 }, viewport: { width: 1024, height: 768 } };
    expect(validVideoFrameArea(area)).toBe(true);
    for (const rect of [{ ...area.rect, x: -1 }, { ...area.rect, y: 500 }, { ...area.rect, width: NaN }, { ...area.rect, width: 0 }]) {
      expect(validVideoFrameArea({ ...area, rect })).toBe(false);
    }
    expect(validVideoFrameArea(null as never)).toBe(false);
  });
  it("maps an actual child frame through borders and CSS scaling without returning pixels", async () => {
    installFrameVisibilityBridge();
    const frame = document.createElement("iframe"); document.body.append(frame);
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 804, 404));
    Object.defineProperties(frame, { offsetWidth: { value: 402 }, offsetHeight: { value: 202 }, clientWidth: { value: 400 }, clientHeight: { value: 200 }, clientLeft: { value: 1 }, clientTop: { value: 1 } });
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "wupage-video-frame-area", key: "a".repeat(32),
      area: { rect: { x: 10, y: 20, width: 300, height: 100 }, viewport: { width: 400, height: 200 } } } }));
    await Promise.resolve();
    expect(post).toHaveBeenCalledWith({ type: "wupage-video-frame-area-result", key: "a".repeat(32),
      area: { rect: { x: 122, y: 92, width: 600, height: 200 }, viewport: { width: innerWidth, height: innerHeight } } }, "*");
  });
});
