// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerSubtitleController } from "../src/content/video-player";
import { VIDEO_PLATFORMS } from "../src/video/platforms";
import { sendRuntimeRequest } from "../src/content/runtime";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
let controller: PlayerSubtitleController;
let video: HTMLVideoElement;
let track: TextTrack;
let settingsListener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const root = () => document.querySelector("[data-wupage-video]")!.shadowRoot!;
const toggle = () => root().querySelector<HTMLButtonElement>(".toggle")!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", { storage: { onChanged: {
    addListener: (listener: typeof settingsListener) => { settingsListener = listener; }, removeListener: vi.fn()
  } } });
  document.body.innerHTML = '<div class="player" style="position:relative"><video></video></div>';
  video = document.querySelector("video")!;
  track = { kind: "subtitles", label: "English", language: "en", mode: "showing", cues: [
    { startTime: 0, endTime: 4, text: "<i>Hello</i>" }, { startTime: 20, endTime: 24, text: "Later" }
  ] } as unknown as TextTrack;
  Object.defineProperty(video, "textTracks", { configurable: true, value: [track] });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.spyOn(video.parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
    if (request.type === "GET_SETTINGS") return structuredClone(DEFAULT_SETTINGS);
    if (request.type === "TRANSLATE_VIDEO_SUBTITLES") return { translations: request.texts.map(text => text === "Hello" ? "你好" : "稍后"), cached: 0 };
    return null;
  });
  controller = new PlayerSubtitleController(video, video.parentElement!);
});
afterEach(() => {
  controller.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("player subtitle controls", () => {
  it("reveals controls on touch and keeps them visible after the finger leaves", async () => {
    await vi.advanceTimersByTimeAsync(2700);
    const host = document.querySelector('[data-wupage-video]')!;
    const player = video.parentElement!;
    expect(host.hasAttribute('data-controls')).toBe(false);
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      return event;
    };
    video.addEventListener('pointerdown', event => event.stopPropagation());
    video.dispatchEvent(touch('pointerdown'));
    expect(host.hasAttribute('data-controls')).toBe(true);
    player.dispatchEvent(touch('pointerleave'));
    expect(host.hasAttribute('data-controls')).toBe(true);
    await vi.advanceTimersByTimeAsync(2700);
    expect(host.hasAttribute('data-controls')).toBe(false);
  });
  it("follows TED's selected language even when its player keeps the old native track hidden", async () => {
    controller.dispose();
    track.mode = 'hidden';
    const french = { kind: 'subtitles', label: 'French', language: 'fr', mode: 'disabled' } as unknown as TextTrack;
    Object.defineProperty(french, 'cues', { get: () => french.mode === 'disabled' ? null : [{ startTime: 0, endTime: 4, text: 'Bonjour' }] });
    Object.defineProperty(video, 'textTracks', { configurable: true, value: [track, french] });
    const credits = document.createElement('div');
    credits.id = 'subtitles-container'; credits.innerHTML = '<div>English transcript by Translator.</div><div class="whitespace-pre-line">Hello</div>';
    video.parentElement!.append(credits);
    controller = new PlayerSubtitleController(video, video.parentElement!, VIDEO_PLATFORMS.find(platform => platform.id === 'ted'));
    toggle().click(); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Hello');
    credits.firstElementChild!.textContent = 'French translation by Translator. Reviewed by Reviewer.';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Bonjour');
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([r]) => r.type === 'TRANSLATE_VIDEO_SUBTITLES' && r.sourceLang === 'fr' && r.texts[0] === 'Bonjour')).toBe(true);
    french.mode = 'disabled';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(french.mode).toBe('hidden');
    expect(root().querySelector('.source span')?.textContent).toBe('Bonjour');
    const menu = document.createElement('div'); menu.setAttribute('role', 'tooltip');
    menu.innerHTML = '<div role="radiogroup"><button role="radio" aria-checked="true"><span>English</span><span>English</span></button></div>';
    document.body.append(menu); credits.firstElementChild!.textContent = '';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Hello');
    menu.remove();
    credits.firstElementChild!.textContent = 'French translation by Translator.';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Bonjour');
    const source = root().querySelector<HTMLSelectElement>('.track')!;
    source.value = 'native:0'; source.dispatchEvent(new Event('change')); await flush();
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Hello');
    toggle().click(); expect(french.mode).toBe('disabled');
  });
  it("follows a newly loaded hidden native track after the website disables the previous language", async () => {
    const english = track.cues;
    Object.defineProperty(track, 'cues', { configurable: true, get: () => track.mode === 'disabled' ? null : english });
    const french = { kind: 'subtitles', label: 'French', language: 'fr', mode: 'disabled', cues: [{ startTime: 0, endTime: 4, text: 'Bonjour' }] } as unknown as TextTrack;
    Object.defineProperty(video, 'textTracks', { configurable: true, value: [track, french] });
    toggle().click(); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Hello');
    track.mode = 'disabled'; french.mode = 'hidden';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Bonjour');
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([r]) => r.type === 'TRANSLATE_VIDEO_SUBTITLES' && r.sourceLang === 'fr' && r.texts[0] === 'Bonjour')).toBe(true);
    toggle().click(); expect(track.mode).toBe('disabled'); expect(french.mode).toBe('hidden');
  });
  it("follows a different showing native track and restores the website's new selection on stop", async () => {
    const spanish = { kind: 'subtitles', label: 'Spanish', language: 'es', mode: 'disabled', cues: [{ startTime: 0, endTime: 4, text: 'Hola' }] } as unknown as TextTrack;
    Object.defineProperty(video, 'textTracks', { configurable: true, value: [track, spanish] });
    toggle().click(); await flush(); spanish.mode = 'showing';
    await vi.advanceTimersByTimeAsync(240); await flush();
    expect(root().querySelector('.source span')?.textContent).toBe('Hola');
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([r]) => r.type === 'TRANSLATE_VIDEO_SUBTITLES' && r.sourceLang === 'es')).toBe(true);
    toggle().click(); expect(spanish.mode).toBe('showing');
  });
  it("keeps captions and controls visible in a full-page player with a zero-height HTML box", async () => {
    toggle().click(); await flush();
    const before = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    try {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
      vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1280, 0));
      document.dispatchEvent(new Event("fullscreenchange"));
      const host = document.querySelector<HTMLElement>("[data-wupage-video]")!;
      expect(host.parentElement).toBe(document.documentElement);
      expect(host.hidden).toBe(false);
      expect(host.style.getPropertyValue("--wp-layer-height")).toBe("360px");
      expect(root().querySelector(".translation span")?.textContent).toBe("你好");
    } finally {
      if (before) Object.defineProperty(document, "fullscreenElement", before);
      else Reflect.deleteProperty(document, "fullscreenElement");
      document.dispatchEvent(new Event("fullscreenchange"));
    }
    expect(document.querySelector("[data-wupage-video]")?.parentElement).toBe(video.parentElement);
  });
  it("starts in one click and restores native caption mode on stop", async () => {
    await flush();
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toBe(false);
    toggle().click(); await flush();
    expect(track.mode).toBe("hidden");
    expect(root().querySelector(".source span")?.textContent).toBe("Hello");
    expect(root().querySelector(".translation span")?.textContent).toBe("你好");
    expect(root().querySelector<HTMLElement>(".captions")!.hidden).toBe(false);
    toggle().click(); expect(track.mode).toBe("showing");
    expect(root().querySelector<HTMLElement>(".captions")!.hidden).toBe(true);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "CANCEL_VIDEO_SUBTITLES")).toBe(true);
  });
  it("seeks without showing the old subtitle and reuses completed translations", async () => {
    toggle().click(); await flush(); video.currentTime = 20;
    await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector(".translation span")?.textContent).toBe("稍后");
    video.currentTime = 8; await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector<HTMLElement>(".captions")!.hidden).toBe(true);
    video.currentTime = 0; await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector(".translation span")?.textContent).toBe("你好");
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(2);
  });
  it("a stop while settings are loading cannot restart after the response", async () => {
    await flush();
    let finish!: (value: ExtensionSettings) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    toggle().click(); toggle().click(); finish(DEFAULT_SETTINGS); await flush();
    expect(track.mode).toBe("showing"); expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toBe(false);
  });
  it("applies language changes to a new translation session and changes appearance without retranslating", async () => {
    toggle().click(); await flush();
    const changed = { ...DEFAULT_SETTINGS, targetLang: "ja" };
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? changed
      : request.type === "TRANSLATE_VIDEO_SUBTITLES" ? { translations: ["こんにちは"], cached: 0 } : null);
    settingsListener({ [SETTINGS_KEY]: { newValue: changed } }, "local"); await flush();
    expect(root().querySelector(".translation span")?.textContent).toBe("こんにちは");
    const count = vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES").length;
    settingsListener({ [SETTINGS_KEY]: { newValue: { ...changed, videoTranslation: { showOriginal: false, fontSize: 26, background: "none", preferredSource: "auto", enabledSites: [] } } } }, "local");
    expect(root().querySelector(".source span")?.textContent).toBe("");
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(count);
  });
  it("keeps detailed controls collapsed and provides keyboard and explicit stop", async () => {
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);
    root().querySelector<HTMLButtonElement>(".settings")!.click();
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
    root().querySelector(".panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);
    controller.dispose(); expect(document.querySelector("[data-wupage-video]")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("explains an empty native track and picks up tracks added after starting", async () => {
    Object.defineProperty(video, "textTracks", { configurable: true, value: [] });
    toggle().click(); await flush();
    Object.defineProperty(video, "textTracks", { configurable: true, value: [track] });
    Object.defineProperty(track, "cues", { configurable: true, value: [] });
    await vi.advanceTimersByTimeAsync(2700);
    expect(root().querySelector(".label")?.textContent).toBe("等待原字幕");
    expect(root().querySelector(".status")?.textContent).toContain("原字幕尚未就绪");
    Object.defineProperty(track, "cues", { configurable: true, value: [{ startTime: 0, endTime: 4, text: "Hello" }] });
    await vi.advanceTimersByTimeAsync(120); await flush();
    expect(root().querySelector(".translation span")?.textContent).toBe("你好");
  });
  it("does not apply an old save acknowledgement over newer storage settings", async () => {
    await flush();
    let finish!: () => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return DEFAULT_SETTINGS;
      if (request.type === "SAVE_SETTINGS") return new Promise<void>(resolve => { finish = resolve; });
      return null;
    });
    const target = root().querySelector<HTMLSelectElement>(".target")!;
    target.value = "ja"; target.dispatchEvent(new Event("change")); await flush();
    settingsListener({ [SETTINGS_KEY]: { newValue: { ...DEFAULT_SETTINGS, targetLang: "de" } } }, "local");
    finish(); await flush();
    expect(target.value).toBe("de");
  });
  it("uses text nodes for service output", async () => {
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? DEFAULT_SETTINGS
      : request.type === "TRANSLATE_VIDEO_SUBTITLES" ? { translations: ['<img src=x onerror="alert(1)">'], cached: 0 } : null);
    toggle().click(); await flush();
    expect(root().querySelector(".translation span")?.textContent).toContain("<img");
    expect(root().querySelector("img")).toBeNull();
  });
  it.each([
    ["API key is required.", "当前服务需要 API 密钥"],
    ["Extension context invalidated.", "请刷新视频页后继续"],
    ["A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received", "请点击「重试读取」"]
  ])("explains an unavailable service or extension and opens its controls only once: %s", async (error, expected) => {
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return DEFAULT_SETTINGS;
      if (request.type === "TRANSLATE_VIDEO_SUBTITLES") throw new Error(error);
      return null;
    });
    toggle().click(); await flush();
    expect(root().querySelector(".status")?.textContent).toContain(expected);
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
    root().querySelector<HTMLButtonElement>(".close")!.click();
    await vi.advanceTimersByTimeAsync(1200);
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(1);
  });
});
