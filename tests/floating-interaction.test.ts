// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

import { getParagraphMode, initFloatingBall, setParagraphMode } from "../src/content/floating";
import { clearPageTranslation, getPageTranslationState, startPageTranslation } from "../src/content/page-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import { injectContentStyles } from "../src/content/styles";
import { ProviderError } from "../src/shared/errors";
import { PARAGRAPH_MODE_KEY } from "../src/shared/paragraph-mode";

describe("floating translation interactions", () => {
  let stored: ExtensionSettings;
  let storageChanged: (changes: Record<string, { newValue: unknown }>, area: string) => void;
  let documentListeners: MockInstance<Document["addEventListener"]>;
  let windowListeners: MockInstance<Window["addEventListener"]>;

  beforeEach(async () => {
    document.documentElement.innerHTML = "<head></head><body><main><p>Read this paragraph before continuing.</p></main></body>";
    stored = structuredClone(DEFAULT_SETTINGS);
    const storageListeners = new Set<typeof storageChanged>();
    storageChanged = (changes, area) => { for (const listener of storageListeners) listener(changes, area); };
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return structuredClone(stored);
      if (request.type === "GET_OCR_STATUS") return { state: "installed", total: 100, downloaded: 100 };
      if (request.type === "SAVE_SETTINGS") {
        stored = structuredClone(request.settings);
        return undefined;
      }
      if (request.type === "TRANSLATE_BATCH") {
        return { translations: request.texts.map(() => "继续之前，请阅读此段内容。"), cached: 0 };
      }
      return undefined;
    });
    vi.stubGlobal("chrome", {
      runtime: { id: "test" },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
        onChanged: {
          addListener: (listener: typeof storageChanged) => { storageListeners.add(listener); },
          removeListener: (listener: typeof storageChanged) => { storageListeners.delete(listener); }
        }
      }
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const hitbox = document.querySelector<HTMLElement>("#wupage-floating-hitbox");
      const left = this.id === "wupage-floating-ball" ? Number.parseFloat(hitbox?.style.left ?? "0") + 16 : 0;
      const top = this.id === "wupage-floating-ball" ? Number.parseFloat(hitbox?.style.top ?? "0") + 16 : 100;
      const width = this.id === "wupage-floating-ball" ? 42 : 600;
      return { left, top, right: left + width, bottom: top + 24, x: left, y: top, width, height: 24, toJSON: () => ({}) };
    });
    documentListeners = vi.spyOn(document, "addEventListener");
    windowListeners = vi.spyOn(window, "addEventListener");
    injectContentStyles();
    initFloatingBall();
    await vi.waitFor(() => expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(false));
  });

  afterEach(() => {
    clearPageTranslation();
    for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
    for (const args of windowListeners.mock.calls) window.removeEventListener(...args);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(sendRuntimeRequest).mockReset();
    document.documentElement.replaceChildren();
  });

  function hover(): HTMLElement {
    query("#wupage-floating-hitbox").dispatchEvent(new Event("pointerenter"));
    return query<HTMLElement>("#wupage-floating-menu");
  }

  function translationRequests(): RuntimeRequest[] {
    return vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request).filter((request) => request.type === "TRANSLATE_BATCH");
  }

  it("initializes the menu before a first translation failure reveals it without hovering", async () => {
    const menu = query<HTMLElement>("#wupage-floating-menu");
    expect(menu.hidden).toBe(true);
    const provider = query<HTMLSelectElement>("[data-role='provider']");
    expect(provider.value).toBe(stored.activeProviderId);
    expect(provider.options).toHaveLength(stored.providers.filter((entry) => entry.enabled !== false).length);
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "TRANSLATE_BATCH") throw new Error("服务暂不可用");
      return runtime(request);
    });
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(query(".wupage-provider-trigger .wupage-provider-name").textContent)
      .toBe(stored.providers.find((entry) => entry.id === stored.activeProviderId)!.label);
    expect(query<HTMLSelectElement>("[data-role='display-mode']").value).toBe(stored.translationDisplayMode);
  });

  it("opens after 500 ms of hover and allows crossing the gap before closing on leave", () => {
    vi.useFakeTimers();
    const menu = hover();
    vi.advanceTimersByTime(499);
    expect(menu.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(menu.hidden).toBe(false);
    expect(query("#wupage-floating-ball").getAttribute("aria-expanded")).toBe("true");
    expect(translationRequests()).toHaveLength(0);
    query("#wupage-floating-hitbox").dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(120);
    menu.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(400);
    expect(menu.hidden).toBe(false);
    menu.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(300);
    expect(menu.hidden).toBe(true);
    expect(query("#wupage-floating-ball").getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["html", "body", "div", "video"])("hides the page floating controls during %s fullscreen and restores them on exit", (tag) => {
    vi.useFakeTimers();
    const player = document.createElement("div"); player.innerHTML = "<video></video>"; document.body.append(player);
    const fullscreen = tag === "div" ? player : document.querySelector(tag)!;
    const previous = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const menu = hover(); vi.advanceTimersByTime(500);
    expect(menu.hidden).toBe(false);
    try {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: fullscreen });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(true);
      expect(menu.hidden).toBe(true);
      expect(query("#wupage-floating-ball").getAttribute("aria-expanded")).toBe("false");
      // Storage updates and a focused button must not reopen an invisible menu.
      storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
      query("#wupage-floating-ball").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      vi.advanceTimersByTime(600);
      expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(true);
      expect(menu.hidden).toBe(true);
      expect(stored.floatingBallEnabled).toBe(true);
      expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "SAVE_SETTINGS")).toBe(false);
    } finally {
      if (previous) Object.defineProperty(document, "fullscreenElement", previous);
      else Reflect.deleteProperty(document, "fullscreenElement");
      document.dispatchEvent(new Event("fullscreenchange"));
    }
    expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(false);
    expect(menu.hidden).toBe(true);
    hover(); vi.advanceTimersByTime(500); expect(menu.hidden).toBe(false);
  });

  it("cancels a pending hover on fullscreen entry and preserves a disabled ball on exit", () => {
    vi.useFakeTimers();
    const menu = hover(); vi.advanceTimersByTime(250);
    const previous = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    try {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
      document.dispatchEvent(new Event("fullscreenchange"));
      vi.advanceTimersByTime(600);
      expect(menu.hidden).toBe(true);
      stored.floatingBallEnabled = false;
      storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    } finally {
      if (previous) Object.defineProperty(document, "fullscreenElement", previous);
      else Reflect.deleteProperty(document, "fullscreenElement");
      document.dispatchEvent(new Event("fullscreenchange"));
    }
    expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(true);
    expect(menu.hidden).toBe(true);
  });

  it("cancels opening on leave and waits a full delay on the next hover", () => {
    vi.useFakeTimers();
    const menu = hover();
    vi.advanceTimersByTime(250);
    query("#wupage-floating-hitbox").dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(600);
    expect(menu.hidden).toBe(true);
    hover();
    vi.advanceTimersByTime(499);
    expect(menu.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(menu.hidden).toBe(false);
  });

  it("cancels pending hover opening on drag or escape", () => {
    vi.useFakeTimers();
    const menu = hover();
    vi.advanceTimersByTime(250);
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600));
    ball.dispatchEvent(pointer("pointermove", 820, 620));
    ball.dispatchEvent(pointer("pointerup", 820, 620));
    ball.click();
    vi.advanceTimersByTime(600);
    expect(menu.hidden).toBe(true);
    expect(translationRequests()).toHaveLength(0);
    hover();
    vi.advanceTimersByTime(250);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(menu.hidden).toBe(true);
  });

  it("opens on a 500 ms touch hold and stays open after release without translating", async () => {
    vi.useFakeTimers();
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    const menu = query<HTMLElement>("#wupage-floating-menu");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600, "touch"));
    vi.advanceTimersByTime(499);
    expect(menu.hidden).toBe(true);
    ball.dispatchEvent(pointer("pointermove", 803, 602, "touch")); // Ignore normal finger jitter.
    vi.advanceTimersByTime(1);
    expect(menu.hidden).toBe(false);
    const contextMenu = new Event("contextmenu", { cancelable: true });
    ball.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    ball.dispatchEvent(pointer("pointerup", 803, 602, "touch"));
    ball.click();
    query("#wupage-floating-hitbox").dispatchEvent(pointer("pointerleave", 803, 602, "touch"));
    menu.dispatchEvent(pointer("pointerleave", 803, 602, "touch"));
    vi.advanceTimersByTime(1000);
    expect(menu.hidden).toBe(false);
    expect(translationRequests()).toHaveLength(0);
    document.querySelector("main")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    // Consuming the long-press click must not consume a subsequent ordinary tap.
    ball.dispatchEvent(pointer("pointerdown", 800, 600, "touch"));
    ball.dispatchEvent(pointer("pointerup", 800, 600, "touch"));
    ball.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(translationRequests()).toHaveLength(1);
  });

  it("keeps a short touch as a translation tap and cancels the pending long press", async () => {
    vi.useFakeTimers();
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600, "touch"));
    vi.advanceTimersByTime(150);
    ball.dispatchEvent(pointer("pointerup", 800, 600, "touch"));
    ball.click();
    await vi.advanceTimersByTimeAsync(600);
    expect(translationRequests()).toHaveLength(1);
    expect(query<HTMLElement>("#wupage-floating-menu").hidden).toBe(true);
  });

  it("cancels the long press when the finger drags the ball", () => {
    vi.useFakeTimers();
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600, "touch"));
    vi.advanceTimersByTime(200);
    ball.dispatchEvent(pointer("pointermove", 830, 620, "touch"));
    vi.advanceTimersByTime(600);
    ball.dispatchEvent(pointer("pointerup", 830, 620, "touch"));
    ball.click();
    expect(query<HTMLElement>("#wupage-floating-menu").hidden).toBe(true);
    expect(translationRequests()).toHaveLength(0);
  });

  it.each(["pointercancel", "lostpointercapture"])("cancels a long press after %s", (eventType) => {
    vi.useFakeTimers();
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600, "touch"));
    vi.advanceTimersByTime(200);
    ball.dispatchEvent(pointer(eventType, 800, 600, "touch"));
    vi.advanceTimersByTime(600);
    ball.click();
    expect(query<HTMLElement>("#wupage-floating-menu").hidden).toBe(true);
    expect(translationRequests()).toHaveLength(0);
  });

  it("switches immediately between translation and original and can translate again", async () => {
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    expect(ball.textContent).toBe("原");
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    expect(translationRequests()).toHaveLength(1);
    expect(ball.textContent).toBe("原");
    ball.click();
    expect(ball.textContent).toBe("译");
    expect(document.querySelector(".wupage-translation")).toBeNull();
    ball.click();
    expect(ball.textContent).toBe("原");
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    expect(translationRequests()).toHaveLength(1);
    expect(query("[data-role='translation-status']").textContent).toContain("缓存命中 1 段");
    expect(ball.getAttribute("aria-label")).toBe("显示原文");
  });

  it("keeps the original action when the provider returns unchanged text", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => request.type === "TRANSLATE_BATCH"
      ? { translations: request.texts, cached: 0 } : runtime(request));
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(getPageTranslationState()).toMatchObject({ active: true, pending: 0, translated: 1 });
    expect(ball.textContent).toBe("原");
    expect(ball.getAttribute("aria-label")).toBe("显示原文");
    ball.click();
    expect(getPageTranslationState().active).toBe(false);
    expect(ball.textContent).toBe("译");
    expect(translationRequests()).toHaveLength(1);
  });

  it("keeps the original action while a dynamic feed replaces translated posts", async () => {
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    query("main").replaceChildren();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(getPageTranslationState()).toMatchObject({ active: true, pending: 0 });
    expect(ball.textContent).toBe("原");
    ball.click();
    expect(getPageTranslationState().active).toBe(false);
    expect(ball.textContent).toBe("译");
    query("main").innerHTML = "<p>A newly loaded post after translation is stopped.</p>";
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(translationRequests()).toHaveLength(1);
  });

  it("keeps the ball enabled during translation and discards a response after stopping", async () => {
    let finish!: (value: unknown) => void;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? new Promise((resolve) => { finish = resolve; }) : runtime(request));
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(translationRequests()).toHaveLength(1));
    expect(ball.textContent).toBe("原");
    expect(ball.getAttribute("aria-busy")).toBe("true");
    expect(ball.getAttribute("aria-disabled")).toBe("false");
    expect(getComputedStyle(ball).cursor).toBe("pointer");
    expect(getComputedStyle(ball).opacity).not.toBe("0.68");
    expect(query<HTMLButtonElement>("[data-action='page-toggle']").disabled).toBe(false);
    expect(query("[data-action='page-toggle']").textContent).toBe("显示原文");
    ball.click();
    expect(ball.textContent).toBe("译");
    expect(ball.getAttribute("aria-busy")).toBe("false");
    finish({ translations: ["迟到的译文"], cached: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(ball.getAttribute("aria-label")).toBe("翻译全文");
    expect(translationRequests()).toHaveLength(1);
  });

  it("can stop from the menu and restart before the old translation finishes", async () => {
    const completions: Array<(value: unknown) => void> = [];
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? new Promise((resolve) => { completions.push(resolve); }) : runtime(request));
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    query<HTMLButtonElement>("[data-action='page-toggle']").click();
    expect(ball.textContent).toBe("译");
    ball.click();
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[0]({ translations: ["旧译文"], cached: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ball.textContent).toBe("原");
    expect(ball.getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).not.toContain("旧译文");
    completions[1]({ translations: ["新译文"], cached: 0 });
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    expect(query(".wupage-translation").textContent).toBe("新译文");
  });

  it("keeps the open menu action and position stable while a dynamic feed translates more posts", async () => {
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    storageChanged({ "wupage.floating.position": { newValue: { left: 800, top: 300, edge: null } } }, "local");
    const menu = query<HTMLElement>("#wupage-floating-menu");
    let menuHeight = 200;
    Object.defineProperty(menu, "offsetHeight", { configurable: true, get: () => menuHeight });
    ball.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const pageToggle = query<HTMLButtonElement>("[data-action='page-toggle']");
    const actionText = pageToggle.firstChild;
    const initialTop = menu.style.top;
    const completions: Array<(value: unknown) => void> = [];
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? new Promise((resolve) => completions.push(resolve)) : runtime(request));
    for (let index = 0; index < 3; index++) {
      menuHeight = 240;
      const post = document.createElement("p");
      post.textContent = `A newly loaded post number ${index} for translation.`;
      query("main").append(post);
      await vi.waitFor(() => expect(completions).toHaveLength(index + 1));
      expect(ball.getAttribute("aria-busy")).toBe("true");
      expect(pageToggle.textContent).toBe("显示原文");
      expect(pageToggle.firstChild).toBe(actionText);
      expect(menu.style.top).toBe(initialTop);
      menuHeight = 200;
      completions[index]({ translations: [`新增译文 ${index}`], cached: 0 });
      await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
      expect(pageToggle.firstChild).toBe(actionText);
      expect(menu.style.top).toBe(initialTop);
      expect(menu.hidden).toBe(false);
    }
    expect(translationRequests()).toHaveLength(4);
    pageToggle.click();
    expect(ball.textContent).toBe("译");
    expect(pageToggle.textContent).toBe("翻译全文");
  });

  it("does not restart a cancelled action when its settings arrive late", async () => {
    let finishSettings!: (value: unknown) => void;
    let delayNextSettings = true;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => {
      if (request.type === "GET_SETTINGS" && delayNextSettings) {
        delayNextSettings = false;
        return new Promise((resolve) => { finishSettings = resolve; });
      }
      return runtime(request);
    });
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(finishSettings).toBeTypeOf("function"));
    ball.click();
    expect(ball.textContent).toBe("译");
    ball.click();
    await vi.waitFor(() => expect(ball.getAttribute("aria-busy")).toBe("false"));
    finishSettings(stored);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(translationRequests()).toHaveLength(1);
    expect(ball.textContent).toBe("原");
    expect(query(".wupage-translation").textContent).toBe("继续之前，请阅读此段内容。");
  });

  it("does not mistake small pointer jitter for a drag", async () => {
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.setPointerCapture = vi.fn();
    ball.dispatchEvent(pointer("pointerdown", 800, 600));
    ball.dispatchEvent(pointer("pointermove", 801, 601));
    ball.dispatchEvent(pointer("pointerup", 801, 601));
    ball.click();
    await vi.waitFor(() => expect(translationRequests()).toHaveLength(1));
  });

  it("shows translation failures and retries from the floating menu", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "TRANSLATE_BATCH") throw new Error("服务暂不可用");
      return runtime(request);
    });
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("服务暂不可用"));
    expect(query<HTMLElement>("#wupage-floating-menu").hidden).toBe(false);
    expect(query<HTMLButtonElement>("[data-action='retranslate']").hidden).toBe(false);
    vi.mocked(sendRuntimeRequest).mockImplementation(runtime);
    query<HTMLButtonElement>("[data-action='retranslate']").click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("已翻译 1 段"));
    expect(query("[data-role='translation-status']").getAttribute("data-tone")).toBe("normal");
  });

  it("saves provider and display choices without retranslating existing text", async () => {
    stored.providers[0].label = '<img src=x onerror="alert(1)">';
    stored.providers[1].enabled = false;
    hover();
    await vi.waitFor(() => expect(query<HTMLSelectElement>("[data-role='provider']").options.length).toBe(stored.providers.length - 1));
    const provider = query<HTMLSelectElement>("[data-role='provider']");
    expect(provider.querySelector("img")).toBeNull();
    expect([...provider.options].some((option) => option.value === stored.providers[1].id)).toBe(false);
    provider.value = "deepseek";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    selectMode("replace");
    await vi.waitFor(() => expect(stored).toMatchObject({ activeProviderId: "deepseek", translationDisplayMode: "replace" }));
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(query(".wupage-translation").getAttribute("data-wupage-display-mode")).toBe("replace"));
    selectMode("bilingual-accent");
    await vi.waitFor(() => expect(query(".wupage-translation").getAttribute("data-wupage-display-mode")).toBe("bilingual-accent"));
    expect(translationRequests()).toHaveLength(1);
  });

  it("waits for a pending language save before translating", async () => {
    let finishSave!: () => void;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "SAVE_SETTINGS") await new Promise<void>((resolve) => { finishSave = resolve; });
      return runtime(request);
    });
    const target = query<HTMLSelectElement>("[data-role='target-lang']");
    target.value = "ja";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(translationRequests()).toHaveLength(0);
    finishSave();
    await vi.waitFor(() => expect(translationRequests()[0]).toMatchObject({ targetLang: "ja" }));
  });

  it("recovers from a failed settings save without trapping subsequent actions", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "SAVE_SETTINGS") throw new Error("设置保存失败");
      return runtime(request);
    });
    selectMode("replace");
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("设置保存失败"));
    expect(stored.translationDisplayMode).toBe("bilingual");
    expect(query<HTMLSelectElement>("[data-role='display-mode']").value).toBe("bilingual");
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("已翻译 1 段"));
  });

  it("follows translations started outside the floating menu", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "TRANSLATE_BATCH") throw new Error("服务暂不可用");
      return runtime(request);
    });
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").getAttribute("data-tone")).toBe("error"));
    vi.mocked(sendRuntimeRequest).mockImplementation(runtime);
    await startPageTranslation(stored);
    expect(query("[data-role='translation-status']").textContent).toContain("已翻译 1 段");
    expect(query("[data-role='translation-status']").getAttribute("data-tone")).toBe("normal");
    expect(query("#wupage-floating-ball").getAttribute("aria-label")).toBe("显示原文");
    clearPageTranslation();
    expect(query("#wupage-floating-ball").getAttribute("aria-label")).toBe("翻译全文");
  });

  it("keeps the ball accessible when a small window needs a scrolling menu", () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 320 });
    storageChanged({ "wupage.floating.position": { newValue: { left: 139, top: 139, edge: null } } }, "local");
    const menu = query<HTMLElement>("#wupage-floating-menu");
    Object.defineProperty(menu, "offsetHeight", { configurable: true, get: () => Number.parseFloat(menu.style.maxHeight) });
    Object.defineProperty(menu, "offsetWidth", { configurable: true, get: () => Number.parseFloat(menu.style.width) });
    hover();
    vi.advanceTimersByTime(500);
    const bottom = Number.parseFloat(menu.style.top) + menu.offsetHeight;
    expect(bottom).toBeLessThanOrEqual(131);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.left) + menu.offsetWidth).toBeLessThanOrEqual(312);
  });

  it("uses the ordinary editable source selection with Doubao and when changing services", async () => {
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test/${path}` });
    stored = { ...stored, activeProviderId: "doubao-web", sourceLang: "en", targetLang: "pt" };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    const source = query<HTMLSelectElement>("[data-role='source-lang']");
    const target = query<HTMLSelectElement>("[data-role='target-lang']");
    const provider = query<HTMLSelectElement>("[data-role='provider']");
    expect(source.disabled).toBe(false);
    expect(source.value).toBe("en");
    expect(query("[data-role='source-lang-value']").textContent).toBe("English");
    expect(target.value).toBe("pt");
    expect(target.selectedOptions[0]?.disabled).toBe(true);
    target.value = "ja";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.targetLang).toBe("ja"));
    expect(stored.sourceLang).toBe("en");
    source.value = "fr";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.sourceLang).toBe("fr"));
    provider.value = "google-web-translate";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.activeProviderId).toBe("google-web-translate"));
    expect(source.disabled).toBe(false);
    expect(stored.sourceLang).toBe("fr");
    expect(source.value).toBe("fr");
    expect(query("[data-role='source-lang-value']").textContent).toBe("Français");
    provider.value = "doubao-web";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.activeProviderId).toBe("doubao-web"));
    source.value = "auto";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.sourceLang).toBe("auto"));
    expect(source.disabled).toBe(false);
    expect(query("[data-role='source-lang-value']").textContent).toBe("自动检测");
    expect(query<HTMLButtonElement>(".wupage-provider-choice[data-value='doubao-web']").disabled).toBe(false);
    Object.assign(chrome.runtime, { getURL: (path: string) => `moz-extension://test/${path}` });
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(query<HTMLButtonElement>(".wupage-provider-choice[data-value='doubao-web']").disabled).toBe(true);
    expect(query<HTMLButtonElement>(".wupage-provider-choice[data-value='google-web-translate']").disabled).toBe(false);
    expect(translationRequests()).toHaveLength(0);
  });

  it("offers an explicit settings action after Doubao requires login", async () => {
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test/${path}` });
    stored.activeProviderId = "doubao-web";
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? Promise.reject(new ProviderError("请登录豆包后重新检测。", "login-required")) : runtime(request));
    query<HTMLButtonElement>("#wupage-floating-ball").click();
    await vi.waitFor(() => expect(getPageTranslationState().errorCode).toBe("login-required"));
    const recover = query<HTMLButtonElement>("[data-action='doubao-settings']");
    expect(recover.hidden).toBe(false);
    expect(recover.textContent).toContain("登录豆包");
    expect(sendRuntimeRequest).not.toHaveBeenCalledWith({ type: "OPEN_OPTIONS_PAGE" });
    recover.click();
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "OPEN_OPTIONS_PAGE" });
    expect(translationRequests()).toHaveLength(1);
  });

  it("shows rate-limit waiting and prevents repeated retries, including after restoring the page", async () => {
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test/${path}` });
    stored.activeProviderId = "doubao-web";
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? Promise.reject(new ProviderError("豆包限流。", "rate-limited", 5000)) : runtime(request));
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.click();
    await vi.waitFor(() => expect(getPageTranslationState().errorCode).toBe("rate-limited"));
    const retry = query<HTMLButtonElement>("[data-action='retranslate']");
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toContain("等待");
    expect(query("[data-role='translation-status']").textContent).toContain("秒后再试");
    retry.click();
    ball.click(); // Restoring the page is still allowed.
    ball.click(); // Starting again waits for the same cooldown.
    await Promise.resolve();
    expect(translationRequests()).toHaveLength(1);
  });

  it("updates the cooldown after a paragraph error opens a previously hidden menu", async () => {
    vi.useFakeTimers();
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test/${path}` });
    stored.activeProviderId = "doubao-web";
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    await setParagraphMode(true);
    const menu = query<HTMLElement>("#wupage-floating-menu");
    expect(menu.hidden).toBe(true);
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? Promise.reject(new ProviderError("豆包请求受限。", "rate-limited", 2000)) : runtime(request));
    query("main p").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.hidden).toBe(false);
    const retry = query<HTMLButtonElement>("[data-action='retranslate']");
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toContain("等待");
    await vi.advanceTimersByTimeAsync(2100);
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("重试翻译");
    vi.mocked(sendRuntimeRequest).mockImplementation(runtime);
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(translationRequests()).toHaveLength(2);
    expect(query(".wupage-translation").textContent).toBe("继续之前，请阅读此段内容。");
    await setParagraphMode(false);
  });

  it("follows paragraph mode changes from other tabs without clearing existing translations", async () => {
    await setParagraphMode(true);
    query("main p").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await vi.waitFor(() => expect(document.querySelector(".wupage-translation")?.textContent).toContain("继续之前"));
    const output = document.querySelector(".wupage-translation");
    storageChanged({ [PARAGRAPH_MODE_KEY]: { newValue: false } }, "local");
    expect(getParagraphMode()).toBe(false);
    expect(document.querySelector(".wupage-translation")).toBe(output);
    expect(translationRequests()).toHaveLength(1);
  });

  it("keeps paragraph mode unchanged when its global save fails", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => request.type === "SET_PARAGRAPH_MODE"
      ? Promise.reject(new Error("storage unavailable")) : runtime(request));
    await expect(setParagraphMode(true)).rejects.toThrow("storage unavailable");
    expect(getParagraphMode()).toBe(false);
    expect(document.documentElement.classList.contains("wupage-paragraph-mode")).toBe(false);
  });

  it("shows paragraph instructions inline without an extra confirmation", async () => {
    const alert = vi.spyOn(window, "alert");
    await setParagraphMode(true);
    expect(query<HTMLButtonElement>("[data-action='paragraph-mode']").getAttribute("aria-pressed")).toBe("true");
    expect(query<HTMLSelectElement>("[data-role='display-mode']").value).toBe(stored.translationDisplayMode);
    expect(query(".wupage-menu-hint").textContent).toContain("Ctrl");
    expect(alert).not.toHaveBeenCalled();
    await setParagraphMode(false);
  });

  it("toggles paragraph translation with a button independently of its display style", async () => {
    const toggle = query<HTMLButtonElement>("[data-action='paragraph-mode']");
    const mode = query<HTMLSelectElement>("[data-role='display-mode']");
    expect(mode.querySelector('option[value="paragraph"]')).toBeNull();
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(getParagraphMode()).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    mode.value = "replace";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(stored.translationDisplayMode).toBe("replace"));
    expect(getParagraphMode()).toBe(true);
    await vi.waitFor(() => expect(mode.disabled).toBe(false));
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(query<HTMLElement>(".wupage-menu-hint").hidden).toBe(true);
    expect(mode.value).toBe("replace");
  });

  it("respects independent paragraph, floating keyboard and dismissal switches", async () => {
    stored.shortcutEnabled = { ...stored.shortcutEnabled!, "paragraph-click": false, "floating-controls": false, "dismiss-overlays": false };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    await setParagraphMode(true);
    query("main p").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
    expect(translationRequests()).toHaveLength(0);
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    for (const key of ["Enter", " ", "ArrowDown"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      ball.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    }
    const menu = query<HTMLElement>("#wupage-floating-menu"); menu.hidden = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(false);
    stored.shortcutEnabled = { ...stored.shortcutEnabled, "dismiss-overlays": true };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    await setParagraphMode(false);
  });

  it("supports keyboard access, escape, settings, and external visibility changes", async () => {
    const ball = query<HTMLButtonElement>("#wupage-floating-ball");
    ball.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const menu = query<HTMLElement>("#wupage-floating-menu");
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(query("[data-role='source-lang']"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(ball);
    hover();
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    query<HTMLButtonElement>("[data-action='settings']").click();
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "OPEN_OPTIONS_PAGE" });
    storageChanged({ [SETTINGS_KEY]: { newValue: { ...stored, floatingBallEnabled: false } } }, "local");
    expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(true);
    expect(menu.hidden).toBe(true);
  });

  it("preserves selection preferences, rolls back failed changes and follows external settings", async () => {
    stored.selectionTranslation = { enabled: true, provider: "bing", style: "underline" };
    const toggle = query<HTMLButtonElement>("[data-action='selection-translation']");
    toggle.click();
    await vi.waitFor(() => expect(stored.selectionTranslation?.enabled).toBe(false));
    expect(stored.selectionTranslation).toEqual({ enabled: false, provider: "bing", style: "underline" });
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "SAVE_SETTINGS") throw new Error("保存失败");
      return runtime(request);
    });
    toggle.click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("保存失败"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.disabled).toBe(false);
    stored.selectionTranslation.enabled = true;
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("gates image translation on the model and supports installing, enabling and removing it", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    let installed = false;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "INSTALL_OCR") installed = true;
      if (request.type === "REMOVE_OCR") { installed = false; stored.imageTranslationEnabled = false; }
      if (["GET_OCR_STATUS", "INSTALL_OCR", "REMOVE_OCR"].includes(request.type)) {
        return { state: installed ? "installed" : "missing", downloaded: installed ? 100 : 0, total: 100 };
      }
      return runtime(request);
    });
    query("#wupage-floating-ball").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const image = query<HTMLButtonElement>("[data-action='image-translation']");
    const model = query<HTMLButtonElement>("[data-role='ocr-action']");
    await vi.waitFor(() => expect(model.title).toContain("安装 OCR"));
    expect(image.disabled).toBe(true);
    query<HTMLButtonElement>(".ocr-help-trigger").click();
    expect(query<HTMLElement>("#wupage-ocr-help").hidden).toBe(false);
    expect(stored.imageTranslationEnabled).toBe(false);
    model.click();
    await vi.waitFor(() => expect(image.disabled).toBe(false));
    image.click();
    await vi.waitFor(() => expect(stored.imageTranslationEnabled).toBe(true));
    expect(image.getAttribute("aria-pressed")).toBe("true");
    model.click();
    await vi.waitFor(() => expect(image.disabled).toBe(true));
    expect(image.getAttribute("aria-pressed")).toBe("false");
    expect(stored.imageTranslationEnabled).toBe(false);
  });

  it("prevents repeated image saves and restores the previous value after failure", async () => {
    query("#wupage-floating-ball").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const toggle = query<HTMLButtonElement>("[data-action='image-translation']");
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    let rejectSave!: (error: Error) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "SAVE_SETTINGS") await new Promise((_, reject) => { rejectSave = reject; });
      return runtime(request);
    });
    toggle.click();
    await vi.waitFor(() => expect(rejectSave).toBeTypeOf("function"));
    toggle.click();
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "SAVE_SETTINGS")).toHaveLength(1);
    rejectSave(new Error("图片开关保存失败"));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(stored.imageTranslationEnabled).toBe(false);
  });

  it("restores the floating ball when its switch cannot be saved", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "SAVE_SETTINGS") throw new Error("保存失败");
      return runtime(request);
    });
    query<HTMLButtonElement>("[data-action='close']").click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("保存失败"));
    expect(query<HTMLElement>("#wupage-floating-hitbox").hidden).toBe(false);
    expect(query<HTMLElement>("#wupage-floating-menu").hidden).toBe(false);
  });

  it("adds the current website from the floating menu and follows external rule changes", async () => {
    const add = query<HTMLButtonElement>("[data-action='add-auto-site']");
    expect(add.hidden).toBe(true);
    stored.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(add.hidden).toBe(false);
    expect(add.disabled).toBe(false);
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    expect(stored.autoTranslation).toMatchObject({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [
      { id: expect.any(String), pattern: window.location.host, enabled: true }
    ] });
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("plus"));
    expect(stored.autoTranslation!.excludedSites).toEqual([window.location.host]);
    add.click(); await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
    expect(stored.autoTranslation!.excludedSites).toBeUndefined();
    expect(stored.autoTranslation!.customSites).toHaveLength(1);
    stored.autoTranslation.enabled = false;
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(add.hidden).toBe(true);
  });

  it("does not overwrite saved menu settings when an older refresh finishes later", async () => {
    const previous = structuredClone(stored);
    let finishSettings!: (value: unknown) => void;
    let delay = true;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => {
      if (request.type === "GET_SETTINGS" && delay) {
        delay = false;
        return new Promise(resolve => { finishSettings = resolve; });
      }
      return runtime(request);
    });
    query("#wupage-floating-ball").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await vi.waitFor(() => expect(finishSettings).toBeTypeOf("function"));
    stored = { ...stored, sourceLang: "ja", targetLang: "en", activeProviderId: "deepseek", translationDisplayMode: "replace",
      contextMenuTranslationEnabled: false, selectionTranslation: { enabled: false, provider: "bing", style: "underline" },
      autoTranslation: { enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] } };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    expect(query("[data-action='auto-translation']").getAttribute("aria-pressed")).toBe("true");
    finishSettings(previous);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(query("[data-action='auto-translation']").getAttribute("aria-pressed")).toBe("true");
    expect(query<HTMLButtonElement>("[data-action='add-auto-site']").hidden).toBe(false);
    expect(query<HTMLSelectElement>("[data-role='source-lang']").value).toBe("ja");
    expect(query<HTMLSelectElement>("[data-role='target-lang']").value).toBe("en");
    expect(query<HTMLSelectElement>("[data-role='provider']").value).toBe("deepseek");
    expect(query<HTMLSelectElement>("[data-role='display-mode']").value).toBe("replace");
    expect(query("[data-action='selection-translation']").getAttribute("aria-pressed")).toBe("false");
    expect(query("[data-action='context-menu-translation']").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a failed website addition retryable without losing existing rules", async () => {
    stored.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] };
    storageChanged({ [SETTINGS_KEY]: { newValue: stored } }, "local");
    const add = query<HTMLButtonElement>("[data-action='add-auto-site']");
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "SAVE_SETTINGS") throw new Error("添加网站失败");
      return runtime(request);
    });
    add.click();
    await vi.waitFor(() => expect(query("[data-role='translation-status']").textContent).toContain("添加网站失败"));
    expect(stored.autoTranslation.customSites).toEqual([]);
    expect(add.disabled).toBe(false);
    expect(add.querySelector('svg')?.dataset.icon).toBe("plus");
    vi.mocked(sendRuntimeRequest).mockImplementation(runtime);
    add.click();
    await vi.waitFor(() => expect(add.querySelector('svg')?.dataset.icon).toBe("tick"));
  });
});

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function selectMode(value: string): void {
  const select = query<HTMLSelectElement>("[data-role='display-mode']");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function pointer(type: string, clientX: number, clientY: number, pointerType = "mouse"): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY }, pointerId: { value: 1 },
    pointerType: { value: pointerType }, button: { value: 0 } });
  return event;
}
