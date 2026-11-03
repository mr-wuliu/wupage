// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerSubtitleController } from "../src/content/video-player";
import { capturePausedVideo } from "../src/content/video-frame-capture";
import { renderImageTranslation } from "../src/content/image-rendering";
import { sendRuntimeRequest } from "../src/content/runtime";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, TranslateImageResponse } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
vi.mock("../src/content/video-frame-capture", () => ({ capturePausedVideo: vi.fn() }));
vi.mock("../src/content/image-rendering", () => ({ renderImageTranslation: vi.fn() }));
let player: PlayerSubtitleController;
let video: HTMLVideoElement;
let paused: boolean;
let settings: ExtensionSettings;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const root = () => player.view.root;
const button = () => root().querySelector<HTMLButtonElement>(".frame")!;
const status = () => root().querySelector<HTMLElement>(".frame-status")!;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const result: TranslateImageResponse = { cached: false, targetLang: "zh-CN", regions: [{
  box: [100, 100, 300, 100], text: "Settings", translation: "设置", foreground: "#fff", background: "#000", align: "left", bold: false
}] };

beforeEach(() => {
  vi.useFakeTimers();
  settings = { ...structuredClone(DEFAULT_SETTINGS), imageTranslationEnabled: true };
  vi.stubGlobal("chrome", { storage: { onChanged: { addListener: (listener: typeof changed) => { changed = listener; }, removeListener: vi.fn() } } });
  document.body.innerHTML = '<div style="position:relative"><video></video></div>';
  video = document.querySelector("video")!; paused = false;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  vi.spyOn(video, "pause").mockImplementation(() => { paused = true; video.dispatchEvent(new Event("pause")); });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings : request.type === "TRANSLATE_IMAGE" ? result : null);
  vi.mocked(capturePausedVideo).mockResolvedValue({ source: document.createElement("canvas"), dataUrl: "data:image/png;base64,AQID",
    width: 1280, height: 720, objectFit: "contain", objectPosition: "50% 50%" });
  player = new PlayerSubtitleController(video, video.parentElement!);
});
afterEach(() => { player.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("paused video frame translation", () => {
  it("pauses on demand, translates without a subtitle track, and toggles the cached frame", async () => {
    await flush(); expect(capturePausedVideo).not.toHaveBeenCalled();
    button().click(); await flush();
    expect(video.pause).toHaveBeenCalledOnce(); expect(player.enabled).toBe(false);
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "TRANSLATE_IMAGE", dataUrl: "data:image/png;base64,AQID", width: 1280, height: 720 });
    expect(root().querySelector("canvas")?.getAttribute("aria-label")).toBe("设置");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(renderImageTranslation).toHaveBeenCalledOnce();
    button().click(); expect(root().querySelector("canvas")?.hidden).toBe(true);
    button().click(); expect(root().querySelector("canvas")?.hidden).toBe(false);
    expect(capturePausedVideo).toHaveBeenCalledOnce();
  });

  it.each(["play", "seeking", "emptied", "loadedmetadata"])("clears the translated frame on %s", async type => {
    button().click(); await flush();
    video.dispatchEvent(new Event(type));
    expect(root().querySelector("canvas")).toBeNull(); expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores an in-flight translation after playback resumes", async () => {
    let finish!: (value: TranslateImageResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? new Promise(resolve => { finish = resolve as typeof finish; }) : null);
    button().click(); await flush();
    paused = false; video.dispatchEvent(new Event("play")); finish(result); await flush();
    expect(root().querySelector("canvas")).toBeNull(); expect(button().getAttribute("aria-busy")).toBe("false");
  });

  it("cancels capture before sending OCR and can immediately retry", async () => {
    let finish!: () => void;
    vi.mocked(capturePausedVideo).mockImplementationOnce((_video, signal) => new Promise((_resolve, reject) => {
      finish = () => reject(new DOMException("Aborted", "AbortError")); signal.addEventListener("abort", finish);
    }));
    button().click(); await flush(); button().click(); finish(); await flush();
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "TRANSLATE_IMAGE")).toBe(false);
    button().click(); await flush(); expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["targetLang", "sourceLang", "activeProviderId", "imageTranslationEnabled"] as const)("discards the frame when %s changes", async key => {
    button().click(); await flush();
    settings = { ...settings, [key]: key === "imageTranslationEnabled" ? false : "ja" };
    changed({ [SETTINGS_KEY]: { newValue: settings } }, "local");
    expect(root().querySelector("canvas")).toBeNull();
  });

  it("explains missing OCR setup before capturing any pixels", async () => {
    settings.imageTranslationEnabled = false;
    button().click(); await flush();
    expect(root().querySelector(".frame-status")?.textContent).toContain("安装 OCR 模型");
    expect(capturePausedVideo).not.toHaveBeenCalled(); expect(button().getAttribute("aria-busy")).toBe("false");
  });

  it("reports no text and capture errors, then allows retry", async () => {
    vi.mocked(capturePausedVideo).mockRejectedValueOnce(new Error("此视频受内容保护"));
    button().click(); await flush(); expect(root().querySelector(".frame-status")?.textContent).toContain("内容保护");
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? { ...result, regions: [], warning: "未识别到文字" } : null);
    button().click(); await flush(); expect(root().querySelector(".frame-status")?.textContent).toBe("未识别到文字");
    expect(root().querySelector("canvas")).toBeNull();
  });

  it.each(["no-text", "capture-error", "missing-setup"])("dismisses the %s notice after five seconds while keeping retry available", async reason => {
    const warning = "未能可靠识别图片文字，艺术字、竖排或低对比度图片可能漏识别。";
    if (reason === "capture-error") vi.mocked(capturePausedVideo).mockRejectedValueOnce(new Error("此视频受内容保护"));
    else if (reason === "missing-setup") settings.imageTranslationEnabled = false;
    else vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? { ...result, regions: [], warning } : null);
    button().click(); await flush();
    const message = reason === "capture-error" ? "此视频受内容保护" : reason === "missing-setup" ? "安装 OCR 模型" : warning;
    expect(status().textContent).toContain(message); expect(status().hidden).toBe(false);
    vi.advanceTimersByTime(4999);
    expect(status().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(status().hidden).toBe(true); expect(status().textContent).toBe("");
    expect(button().getAttribute("aria-busy")).toBe("false"); expect(button().disabled).toBe(false);
  });

  it("dismisses partial-result warnings without removing the translated frame", async () => {
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? { ...result, warning: "另有 1 处识别异常，未覆盖这些区域。" } : null);
    button().click(); await flush();
    const canvas = root().querySelector("canvas")!;
    expect(status().hidden).toBe(false); expect(status().textContent).toContain("未覆盖这些区域");
    vi.advanceTimersByTime(5000);
    expect(status().hidden).toBe(true); expect(status().textContent).toBe("");
    expect(root().querySelector("canvas")).toBe(canvas); expect(canvas.hidden).toBe(false);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    button().click(); expect(canvas.hidden).toBe(true);
  });

  it("keeps a retry's loading notice visible past the previous warning's expiry", async () => {
    vi.mocked(capturePausedVideo).mockRejectedValueOnce(new Error("暂时无法读取视频画面"));
    button().click(); await flush();
    vi.advanceTimersByTime(3000);
    let finish!: (value: TranslateImageResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? new Promise(resolve => { finish = resolve as typeof finish; }) : null);
    button().click(); await flush();
    vi.advanceTimersByTime(10_000);
    expect(status().hidden).toBe(false); expect(status().textContent).toBe("正在识别并翻译视频画面…");
    expect(button().getAttribute("aria-busy")).toBe("true");
    finish(result); await flush();
    expect(status().hidden).toBe(true); expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("clears a pending notice expiry when the player is disposed", async () => {
    vi.mocked(capturePausedVideo).mockRejectedValueOnce(new Error("暂时无法读取视频画面"));
    button().click(); await flush();
    player.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards pending results after the player is removed", async () => {
    let finish!: (value: TranslateImageResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? settings
      : request.type === "TRANSLATE_IMAGE" ? new Promise(resolve => { finish = resolve as typeof finish; }) : null);
    button().click(); await flush(); player.dispose(); finish(result); await flush();
    expect(document.querySelector("[data-wupage-video]")).toBeNull(); expect(renderImageTranslation).not.toHaveBeenCalled();
  });
});
