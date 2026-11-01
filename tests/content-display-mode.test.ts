// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { initFloatingBall } from "../src/content/floating";
import { initImageTranslation } from "../src/content/image-translation";
import { setupAppearance } from "../src/shared/appearance-runtime";

const { updateSettings, getPageState, hasTranslations } = vi.hoisted(() => ({
  updateSettings: vi.fn(), getPageState: vi.fn(), hasTranslations: vi.fn()
}));
vi.mock("../src/content/page-translation", () => ({
  hidePageTranslation: vi.fn(), startPageTranslation: vi.fn(), loadPageTranslationSettings: vi.fn(),
  updatePageTranslationSettings: updateSettings,
  getPageTranslationState: getPageState
}));
vi.mock("../src/content/dom", () => ({ hasPageTranslations: hasTranslations }));
vi.mock("../src/content/floating", () => ({
  initFloatingBall: vi.fn(), getFloatingBallEnabled: vi.fn(), getParagraphMode: vi.fn(),
  openDebugPanel: vi.fn(), setFloatingBallEnabled: vi.fn(), setParagraphMode: vi.fn(), refreshTranslationState: vi.fn()
}));
vi.mock("../src/content/image-translation", () => ({ initImageTranslation: vi.fn(), translateContextImage: vi.fn() }));
vi.mock("../src/content/styles", () => ({ injectContentStyles: vi.fn() }));
vi.mock("../src/content/auto-translation", () => ({ initAutoTranslation: vi.fn() }));
vi.mock("../src/content/selection-translation", () => ({ initSelectionTranslation: vi.fn() }));
vi.mock("../src/content/keyboard-shortcuts", () => ({ initKeyboardShortcuts: vi.fn() }));
vi.mock("../src/content/video-subtitles", () => ({ initVideoSubtitles: vi.fn(), openVideoSubtitles: vi.fn() }));
vi.mock("../src/shared/appearance-runtime", () => ({ setupAppearance: vi.fn(() => ({ update: vi.fn() })) }));
vi.mock("../src/content/runtime", () => ({ addRuntimeMessageListener: vi.fn(), sendRuntimeRequest: vi.fn(async () => undefined) }));

describe("saved page settings updates", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

  it.each(["image/svg+xml", "application/xml"] as const)("does not initialize page UI or settings observers in %s", async contentType => {
    const xml = new DOMParser().parseFromString(contentType === "image/svg+xml" ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : '<document/>', contentType);
    vi.stubGlobal("document", xml);
    const addListener = vi.fn();
    vi.stubGlobal("chrome", { storage: { onChanged: { addListener } } });
    const { addRuntimeMessageListener } = await import("../src/content/runtime");
    await import("../src/content/index");
    expect(initFloatingBall).not.toHaveBeenCalled();
    expect(initImageTranslation).not.toHaveBeenCalled();
    expect(setupAppearance).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    const response = vi.fn();
    vi.mocked(addRuntimeMessageListener).mock.calls[0][0]({ type: "TRANSLATE_PAGE" }, {} as chrome.runtime.MessageSender, response);
    expect(response).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("不支持翻译") });
    expect(xml.documentElement.childElementCount).toBe(0);
  });

  it("forwards saved languages and display modes to the page session", async () => {
    let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { onChanged: {
      addListener: (callback: typeof listener) => { listener = callback; }
    } } });
    await import("../src/content/index");
    for (const translationDisplayMode of ["replace", "bilingual-accent", "bilingual"] as const) {
      const settings = { ...DEFAULT_SETTINGS, translationDisplayMode };
      listener({ [SETTINGS_KEY]: { newValue: settings } }, "local");
      expect(updateSettings).toHaveBeenLastCalledWith(settings);
    }
    const settings = { ...DEFAULT_SETTINGS, targetLang: "ja" };
    listener({ [SETTINGS_KEY]: { oldValue: DEFAULT_SETTINGS, newValue: settings } }, "local");
    expect(updateSettings).toHaveBeenLastCalledWith(settings);
    listener({ [SETTINGS_KEY]: { newValue: settings } }, "sync");
    listener({ "wupage.floating.position": { newValue: { left: 100, top: 100 } } }, "local");
    listener({ [SETTINGS_KEY]: { newValue: undefined } }, "local");
    expect(updateSettings).toHaveBeenCalledTimes(4);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { active: true, rendered: false, translated: true },
    { active: true, rendered: true, translated: true },
    { active: false, rendered: true, translated: true },
    { active: false, rendered: false, translated: false }
  ])("reports page mode consistently for active=$active and rendered=$rendered", async ({ active, rendered, translated }) => {
    vi.stubGlobal("chrome", { storage: { onChanged: { addListener: vi.fn() } } });
    getPageState.mockReturnValue({ active });
    hasTranslations.mockReturnValue(rendered);
    const { addRuntimeMessageListener } = await import("../src/content/runtime");
    await import("../src/content/index");
    const listener = vi.mocked(addRuntimeMessageListener).mock.calls[0][0];
    const response = vi.fn();
    listener({ type: "GET_TRANSLATION_STATE" }, {} as chrome.runtime.MessageSender, response);
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: true, data: { translated } }));
  });
});
