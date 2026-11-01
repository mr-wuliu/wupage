// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { initAutoTranslation } from "../src/content/auto-translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { AutoTranslationSettings, ExtensionSettings } from "../src/shared/types";

describe("automatic page translation", () => {
  let settings: ExtensionSettings;
  let active: boolean;
  let notify: (event?: "stopped") => void;
  let storage: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  let start: Mock<(settings: ExtensionSettings) => Promise<void>>;
  let stop: Mock<() => void>;
  let detect: Mock<(text: string) => Promise<{ languages: Array<{ language: string; percentage: number }> }>>;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("location", new URL("https://example.com/docs/article"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.documentElement.lang = "en";
    document.body.innerHTML = '<main><p>This is an English article with enough visible text to identify its language reliably.</p></main>';
    settings = structuredClone(DEFAULT_SETTINGS);
    active = false;
    notify = () => {};
    start = vi.fn(async () => { active = true; notify(); });
    stop = vi.fn(() => { active = false; notify(); });
    detect = vi.fn(async () => ({ languages: [{ language: "en", percentage: 99 }] }));
    vi.stubGlobal("chrome", { storage: { onChanged: {
      addListener: (listener: typeof storage) => { storage = listener; }, removeListener: vi.fn()
    } } });
  });
  afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  function mount(config: Partial<AutoTranslationSettings>, loadSettings = async () => settings): void {
    settings.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: [], customSites: [], ...config };
    dispose = initAutoTranslation({ loadSettings, start, stop, active: () => active,
      subscribe: listener => { notify = listener; return () => {}; }, detectLanguage: detect });
  }
  async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(400); }

  it("does nothing when disabled or no rule matches", async () => {
    mount({ enabled: false, presetSites: ["github.com"] }); await settle();
    expect(start).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled();
    storage({ "wupage.settings": { newValue: { ...settings, autoTranslation: { ...settings.autoTranslation, enabled: true } } } }, "local");
    await settle(); expect(start).not.toHaveBeenCalled();
  });

  it("starts once for a matching site and honors manual restoration", async () => {
    mount({ customSites: [{ id: "site", pattern: "example.com/docs/*", enabled: true }] });
    await settle(); expect(start).toHaveBeenCalledTimes(1); expect(detect).not.toHaveBeenCalled();
    document.querySelector("main")!.append(document.createElement("p")); await settle();
    expect(start).toHaveBeenCalledTimes(1);
    active = false; notify();
    document.querySelector("p")!.textContent += " A later update."; await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "zh-CN", "und"])("uses locally detected language %s for the non-target rule", async language => {
    detect.mockResolvedValue({ languages: [{ language, percentage: 99 }] });
    mount({ nonTargetLanguage: true }); await settle();
    expect(start).toHaveBeenCalledTimes(language === "en" ? 1 : 0);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("skips uncertain language and ignores extension UI and hidden content", async () => {
    document.body.innerHTML = '<div id="wupage-floating-menu">A very long English interface that must not decide the page language.</div><main><p hidden>Hidden English text that must not count towards language detection.</p><p>短文</p></main>';
    mount({ nonTargetLanguage: true }); await settle();
    expect(detect).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    detect.mockResolvedValue({ languages: [{ language: "en", percentage: 30 }] });
    document.querySelector("main")!.innerHTML = '<p>A visible article with enough English text, but its detected language is uncertain.</p>';
    await settle(); expect(start).not.toHaveBeenCalled();
  });

  it("waits for dynamically loaded content without requiring a reload", async () => {
    document.body.innerHTML = '<main></main>';
    mount({ nonTargetLanguage: true }); await settle(); expect(start).not.toHaveBeenCalled();
    document.querySelector("main")!.innerHTML = '<p>This article was added later and contains enough English text to translate automatically.</p>';
    await settle(); expect(start).toHaveBeenCalledTimes(1);
  });

  it("samples visible content instead of a longer hidden article", async () => {
    document.body.insertAdjacentHTML("beforeend", `<article style="display:none">${"Hidden template text. ".repeat(100)}</article>`);
    mount({ nonTargetLanguage: true }); await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0][0]).toContain("English article");
    expect(detect.mock.calls[0][0]).not.toContain("Hidden template");
  });

  it("discards a stale language result after navigation", async () => {
    let release!: (value: { languages: Array<{ language: string; percentage: number }> }) => void;
    detect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mount({ nonTargetLanguage: true }); await settle();
    vi.stubGlobal("location", new URL("https://example.com/chinese"));
    detect.mockResolvedValue({ languages: [{ language: "zh", percentage: 99 }] });
    document.querySelector("p")!.textContent = "这是新的中文页面，页面内容发生了变化，之前英文页面的识别结果不应再触发翻译。";
    await settle(); release({ languages: [{ language: "en", percentage: 99 }] });
    await settle(); expect(start).not.toHaveBeenCalled();
  });

  it("stops an automatically started session when navigating outside its path rule", async () => {
    mount({ customSites: [{ id: "site", pattern: "example.com/docs/*", enabled: true }] });
    await settle(); expect(start).toHaveBeenCalledTimes(1);
    vi.stubGlobal("location", new URL("https://example.com/private"));
    document.querySelector("p")!.textContent = "An unrelated page outside the allowed path.";
    await settle(); expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    vi.stubGlobal("location", new URL("https://example.com/docs/next"));
    document.querySelector("p")!.textContent = "A new article inside the selected path.";
    await settle(); expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps the live observer when switching posts inside the selected site", async () => {
    mount({ customSites: [{ id: "site", pattern: "example.com/docs/*", enabled: true }] });
    await settle();
    vi.stubGlobal("location", new URL("https://example.com/docs/next"));
    notify(); // Background route notification can precede the new post's DOM.
    document.querySelector("main")!.innerHTML = "<p>A newly loaded post and replies.</p>";
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("waits for the background stop before evaluating a new page's language", async () => {
    let finish!: () => void;
    stop.mockImplementation(() => {
      active = false; notify("stopped");
      return new Promise<void>(resolve => { finish = () => { notify(); resolve(); }; });
    });
    mount({ nonTargetLanguage: true }); await settle();
    vi.stubGlobal("location", new URL("https://example.com/next"));
    document.querySelector("p")!.textContent = "A different English post with enough visible text to trigger language detection again.";
    await settle();
    expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    finish(); await settle();
    expect(start).toHaveBeenCalledTimes(2);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("honors a user's stop while an automatic route transition is pending", async () => {
    let finish!: () => void;
    stop.mockImplementation(() => {
      active = false; notify("stopped");
      return new Promise<void>(resolve => { finish = resolve; });
    });
    mount({ nonTargetLanguage: true }); await settle();
    vi.stubGlobal("location", new URL("https://example.com/next"));
    document.querySelector("p")!.textContent += " New post.";
    await settle();
    notify("stopped"); // A separate restore action, not our synchronous stop.
    finish(); await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not translate a target-language page after the previous route stops", async () => {
    mount({ nonTargetLanguage: true }); await settle();
    detect.mockResolvedValue({ languages: [{ language: "zh", percentage: 99 }] });
    vi.stubGlobal("location", new URL("https://example.com/chinese"));
    document.querySelector("p")!.textContent = "这是一个新的中文帖子，内容已经使用目标语言，不能沿用上一条英文帖子的语言判断，也不应该向翻译服务发送重复翻译请求。";
    await settle();
    expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("invalidates pending detection when automatic translation is disabled", async () => {
    let release!: (value: { languages: Array<{ language: string; percentage: number }> }) => void;
    detect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mount({ nonTargetLanguage: true }); await settle();
    storage({ "wupage.settings": { newValue: { ...settings, autoTranslation: { ...settings.autoTranslation, enabled: false } } } }, "local");
    release({ languages: [{ language: "en", percentage: 99 }] }); await settle();
    expect(start).not.toHaveBeenCalled();
  });

  it("waits until a hidden page becomes visible after pending language detection", async () => {
    let release!: (value: { languages: Array<{ language: string; percentage: number }> }) => void;
    detect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mount({ nonTargetLanguage: true }); await settle();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    release({ languages: [{ language: "en", percentage: 99 }] }); await settle();
    expect(start).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange")); await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved target when the initial settings response arrives late", async () => {
    let release!: (value: ExtensionSettings) => void;
    const initial = new Promise<ExtensionSettings>(resolve => { release = resolve; });
    mount({ customSites: [{ id: "site", pattern: "example.com/docs/*", enabled: true }] }, () => initial);
    const previous = structuredClone(settings);
    settings = { ...settings, targetLang: "ja" };
    storage({ "wupage.settings": { newValue: settings } }, "local");
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ targetLang: "ja" }));
    release(previous);
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps an explicit stop while the initial settings read is pending", async () => {
    let release!: (value: ExtensionSettings) => void;
    const initial = new Promise<ExtensionSettings>(resolve => { release = resolve; });
    mount({ customSites: [{ id: "site", pattern: "example.com/docs/*", enabled: true }] }, () => initial);
    notify("stopped");
    release(settings);
    await settle();
    expect(start).not.toHaveBeenCalled();
    storage({ "wupage.settings": { newValue: { ...settings, autoTranslation: { ...settings.autoTranslation, enabled: false } } } }, "local");
    storage({ "wupage.settings": { newValue: settings } }, "local");
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not take over a manual translation", async () => {
    active = true;
    mount({ nonTargetLanguage: true }); await settle();
    expect(start).not.toHaveBeenCalled();
    vi.stubGlobal("location", new URL("https://example.com/other"));
    document.querySelector("p")!.textContent += " Changed."; await settle();
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it("gives exclusions priority over site and language rules and resumes after allowing the site", async () => {
    mount({ nonTargetLanguage: true, customSites: [{ id: "site", pattern: "example.com", enabled: true }], excludedSites: ["example.com"] });
    await settle();
    expect(start).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled();
    storage({ "wupage.settings": { newValue: { ...settings, autoTranslation: { ...settings.autoTranslation, excludedSites: [] } } } }, "local");
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    storage({ "wupage.settings": { newValue: settings } }, "local");
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    document.querySelector("p")!.textContent += " Updated content.";
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("discards pending language detection when the current website is excluded", async () => {
    let release!: (value: { languages: Array<{ language: string; percentage: number }> }) => void;
    detect.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mount({ nonTargetLanguage: true }); await settle();
    storage({ "wupage.settings": { newValue: { ...settings, autoTranslation: { ...settings.autoTranslation, excludedSites: ["example.com"] } } } }, "local");
    release({ languages: [{ language: "en", percentage: 99 }] });
    await settle();
    expect(start).not.toHaveBeenCalled();
  });
});
