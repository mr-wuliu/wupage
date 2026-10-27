import { afterEach, describe, expect, it, vi } from "vitest";

const { setMode, getPageState, hasTranslations } = vi.hoisted(() => ({
  setMode: vi.fn(), getPageState: vi.fn(), hasTranslations: vi.fn()
}));
vi.mock("../src/content/page-translation", () => ({
  hidePageTranslation: vi.fn(), startPageTranslation: vi.fn(), setPageTranslationDisplayMode: setMode,
  getPageTranslationState: getPageState
}));
vi.mock("../src/content/dom", () => ({ hasPageTranslations: hasTranslations }));
vi.mock("../src/content/floating", () => ({
  initFloatingBall: vi.fn(), getFloatingBallEnabled: vi.fn(), getParagraphMode: vi.fn(),
  openDebugPanel: vi.fn(), setFloatingBallEnabled: vi.fn(), setParagraphMode: vi.fn()
}));
vi.mock("../src/content/image-translation", () => ({ initImageTranslation: vi.fn(), translateContextImage: vi.fn() }));
vi.mock("../src/content/styles", () => ({ injectContentStyles: vi.fn() }));
vi.mock("../src/content/selection-translation", () => ({ initSelectionTranslation: vi.fn() }));
vi.mock("../src/content/runtime", () => ({ addRuntimeMessageListener: vi.fn(), sendRuntimeRequest: vi.fn() }));

describe("saved display mode updates", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

  it("applies local settings changes to the content page without requesting translation", async () => {
    let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { onChanged: {
      addListener: (callback: typeof listener) => { listener = callback; }
    } } });
    await import("../src/content/index");
    for (const mode of ["replace", "bilingual-accent", "bilingual"]) {
      listener({ "wupage.settings": { oldValue: { translationDisplayMode: "previous" }, newValue: { translationDisplayMode: mode } } }, "local");
      expect(setMode).toHaveBeenLastCalledWith(mode);
    }
    expect(setMode).toHaveBeenCalledTimes(3);
    listener({ "wupage.settings": { oldValue: { translationDisplayMode: "bilingual" }, newValue: { translationDisplayMode: "bilingual", targetLang: "ja" } } }, "local");
    listener({ "wupage.settings": { newValue: { translationDisplayMode: "invalid" } } }, "local");
    listener({ "wupage.settings": { newValue: { translationDisplayMode: "replace" } } }, "sync");
    listener({ "wupage.settings": { newValue: undefined } }, "local");
    expect(setMode).toHaveBeenCalledTimes(3);
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
