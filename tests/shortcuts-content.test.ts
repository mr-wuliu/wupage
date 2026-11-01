// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(), hasTranslations: vi.fn(), hide: vi.fn(), start: vi.fn(),
  paragraph: vi.fn(), setParagraph: vi.fn(), refresh: vi.fn(), setMode: vi.fn(), send: vi.fn(), selection: vi.fn()
}));
vi.mock("../src/content/page-translation", () => ({ getPageTranslationState: mocks.getState,
  hidePageTranslation: mocks.hide, startPageTranslation: mocks.start, setPageTranslationDisplayMode: mocks.setMode }));
vi.mock("../src/content/dom", () => ({ hasPageTranslations: mocks.hasTranslations }));
vi.mock("../src/content/floating", () => ({ getParagraphMode: mocks.paragraph, setParagraphMode: mocks.setParagraph, refreshTranslationState: mocks.refresh }));
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: mocks.send }));
vi.mock("../src/content/paragraph-shortcut", () => ({ translateShortcutParagraphs: mocks.selection }));

let settings: ExtensionSettings;
let active: boolean;
let execute: typeof import("../src/content/shortcuts").executeTranslationShortcut;
const notice = () => document.getElementById("wupage-shortcut-notice")?.shadowRoot?.textContent;
beforeEach(async () => {
  vi.resetModules();
  settings = structuredClone(DEFAULT_SETTINGS); active = false;
  mocks.getState.mockImplementation(() => ({ active }));
  mocks.hide.mockImplementation(() => { active = false; });
  mocks.start.mockImplementation(() => { active = true; return Promise.resolve({ translated: 2, remaining: 0, failed: 0 }); });
  mocks.send.mockImplementation(async (request: RuntimeRequest) => {
    if (request.type === "GET_SETTINGS") return structuredClone(settings);
    if (request.type === "SAVE_SETTINGS") settings = request.settings;
  });
  execute = (await import("../src/content/shortcuts")).executeTranslationShortcut;
});
afterEach(() => { vi.clearAllTimers(); document.documentElement.querySelector("#wupage-shortcut-notice")?.remove(); vi.resetAllMocks(); });

describe("translation shortcut actions", () => {
  it("toggles page translation and reuses the existing translation engine", async () => {
    await execute("toggle-page-translation");
    expect(mocks.start).toHaveBeenCalledWith(settings);
    expect(notice()).toContain("已翻译 2 段");
    await execute("toggle-page-translation");
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(notice()).toContain("恢复原文");
  });
  it("cancels before settings finish loading without starting a late translation", async () => {
    let finish!: (settings: ExtensionSettings) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = execute("toggle-page-translation");
    await execute("toggle-page-translation");
    finish(settings); await pending;
    expect(mocks.start).not.toHaveBeenCalled(); expect(notice()).toContain("恢复原文");
  });
  it("explains an empty viewport without reporting a successful zero-paragraph translation", async () => {
    mocks.start.mockImplementationOnce(async () => { active = true; return { translated: 0, failed: 0, remaining: 0 }; });
    await execute("toggle-page-translation");
    expect(notice()).toContain("暂无可翻译内容");
    expect(notice()).not.toContain("已翻译 0 段");
  });
  it("reports pending frame work before any paragraphs finish", async () => {
    mocks.start.mockImplementationOnce(async () => { active = true; return { translated: 0, failed: 0, remaining: 0 }; });
    mocks.getState.mockImplementation(() => ({ active, pending: active ? 2 : 0 }));
    await execute("toggle-page-translation");
    expect(notice()).toContain("正在翻译当前区域");
    expect(notice()).not.toContain("已翻译 0 段");
  });
  it("does not announce a cancelled scan as successful when another session is active", async () => {
    mocks.start.mockImplementationOnce(async () => { active = true; return { translated: 0, failed: 0, remaining: 0, cancelled: true }; });
    await execute("toggle-page-translation");
    expect(notice()).not.toContain("已翻译 0 段");
    expect(notice()).not.toContain("暂无可翻译内容");
  });
  it("shows session errors even when no paragraph failure count is available", async () => {
    mocks.start.mockImplementationOnce(async () => { active = true; return { translated: 0, failed: 0, remaining: 0, error: "Document could not start" }; });
    await execute("toggle-page-translation");
    expect(notice()).toContain("Document could not start");
    expect(notice()).not.toContain("已翻译 0 段");
  });
  it("stops in-flight translation and ignores its late result", async () => {
    let finish!: (value: unknown) => void;
    mocks.start.mockImplementationOnce(() => { active = true; return new Promise(resolve => { finish = resolve; }); });
    const pending = execute("toggle-page-translation");
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await execute("toggle-page-translation");
    finish({ translated: 99, failed: 0, remaining: 0 }); await pending;
    expect(notice()).toContain("恢复原文"); expect(notice()).not.toContain("99");
  });
  it("clears standalone paragraph translations on the first press", async () => {
    mocks.hasTranslations.mockReturnValue(true);
    await execute("toggle-page-translation");
    expect(mocks.hide).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("handles rapid mode changes sequentially without translating again", async () => {
    await Promise.all([execute("cycle-display-mode"), execute("cycle-display-mode"), execute("cycle-display-mode")]);
    expect(mocks.setMode.mock.calls).toEqual([["bilingual-accent"], ["replace"], ["bilingual"]]);
    expect(settings.translationDisplayMode).toBe("bilingual");
    expect(mocks.setParagraph).toHaveBeenCalledWith(false); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("allows a mode change to retry after a failed save", async () => {
    mocks.send.mockRejectedValueOnce(new Error("保存失败"));
    await execute("cycle-display-mode"); expect(notice()).toContain("保存失败");
    await execute("cycle-display-mode"); expect(mocks.setMode).toHaveBeenCalledWith("bilingual-accent");
  });
  it("toggles paragraph mode and explains its click gesture", async () => {
    mocks.paragraph.mockReturnValue(false);
    await execute("toggle-paragraph-mode");
    expect(mocks.setParagraph).toHaveBeenCalledWith(true); expect(notice()).toContain("修饰键");
    mocks.paragraph.mockReturnValue(true);
    await execute("toggle-paragraph-mode"); expect(mocks.setParagraph).toHaveBeenLastCalledWith(false);
  });
  it("uses the paragraph engine for the saved selection shortcut and refreshes reading controls", async () => {
    await execute("translate-selection");
    expect(mocks.selection).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("shows paragraph targeting errors in a status message without throwing to the background", async () => {
    mocks.selection.mockRejectedValueOnce(new Error("请先选中正文段落"));
    await expect(execute("translate-selection")).resolves.toBeUndefined();
    expect(notice()).toContain("请先选中正文段落");
    expect(document.getElementById("wupage-shortcut-notice")?.shadowRoot?.querySelector("[role='status']")?.getAttribute("data-error")).toBe("true");
  });
});
