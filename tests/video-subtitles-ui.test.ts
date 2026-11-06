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
  it("follows current source while a translation is stalled and never paints the expired sentence", async () => {
    let finish!: (value: { translations: string[]; cached: number }) => void;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => request.type === "TRANSLATE_VIDEO_SUBTITLES"
      ? new Promise(resolve => { finish = resolve; }) : runtime(request));
    toggle().click(); await flush();
    expect(root().querySelector(".source span")?.textContent).toBe("Hello");
    expect(root().querySelector<HTMLElement>(".captions")!.hidden).toBe(false);
    video.currentTime = 20; await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector(".source span")?.textContent).toBe("Later");
    expect(root().querySelector(".translation span")?.textContent).toBe("");
    finish({ translations: ["过期的你好", "稍后"], cached: 0 }); await flush();
    expect(root().querySelector(".translation span")?.textContent).not.toContain("过期");
  });

  it("pages a long translated sentence by media time, keeps pause stable, and reuses pages after seeking", async () => {
    Object.defineProperty(track, "cues", { value: [{ startTime: 0, endTime: 12, text: "A long spoken explanation without punctuation ".repeat(7) }] });
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "GET_SETTINGS" ? structuredClone(DEFAULT_SETTINGS)
      : request.type === "TRANSLATE_VIDEO_SUBTITLES" ? { translations: request.texts.map(() => "这是一段需要分屏显示的长字幕不能一次挡住画面也不能丢失内容".repeat(8)), cached: 0 } : null);
    toggle().click(); await flush();
    const first = root().querySelector(".translation span")!.textContent;
    expect(first!.split("\n").length).toBeLessThanOrEqual(2);
    video.currentTime = 10; await vi.advanceTimersByTimeAsync(120);
    const later = root().querySelector(".translation span")!.textContent;
    expect(later).not.toBe(first);
    await vi.advanceTimersByTimeAsync(2400);
    expect(root().querySelector(".translation span")!.textContent).toBe(later);
    video.currentTime = 0; await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector(".translation span")!.textContent).toBe(first);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(1);
  });

  it("releases native caption suppression when disabled and permits later native CC changes", async () => {
    const captions = document.createElement("div"); captions.className = "vjs-text-track-display";
    video.parentElement!.append(captions);
    toggle().click(); await flush();
    const style = document.querySelector("[data-wupage-video-style]")!;
    expect(captions.hasAttribute("data-wupage-video-native")).toBe(true);
    expect(style.textContent).toContain("opacity: 0");
    settingsListener({ [SETTINGS_KEY]: { newValue: { ...DEFAULT_SETTINGS, videoTranslation: { ...DEFAULT_SETTINGS.videoTranslation!, enabled: false } } } }, "local");
    expect(track.mode).toBe("showing");
    expect(captions.hasAttribute("data-wupage-video-native")).toBe(false);
    expect(video.hasAttribute("data-wupage-video-cues")).toBe(false);
    expect(style.textContent).toBe("");
    track.mode = "disabled"; await vi.advanceTimersByTimeAsync(500);
    expect(track.mode).toBe("disabled");
    track.mode = "showing"; await vi.advanceTimersByTimeAsync(500);
    expect(track.mode).toBe("showing");
  });

  it("saves independent language typography and order without translating again", async () => {
    let stored = structuredClone(DEFAULT_SETTINGS);
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => {
      if (request.type === "GET_SETTINGS") return Promise.resolve(structuredClone(stored));
      if (request.type === "SAVE_SETTINGS") { stored = structuredClone(request.settings); return Promise.resolve(null); }
      return runtime(request);
    });
    toggle().click(); await flush();
    const requests = vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES").length;
    const change = async (selector: string, value: string) => {
      const input = root().querySelector<HTMLSelectElement>(selector)!; input.value = value;
      input.dispatchEvent(new Event("change")); await flush();
    };
    await change(".order", "below");
    await change(".source-size", "18");
    await change(".source-family", "serif");
    await change(".translation-size", "32");
    await change(".translation-weight", "700");
    const saved = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request).filter(request => request.type === "SAVE_SETTINGS").at(-1)!;
    expect(saved.settings.videoTranslation).toMatchObject({ originalPosition: "below", sourceStyle: { fontSize: 18, fontFamily: "serif" }, translationStyle: { fontSize: 32, fontWeight: 700 } });
    expect(document.querySelector("[data-wupage-video]")!.hasAttribute("data-original-below")).toBe(true);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(requests);
  });

  it("shows the display mode after the first result and keeps it through subtitle gaps", async () => {
    let finish!: () => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return structuredClone(DEFAULT_SETTINGS);
      if (request.type === "TRANSLATE_VIDEO_SUBTITLES") return new Promise(resolve => {
        finish = () => resolve({ translations: request.texts.map(text => text === "Hello" ? "你好" : "稍后"), cached: 0 });
      });
      return null;
    });
    expect(toggle().textContent).toBe("译");
    expect(toggle().getAttribute("aria-label")).toBe("翻译视频字幕");
    toggle().click();
    expect(toggle().textContent).toBe("译");
    expect(toggle().title).toContain("正在读取字幕");
    await flush();
    expect(toggle().textContent).toBe("译");
    finish(); await flush();
    expect(toggle().textContent).toBe("双");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().title).toContain("双语字幕已开启");
    video.currentTime = 8; await vi.advanceTimersByTimeAsync(120);
    expect(root().querySelector<HTMLElement>(".captions")!.hidden).toBe(true);
    expect(toggle().textContent).toBe("双");
    toggle().click();
    expect(toggle().textContent).toBe("译");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });
  it.each([
    ["youtube", "ytp-right-controls", "ytp-subtitles-button"],
    ["bilibili", "bpx-player-control-bottom-right", "bpx-player-ctrl-subtitle"],
    ["vimeo", "ControlBarButtonsAndMenus_module_collapsibleContent__fixture", "cc"],
    ["udemy", "_control-bar_fixture_28", "_control-captions_fixture_125"]
  ])("docks %s controls separately from captions and recovers when the native bar is rebuilt", async (site, group, anchor) => {
    controller.dispose();
    const player = video.parentElement!;
    const bar = document.createElement("div"); bar.className = "ytp-chrome-bottom";
    bar.innerHTML = `<div class="${group}"><button class="native ${anchor}">Settings</button></div>`;
    player.append(bar);
    const nativeClick = vi.fn(); player.addEventListener("click", nativeClick);
    controller = new PlayerSubtitleController(video, player, VIDEO_PLATFORMS.find(platform => platform.id === site));
    await flush();
    const dock = () => document.querySelector<HTMLElement>("[data-wupage-video-toolbar]")!;
    const dockToggle = () => dock().shadowRoot!.querySelector<HTMLButtonElement>(".toggle")!;
    expect(dock().parentElement?.className).toBe(group);
    expect(dock().nextElementSibling).toBe(bar.querySelector(".native"));
    expect(root().querySelector(".toolbar")).toBeNull();
    dockToggle().click(); await flush();
    expect(root().querySelector(".translation span")?.textContent).toBe("你好");
    const settings = dock().shadowRoot!.querySelector<HTMLButtonElement>(".settings")!;
    settings.click();
    settings.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
    settings.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().querySelector<HTMLElement>(".panel")!.hidden).toBe(true);
    expect(nativeClick).not.toHaveBeenCalled();
    bar.style.opacity = "0"; await flush();
    expect(dock().inert).toBe(true);
    expect(dock().hasAttribute("data-native-hidden")).toBe(true);
    bar.style.opacity = "1"; await flush(); expect(dock().inert).toBe(false);
    bar.innerHTML = `<div class="${group}"><button class="native ${anchor}">New settings</button></div>`;
    await flush();
    expect(document.querySelectorAll("[data-wupage-video-toolbar]")).toHaveLength(1);
    expect(dockToggle().getAttribute("aria-pressed")).toBe("true");
    bar.remove(); await flush();
    expect(document.querySelector("[data-wupage-video-toolbar]")).toBeNull();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    player.append(bar); await flush();
    dockToggle().click(); expect(track.mode).toBe("showing");
    bar.querySelector<HTMLButtonElement>(".native")!.click(); expect(nativeClick).toHaveBeenCalledOnce();
    controller.dispose();
    expect(document.querySelector("[data-wupage-video-toolbar]")).toBeNull();
    player.removeEventListener("click", nativeClick);
  });
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
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(1);
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
      : request.type === "TRANSLATE_VIDEO_SUBTITLES" ? { translations: request.texts.map(() => "こんにちは"), cached: 0 } : null);
    settingsListener({ [SETTINGS_KEY]: { newValue: changed } }, "local"); await flush();
    expect(root().querySelector(".translation span")?.textContent).toBe("こんにちは");
    const count = vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES").length;
    settingsListener({ [SETTINGS_KEY]: { newValue: { ...changed, videoTranslation: { showOriginal: false, fontSize: 26, background: "none", preferredSource: "auto", enabledSites: [] } } } }, "local");
    expect(root().querySelector(".source span")?.textContent).toBe("");
    expect(toggle().textContent).toBe("单");
    expect(toggle().title).toContain("仅译文已开启");
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
    expect(toggle().textContent).toBe("译");
    expect(toggle().getAttribute("aria-label")).toContain("等待原字幕");
    expect(root().querySelector(".status")?.textContent).toContain("原字幕尚未就绪");
    Object.defineProperty(track, "cues", { configurable: true, value: [{ startTime: 0, endTime: 4, text: "Hello" }] });
    await vi.advanceTimersByTimeAsync(120); await flush();
    expect(root().querySelector(".translation span")?.textContent).toBe("你好");
  });
  it("saves layout for the current hostname while preserving other sites and cached translations", async () => {
    await flush();
    const preferences = { enabled: true, showOriginal: true, fontSize: 22 as const, background: "soft" as const,
      preferredSource: "auto", enabledSites: [], siteLayouts: [{ id: "other.example", x: 50, bottom: 20, width: 80, fontSize: 24 }] };
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return { ...DEFAULT_SETTINGS, videoTranslation: preferences };
      if (request.type === "TRANSLATE_VIDEO_SUBTITLES") return { translations: request.texts.map(text => text === "Hello" ? "你好" : "稍后"), cached: 0 };
      return null;
    });
    settingsListener({ [SETTINGS_KEY]: { newValue: { ...DEFAULT_SETTINGS, videoTranslation: preferences } } }, "local");
    toggle().click(); await flush();
    const translations = vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES").length;
    root().querySelector<HTMLButtonElement>(".layout-open")!.click();
    const width = root().querySelector<HTMLInputElement>(".layout-width")!;
    width.value = "65"; width.dispatchEvent(new Event("input"));
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    root().querySelector<HTMLButtonElement>(".layout-done")!.click(); await flush();
    const save = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request).find(request => request.type === "SAVE_SETTINGS");
    expect(save?.type === "SAVE_SETTINGS" && save.settings.videoTranslation?.siteLayouts).toEqual([
      preferences.siteLayouts[0], { id: location.hostname, x: 50, bottom: 10, width: 65, fontSize: 22 }
    ]);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_VIDEO_SUBTITLES")).toHaveLength(translations);
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
      : request.type === "TRANSLATE_VIDEO_SUBTITLES" ? { translations: request.texts.map(() => '<img src=x onerror="alert(1)">'), cached: 0 } : null);
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
