// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";
import { PARAGRAPH_MODE_KEY } from "../src/shared/paragraph-mode";
import { normalizeVideoTranslation } from "../src/shared/video";

describe("popup translation interactions", () => {
  let translate: Mock<() => Promise<unknown>>;
  let save: Mock<(settings: ExtensionSettings) => Promise<unknown>>;
  let loadSettings: Mock<() => Promise<unknown>>;
  let paragraph: Mock<(enabled: boolean) => Promise<unknown>>;
  let stored: ExtensionSettings;
  let settingsChanged: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

  beforeEach(async () => {
    vi.resetModules();
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "popup.html"), "utf8"));
    document.close();
    translate = vi.fn(async () => ({ translated: 1, cached: 0 }));
    save = vi.fn(async () => undefined);
    paragraph = vi.fn(async (enabled: boolean) => ({ enabled }));
    stored = structuredClone(DEFAULT_SETTINGS);
    loadSettings = vi.fn(async () => structuredClone(stored));
    const listeners = new Set<typeof settingsChanged>();
    settingsChanged = (changes, area) => { for (const listener of listeners) listener(changes, area); };
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
        if (request.type === "GET_SETTINGS") return { ok: true, data: await loadSettings() };
        if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "installed", downloaded: 100, total: 100 } };
        if (request.type === "SAVE_SETTINGS") { await save(request.settings); stored = structuredClone(request.settings); }
        return { ok: true };
      } },
      storage: { onChanged: {
        addListener: (listener: typeof settingsChanged) => { listeners.add(listener); },
        removeListener: (listener: typeof settingsChanged) => { listeners.delete(listener); }
      } },
      tabs: {
        query: async () => [{ id: 4, url: "https://example.com/article" }],
        sendMessage: vi.fn(async (_tabId: number, request: RuntimeRequest): Promise<RuntimeResponse> => {
          if (request.type === "GET_PARAGRAPH_MODE") return { ok: true, data: { enabled: false } };
          if (request.type === "GET_TRANSLATION_STATE") return { ok: true, data: { translated: false } };
          if (request.type === "SET_PARAGRAPH_MODE") return { ok: true, data: await paragraph(request.enabled) };
          if (request.type === "SET_FLOATING_BALL") return { ok: true, data: { enabled: request.enabled } };
          if (request.type === "TRANSLATE_PAGE") return { ok: true, data: await translate() };
          return { ok: true, data: { cleared: true } };
        })
      }
    });
    await import("../src/popup/index");
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.unstubAllGlobals();
    document.documentElement.replaceChildren();
  });

  it("can stop a pending translation and ignores its late response", async () => {
    const pending = deferred();
    translate.mockImplementation(() => pending.promise);
    button().click();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(button().textContent).toBe("显示全文");
    expect(button().disabled).toBe(false);
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("已显示原文。"));
    expect(button().textContent).toBe("翻译全文");
    pending.resolve({ translated: 1, cached: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(button().textContent).toBe("翻译全文");
    expect(button().classList.contains("is-loading")).toBe(false);
  });

  it("starts a page-local touch paragraph action without saving the global mode", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      const event = new Event("pointerup", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      document.dispatchEvent(event);
      const paragraphButton = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
      await vi.waitFor(() => expect(paragraphButton.textContent).toContain("点选段落"));
      paragraphButton.click();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: "START_TOUCH_PARAGRAPH" }, { frameId: 0 });
      expect(paragraph).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    } finally { close.mockRestore(); }
  });

  it("does not start a cancelled action after a delayed settings save", async () => {
    const pending = deferred();
    save.mockImplementationOnce(() => pending.promise);
    button().click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe("翻译全文"));
    pending.resolve(undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(translate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  it("keeps a restarted translation busy when the previous result arrives", async () => {
    const old = deferred();
    const current = deferred();
    translate.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    button().click();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("已显示原文。"));
    button().click();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    old.resolve({ translated: 1, cached: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(button().textContent).toBe("显示全文");
    expect(button().classList.contains("is-loading")).toBe(true);
    current.resolve({ translated: 2, cached: 0 });
    await vi.waitFor(() => expect(button().classList.contains("is-loading")).toBe(false));
    expect(document.querySelector("#status")?.textContent).toContain("已翻译 2 段");
  });

  it("keeps the original action when the active page has no completed segments", async () => {
    translate.mockResolvedValue({ translated: 0, cached: 0 });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("新内容加载后将自动翻译"));
    expect(button().textContent).toBe("显示全文");
    expect(button().disabled).toBe(false);
  });

  it("reports an interrupted translation without presenting zero segments as success", async () => {
    translate.mockResolvedValue({ translated: 0, cached: 0, cancelled: true });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("本次翻译已取消"));
    expect(button().textContent).toBe("翻译全文");
  });
  it("preserves document startup errors even without a failed-paragraph count", async () => {
    translate.mockResolvedValue({ translated: 0, failed: 0, error: "Document initialization failed" });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("翻译未完成：Document initialization failed"));
  });
  it("does not claim success when only offscreen paragraphs remain", async () => {
    translate.mockResolvedValue({ translated: 0, remaining: 8, pending: 0 });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("当前区域暂无可翻译内容，滚动页面将继续翻译。"));
  });

  it("reports a running batch and follows its eventual result", async () => {
    const running = { active: true, translated: 0, cached: 0, failed: 0, remaining: 0, pending: 2 };
    translate.mockResolvedValue(running);
    let progress = running;
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_tab, message) => {
      const request = message as RuntimeRequest;
      if (request.type === "GET_TRANSLATION_STATE") return { ok: true, data: { translated: true, progress } };
      if (request.type === "TRANSLATE_PAGE") return { ok: true, data: await translate() };
      return { ok: true };
    });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("正在翻译当前区域"));
    expect(button().textContent).toBe("显示全文");
    progress = { ...running, pending: 0, translated: 2 };
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("已翻译 2 段"));
  });

  it("does not let a cancelled action's delayed state read overwrite a newer restore", async () => {
    const state = deferred();
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_tab, message) => {
      const request = message as RuntimeRequest;
      if (request.type === "GET_TRANSLATION_STATE") return state.promise;
      if (request.type === "TRANSLATE_PAGE") return { ok: true, data: { translated: 0, cancelled: true } };
      return { ok: true, data: { cleared: true } };
    });
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("本次翻译已取消"));
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("已显示原文。"));
    state.resolve({ ok: true, data: { translated: true } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(button().textContent).toBe("翻译全文");
    expect(document.querySelector("#status")?.textContent).toBe("已显示原文。");
  });

  it("restores the action after a settings error and permits another attempt", async () => {
    save.mockRejectedValueOnce(new Error("设置保存失败"));
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("设置保存失败"));
    expect(button().textContent).toBe("翻译全文");
    expect(button().disabled).toBe(false);
    expect(translate).not.toHaveBeenCalled();
    button().click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("已翻译 1 段"));
  });

  it("updates the paragraph button when another tab changes the global mode", () => {
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    for (const enabled of [true, false]) {
      settingsChanged({ [PARAGRAPH_MODE_KEY]: { newValue: enabled } }, "local");
      expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
      expect(document.querySelector<HTMLSpanElement>("#paragraphModeHint")!.hidden).toBe(!enabled);
    }
    expect(paragraph).not.toHaveBeenCalled();
  });

  it("keeps a newer global state when an older paragraph command responds late", async () => {
    const pending = deferred(); paragraph.mockImplementationOnce(() => pending.promise);
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    toggle.click(); await vi.waitFor(() => expect(paragraph).toHaveBeenCalledWith(true));
    settingsChanged({ [PARAGRAPH_MODE_KEY]: { newValue: false } }, "local");
    pending.resolve({ enabled: true });
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("silently toggles paragraph mode without changing other controls during a translation", async () => {
    const translation = deferred();
    translate.mockImplementationOnce(() => translation.promise);
    button().click();
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    const changes = observeOtherControls(toggle);
    const status = document.querySelector("#status")!;
    const statusChanges = vi.fn();
    const observer = new MutationObserver(statusChanges);
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    try {
      for (const enabled of [true, false, true, false]) {
        const pending = deferred();
        paragraph.mockImplementationOnce(() => pending.promise);
        const calls = paragraph.mock.calls.length;
        toggle.click();
        await vi.waitFor(() => expect(paragraph).toHaveBeenCalledTimes(calls + 1));
        expect(paragraph).toHaveBeenLastCalledWith(enabled);
        expect(toggle.disabled).toBe(true);
        expect(toggle.getAttribute("aria-busy")).toBe("true");
        toggle.click();
        expect(paragraph).toHaveBeenCalledTimes(calls + 1);
        pending.resolve({ enabled });
        await vi.waitFor(() => expect(toggle.disabled).toBe(false));
        expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
        expect(button().classList.contains("is-loading")).toBe(true);
        expect(status.textContent).toBe("正在翻译...");
      }
      expect(changes.records).toEqual([]);
      expect(statusChanges).not.toHaveBeenCalled();
    } finally {
      changes.disconnect();
      observer.disconnect();
      translation.resolve({ translated: 1, cached: 0 });
    }
    await vi.waitFor(() => expect(button().classList.contains("is-loading")).toBe(false));
  });

  it("toggles video subtitles as a saved feature while retaining subtitle preferences", async () => {
    const runtime = vi.spyOn(chrome.runtime, "sendMessage");
    stored.videoTranslation = normalizeVideoTranslation({ enabled: true, fontSize: 26, preferredSource: "fr", enabledSites: ["youtube"] });
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    const toggle = document.querySelector<HTMLButtonElement>("#videoTranslation")!;
    expect(toggle.closest(".feature-toggles")).not.toBeNull();
    for (const enabled of [false, true]) {
      toggle.click(); await vi.waitFor(() => expect(toggle.disabled).toBe(false));
      expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
      expect(stored.videoTranslation).toMatchObject({ enabled, fontSize: 26, preferredSource: "fr", enabledSites: ["youtube"] });
    }
    expect(runtime).not.toHaveBeenCalledWith(expect.objectContaining({ type: "OPEN_VIDEO_SUBTITLES" }));
  });

  it("restores the video toggle after a failed save and permits retry", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#videoTranslation")!;
    save.mockRejectedValueOnce(new Error("设置保存失败"));
    toggle.click(); await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("#status")?.textContent).toBe("设置保存失败");
    toggle.click(); await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  });

  it("synchronizes the video toggle after settings change on another page", () => {
    stored.videoTranslation = normalizeVideoTranslation({ enabled: false });
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(document.querySelector("#videoTranslation")?.getAttribute("aria-pressed")).toBe("false");
    expect(save).not.toHaveBeenCalled();
  });

  it("saves the right-click button independently and restores it after a failed save", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#contextMenuTranslation")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    expect(stored.contextMenuTranslationEnabled).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("#translationDisplayMode")!.value).toBe("bilingual");
    save.mockRejectedValueOnce(new Error("设置保存失败"));
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  });

  it("keeps other controls stable when repeatedly toggling the floating ball", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#floatingBall")!;
    const changes = observeOtherControls(toggle);
    try {
      for (const enabled of [false, true, false, true]) {
        const pending = deferred();
        save.mockImplementationOnce(() => pending.promise);
        const calls = save.mock.calls.length;
        toggle.click();
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(calls + 1));
        toggle.click();
        expect(save).toHaveBeenCalledTimes(calls + 1);
        pending.resolve(undefined);
        await vi.waitFor(() => expect(toggle.disabled).toBe(false));
        expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
      }
      expect(changes.records).toEqual([]);
    } finally {
      changes.disconnect();
    }
  });

  it("reports a failed paragraph change and allows a silent retry", async () => {
    paragraph.mockRejectedValueOnce(new Error("切换失败"));
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(document.querySelector("#status")?.textContent).toBe("切换失败");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(paragraph).toHaveBeenLastCalledWith(true);
    expect(document.querySelector("#status")?.textContent).toBe("");
  });

  it("keeps paragraph mode selectable after the initial page connection fails", async () => {
    window.dispatchEvent(new Event("pagehide"));
    vi.resetModules();
    document.open(); document.write(readFileSync(resolve(process.cwd(), "popup.html"), "utf8")); document.close();
    vi.mocked(chrome.tabs.sendMessage)
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    await import("../src/popup/index");
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(document.querySelector("#status")?.textContent).toContain("刷新网页后重试");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(paragraph).toHaveBeenLastCalledWith(true);
    expect(document.querySelector<HTMLSpanElement>("#paragraphModeHint")!.hidden).toBe(false);
    expect(document.querySelector("#status")?.textContent).toBe("");
    expect(toggle.hasAttribute("title")).toBe(false);
  });

  it("gives a refresh hint on a disconnected paragraph attempt and permits another attempt", async () => {
    paragraph.mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("#status")?.textContent).toContain("刷新网页后重试");
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("#status")?.textContent).toBe("");
  });

  it("keeps paragraph translation enabled when changing its display style", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#paragraphMode")!;
    const mode = document.querySelector<HTMLSelectElement>("#translationDisplayMode")!;
    expect(Array.from(mode.options, option => option.value)).toEqual(["replace", "bilingual", "bilingual-accent"]);
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    mode.value = "replace";
    mode.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.translationDisplayMode).toBe("replace"));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(paragraph).toHaveBeenCalledTimes(1);
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(mode.value).toBe("replace");
    expect(stored.translationDisplayMode).toBe("replace");
  });

  it("restores the floating ball value when saving fails", async () => {
    save.mockRejectedValueOnce(new Error("设置保存失败"));
    const toggle = document.querySelector<HTMLButtonElement>("#floatingBall")!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("#status")?.textContent).toBe("设置保存失败");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  });

  it("enables automatic translation directly and preserves its default language rule when disabled", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    const changes = observeOtherControls(toggle, [document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!]);
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    expect(stored.autoTranslation).toEqual({ enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] });
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(stored.autoTranslation?.nonTargetLanguage).toBe(true);
    expect(changes.records).toEqual([]);
    changes.disconnect();
  });

  it("toggles selection translation while preserving the latest dictionary, style and automatic rules", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#selectionTranslation")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    stored.selectionTranslation = { enabled: true, provider: "bing", style: "underline" };
    stored.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] };
    const changes = observeOtherControls(toggle, [document.querySelector("#autoTranslation")!, document.querySelector("#addAutoTranslationSite")!]);
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(stored.selectionTranslation).toEqual({ enabled: false, provider: "bing", style: "underline" });
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    expect(stored.selectionTranslation).toEqual({ enabled: true, provider: "bing", style: "underline" });
    expect(stored.autoTranslation).toEqual({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] });
    expect(document.querySelector("#autoTranslation")!.getAttribute("aria-pressed")).toBe("true");
    expect(changes.records).toEqual([]);
    changes.disconnect();
  });

  it("prevents repeated selection switch requests and restores its state after a failed save", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#selectionTranslation")!;
    const pending = deferred();
    save.mockImplementationOnce(() => pending.promise);
    toggle.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(toggle.disabled).toBe(true);
    toggle.click();
    expect(save).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    save.mockRejectedValueOnce(new Error("设置保存失败"));
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(stored.selectionTranslation?.enabled).toBe(false);
    expect(document.querySelector("#status")?.textContent).toBe("设置保存失败");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
  });

  it("syncs the selection switch from settings while automatic translation is saving", async () => {
    const pending = deferred();
    save.mockImplementationOnce(() => pending.promise);
    document.querySelector<HTMLButtonElement>("#autoTranslation")!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const incoming = { ...stored, selectionTranslation: { enabled: false, provider: "bing", style: "underline" } };
    settingsChanged({ [SETTINGS_KEY]: { newValue: incoming } }, "local");
    expect(document.querySelector("#selectionTranslation")?.getAttribute("aria-pressed")).toBe("false");
    pending.resolve(undefined);
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#autoTranslation")!.disabled).toBe(false));
  });

  it("follows image translation and floating-ball switches changed from the reading menu", () => {
    const incoming = { ...stored, imageTranslationEnabled: true, floatingBallEnabled: false };
    settingsChanged({ [SETTINGS_KEY]: { newValue: incoming } }, "local");
    expect(document.querySelector("#imageTranslation")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("#floatingBall")?.getAttribute("aria-pressed")).toBe("false");
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(document.querySelector("#imageTranslation")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("#floatingBall")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("synchronizes languages, providers, display mode and automatic rules before saving another field", async () => {
    stored = { ...stored, sourceLang: "ja", targetLang: "en", activeProviderId: "deepseek", translationDisplayMode: "bilingual-accent",
      cacheEnabled: false, autoTranslation: { enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] },
      providers: stored.providers.map(entry => entry.id === "deepseek" ? { ...entry, label: "新的服务名称" } : entry.id === "microsoft-web-translate" ? { ...entry, enabled: false } : entry) };
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(document.querySelector<HTMLSelectElement>("#sourceLang")!.value).toBe("ja");
    expect(document.querySelector<HTMLSelectElement>("#targetLang")!.value).toBe("en");
    expect(document.querySelector("#sourceLang + .language-value")!.textContent).toBe("日本語");
    expect(document.querySelector(".wupage-provider-name")!.textContent).toBe("新的服务名称");
    expect(document.querySelector("#provider option[value='microsoft-web-translate']")).toBeNull();
    expect(document.querySelector<HTMLSelectElement>("#translationDisplayMode")!.value).toBe("bilingual-accent");
    expect(document.querySelector("#autoTranslation")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!.hidden).toBe(false);
    const source = document.querySelector<HTMLSelectElement>("#sourceLang")!;
    source.value = "fr"; source.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.sourceLang).toBe("fr"));
    expect(stored).toMatchObject({ targetLang: "en", activeProviderId: "deepseek", cacheEnabled: false, autoTranslation: { enabled: true } });
  });

  it("queues independent switches so one pending save cannot overwrite another", async () => {
    const pending = deferred(); save.mockImplementationOnce(() => pending.promise);
    document.querySelector<HTMLButtonElement>("#autoTranslation")!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    document.querySelector<HTMLButtonElement>("#selectionTranslation")!.click();
    pending.resolve(undefined);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#selectionTranslation")!.disabled).toBe(false));
    expect(stored.autoTranslation?.enabled).toBe(true);
    expect(stored.selectionTranslation?.enabled).toBe(false);
  });

  it("keeps an external automatic setting received while a failed save is pending", async () => {
    const pending = deferred(); save.mockImplementationOnce(() => pending.promise);
    const automatic = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    automatic.click(); await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    stored.autoTranslation = { enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] };
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    pending.reject(new Error("本次保存失败"));
    await vi.waitFor(() => expect(automatic.disabled).toBe(false));
    expect(automatic.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!.hidden).toBe(false);
  });

  it("uses the latest saved site rules instead of replacing them with language detection", async () => {
    stored.autoTranslation = { enabled: false, nonTargetLanguage: false, presetSites: ["github.com"],
      customSites: [{ id: "private", pattern: "example.com/docs/*", enabled: true }] };
    document.querySelector<HTMLButtonElement>("#autoTranslation")!.click();
    await vi.waitFor(() => expect(stored.autoTranslation?.enabled).toBe(true));
    expect(stored.autoTranslation).toEqual({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"],
      customSites: [{ id: "private", pattern: "example.com/docs/*", enabled: true }] });
  });

  it.each([
    ["floatingBall", "floatingBallEnabled"],
    ["imageTranslation", "imageTranslationEnabled"]
  ] as const)("queues a %s change while automatic translation reads settings", async (id, field) => {
    const latest = structuredClone(stored);
    latest.cacheEnabled = false;
    latest.autoTranslation = { enabled: false, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] };
    const pending = deferred();
    loadSettings.mockImplementationOnce(() => pending.promise);
    const automatic = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    automatic.click();
    await vi.waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(2));
    const toggle = document.querySelector<HTMLButtonElement>(`#${id}`)!;
    const enabled = !latest[field];
    toggle.click();
    expect(automatic.disabled).toBe(true);
    pending.resolve(latest);
    await vi.waitFor(() => expect(automatic.disabled).toBe(false));
    await vi.waitFor(() => expect(stored[field]).toBe(enabled));
    expect(stored[field]).toBe(enabled);
    expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
    expect(stored.cacheEnabled).toBe(false);
    expect(stored.autoTranslation).toEqual({ ...latest.autoTranslation, enabled: true });
  });

  it("shows the site button only while automatic translation is enabled and adds the current host once", async () => {
    const automatic = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    const add = document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!;
    expect(add.hidden).toBe(true);
    automatic.click();
    await vi.waitFor(() => expect(add.hidden || add.disabled).toBe(false));
    stored.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [{ id: "other", pattern: "other.test", enabled: false }] };
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    expect(stored.autoTranslation).toMatchObject({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [
      { id: "other", pattern: "other.test", enabled: false }, { id: expect.any(String), pattern: "example.com", enabled: true }
    ] });
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("plus"));
    expect(stored.autoTranslation!.excludedSites).toEqual(["example.com"]);
    expect(stored.autoTranslation!.customSites).toHaveLength(2);
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    expect(stored.autoTranslation!.excludedSites).toBeUndefined();
    expect(stored.autoTranslation!.customSites).toHaveLength(2);
    automatic.click();
    await vi.waitFor(() => expect(add.hidden).toBe(true));
  });

  it("blocks repeated site additions while saving and restores a retry after failure", async () => {
    const automatic = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    const add = document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!;
    automatic.click();
    await vi.waitFor(() => expect(add.hidden || add.disabled).toBe(false));
    const pending = deferred(); save.mockImplementationOnce(() => pending.promise);
    add.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(automatic.disabled).toBe(true);
    add.click(); automatic.click();
    expect(save).toHaveBeenCalledTimes(2);
    pending.resolve(undefined);
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    stored.autoTranslation!.customSites = [];
    settingsChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    save.mockRejectedValueOnce(new Error("网站保存失败"));
    add.click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("网站保存失败"));
    expect(add.disabled).toBe(false);
    expect(add.querySelector('svg')?.dataset.icon).toBe("plus");
    expect(stored.autoTranslation!.customSites).toEqual([]);
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
  });

  it("rejects unsupported pages if the active tab changes before adding", async () => {
    const add = document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!;
    document.querySelector<HTMLButtonElement>("#autoTranslation")!.click();
    await vi.waitFor(() => expect(add.hidden || add.disabled).toBe(false));
    vi.spyOn(chrome.tabs, "query").mockImplementation(async () => [{ id: 4, url: "edge://settings" } as chrome.tabs.Tab]);
    const calls = save.mock.calls.length;
    add.click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toContain("普通网页"));
    expect(save).toHaveBeenCalledTimes(calls);
    expect(add.disabled).toBe(true);
  });

  it("restores the checked site button after a failed exclusion", async () => {
    const add = document.querySelector<HTMLButtonElement>("#addAutoTranslationSite")!;
    document.querySelector<HTMLButtonElement>("#autoTranslation")!.click();
    await vi.waitFor(() => expect(add.hidden || add.disabled).toBe(false));
    add.click(); await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    save.mockRejectedValueOnce(new Error("排除网站失败"));
    add.click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("排除网站失败"));
    expect(add.querySelector('svg')?.dataset.icon).toBe("tick"); expect(add.disabled).toBe(false);
    expect(stored.autoTranslation!.excludedSites).toBeUndefined();
    add.click(); await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("plus"));
    expect(stored.autoTranslation!.excludedSites).toEqual(["example.com"]);
  });

  it("prevents repeated automatic switch requests and restores its state when saving fails", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#autoTranslation")!;
    const pending = deferred();
    save.mockImplementationOnce(() => pending.promise);
    toggle.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    toggle.click(); expect(save).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    save.mockRejectedValueOnce(new Error("自动翻译设置保存失败"));
    toggle.click();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("自动翻译设置保存失败"));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(stored.autoTranslation?.enabled).toBe(true);
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(document.querySelector("#status")?.textContent).toBe("");
  });
});

function observeOtherControls(except: HTMLButtonElement | HTMLSelectElement, related: Element[] = []): { records: MutationRecord[]; disconnect: () => void } {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver(changes => records.push(...changes));
  for (const control of document.querySelectorAll("button, select")) {
    if (control !== except && !related.includes(control)) observer.observe(control, { attributes: true, childList: true, subtree: true });
  }
  observer.observe(document.body, { attributes: true });
  return { records, disconnect: () => observer.disconnect() };
}

function button(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("#pageToggle")!;
}

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void } {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
