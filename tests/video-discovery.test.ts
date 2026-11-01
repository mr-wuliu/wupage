// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initVideoSubtitles, openVideoSubtitles, VideoSubtitleManager } from "../src/content/video-subtitles";
import { PlayerSubtitleController } from "../src/content/video-player";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { normalizeVideoTranslation } from "../src/shared/video";
import { sendRuntimeRequest } from "../src/content/runtime";

vi.mock("../src/content/video-player", () => ({ PlayerSubtitleController: vi.fn() }));
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn(async () => null) }));
let manager: VideoSubtitleManager | undefined;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", { storage: { onChanged: { addListener: (listener: typeof changed) => { changed = listener; }, removeListener: vi.fn() } } });
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? structuredClone(DEFAULT_SETTINGS) : null);
  vi.mocked(PlayerSubtitleController).mockImplementation(function (video, container) {
    const player = {
      video, container, enabled: false, get connected() { return video.isConnected; },
      get wantsTranslation() { return player.enabled; },
      open: vi.fn(), start: vi.fn(async () => { player.enabled = true; }), dispose: vi.fn()
    };
    return player as unknown as PlayerSubtitleController;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 360));
});
afterEach(() => {
  manager?.dispose(); manager = undefined;
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren(); vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("discovers a video inserted into an already mounted open shadow root", async () => {
  document.body.innerHTML = '<div class="main"><video></video></div><div id="shadow-player"></div>';
  const shadow = document.querySelector("#shadow-player")!.attachShadow({ mode: "open" });
  manager = new VideoSubtitleManager();
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(1);
  shadow.innerHTML = '<div style="position:relative"><video></video></div>';
  await vi.advanceTimersByTimeAsync(200);
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(2);
});

it("reinitializes discovery after a page returns from the browser back-forward cache", async () => {
  document.body.innerHTML = '<div><video></video></div>';
  initVideoSubtitles();
  await vi.advanceTimersByTimeAsync(0);
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(1);
  vi.mocked(PlayerSubtitleController).mock.results[0].value.enabled = true;
  const event = new Event("pagehide"); Object.defineProperty(event, "persisted", { value: true });
  window.dispatchEvent(event);
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(0);
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(2);
  expect(vi.mocked(PlayerSubtitleController).mock.results[1].value.start).toHaveBeenCalledOnce();
  await expect(openVideoSubtitles()).resolves.toEqual({ opened: true });
});

it("removes video controls when globally disabled and restores discovery when enabled again", async () => {
  document.body.innerHTML = '<div><video></video></div>';
  initVideoSubtitles(); await vi.advanceTimersByTimeAsync(0);
  const first = vi.mocked(PlayerSubtitleController).mock.results[0].value;
  changed({ [SETTINGS_KEY]: { newValue: { ...DEFAULT_SETTINGS, videoTranslation: normalizeVideoTranslation({ enabled: false }) } } }, "local");
  expect(first.dispose).toHaveBeenCalledOnce();
  await expect(openVideoSubtitles()).resolves.toEqual({ opened: false });
  document.querySelector('video')!.replaceWith(document.createElement('video'));
  await vi.advanceTimersByTimeAsync(6100);
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(1);
  changed({ [SETTINGS_KEY]: { newValue: DEFAULT_SETTINGS } }, "local");
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(2);
});

it("keeps controls absent when a disable arrives before the initial settings read finishes", async () => {
  document.body.innerHTML = '<div><video></video></div>';
  let finish!: (value: typeof DEFAULT_SETTINGS) => void;
  vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  initVideoSubtitles();
  changed({ [SETTINGS_KEY]: { newValue: { ...DEFAULT_SETTINGS, videoTranslation: normalizeVideoTranslation({ enabled: false }) } } }, "local");
  finish(DEFAULT_SETTINGS); await vi.advanceTimersByTimeAsync(0);
  expect(PlayerSubtitleController).not.toHaveBeenCalled();
  await expect(openVideoSubtitles()).resolves.toEqual({ opened: false });
});

it("keeps a manually enabled session when a site replaces the video element", async () => {
  document.body.innerHTML = '<div><video></video></div>';
  manager = new VideoSubtitleManager();
  vi.mocked(PlayerSubtitleController).mock.results[0].value.enabled = true;
  document.querySelector('video')!.replaceWith(document.createElement('video'));
  await vi.advanceTimersByTimeAsync(200);
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(2);
  expect(vi.mocked(PlayerSubtitleController).mock.results[1].value.start).toHaveBeenCalledOnce();
});

it("opens the main paused video rather than a small autoplay preview", () => {
  document.body.innerHTML = '<div><video id="main"></video></div><div><video id="preview"></video></div>';
  const preview = document.querySelector<HTMLVideoElement>('#preview')!;
  Object.defineProperty(preview, 'paused', { value: false });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this === preview ? new DOMRect(0, 0, 240, 135) : new DOMRect(0, 0, 640, 360);
  });
  manager = new VideoSubtitleManager(); manager.open();
  const player = vi.mocked(PlayerSubtitleController).mock.results.find(result => result.value.video.id === 'main')!.value;
  expect(player.open).toHaveBeenCalledOnce();
});

it("replaces inactive offscreen controllers when scrolling a long video feed", async () => {
  document.body.innerHTML = Array.from({ length: 13 }, (_, index) => `<div><video id="video-${index}"></video></div>`).join('');
  const videos = [...document.querySelectorAll('video')];
  let scrolled = false;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = videos.indexOf(this as HTMLVideoElement);
    return new DOMRect(0, scrolled ? index === 12 ? 0 : -1000 : index * 400, 640, 360);
  });
  manager = new VideoSubtitleManager();
  expect(PlayerSubtitleController).toHaveBeenCalledTimes(12);
  expect(vi.mocked(PlayerSubtitleController).mock.calls.some(([video]) => video === videos[12])).toBe(false);
  scrolled = true; window.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(200);
  expect(vi.mocked(PlayerSubtitleController).mock.calls.some(([video]) => video === videos[12])).toBe(true);
  expect(vi.mocked(PlayerSubtitleController).mock.results.slice(0, 12).filter(result => result.value.dispose.mock.calls.length)).toHaveLength(1);
});
