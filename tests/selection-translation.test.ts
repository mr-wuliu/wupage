// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn(), hasRuntimeContext: () => true }));

import { initSelectionTranslation } from "../src/content/selection-translation";
import { sendRuntimeRequest } from "../src/content/runtime";

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

describe("selection translation", () => {
  let cleanup: () => void;
  let settings: ExtensionSettings;
  let selectionRect: DOMRect;
  let settingsChanged: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p id='source'>Surrounding private context. <span>Selected words</span> More private context.</p><p id='other'>Another selection</p></main>";
    window.getSelection()!.removeAllRanges();
    settings = structuredClone(DEFAULT_SETTINGS);
    selectionRect = rect(100, 100, 180, 24);
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: vi.fn(() => Object.assign([selectionRect], { item: (index: number) => index === 0 ? selectionRect : null }))
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: vi.fn(() => selectionRect) });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.getAttribute("role") === "dialog" ? rect(0, 0, 320, 180) : rect(0, 0, 32, 32);
    });
    vi.stubGlobal("chrome", { runtime: { id: "test" }, storage: {
      local: { get: vi.fn(async () => ({ "wupage.settings": structuredClone(settings) })) },
      onChanged: { addListener: vi.fn(listener => { settingsChanged = listener; }), removeListener: vi.fn() }
    } });
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return structuredClone(settings);
      if (request.type === "TRANSLATE_BATCH") return { translations: ["选中的文字"], cached: 0 };
      return undefined;
    });
    cleanup = initSelectionTranslation();
  });

  afterEach(() => {
    cleanup();
    window.getSelection()!.removeAllRanges();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(sendRuntimeRequest).mockReset();
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
    if (originalBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    document.body.replaceChildren();
  });

  function select(element = document.querySelector("#source span")!): void {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function shadow(): ShadowRoot {
    const root = document.querySelector("#wupage-selection-translator")?.shadowRoot;
    if (!root) throw new Error("Selection translator must expose an open shadow root");
    return root;
  }

  function query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = shadow().querySelector<T>(selector);
    if (!element) throw new Error(`Missing selection translator element: ${selector}`);
    return element;
  }

  // jsdom has no layout: check the element and both its shadow/light-DOM ancestors.
  function visible(selector: string): boolean {
    let element: Element | null = document.querySelector("#wupage-selection-translator")?.shadowRoot?.querySelector(selector) ?? null;
    if (!element) return false;
    while (element) {
      if (element instanceof HTMLElement && (element.hidden || element.style.display === "none" || element.style.visibility === "hidden")) return false;
      const root = element.getRootNode();
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return true;
  }

  function translationRequests() {
    return vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request)
      .filter((request) => request.type === "TRANSLATE_BATCH");
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  async function showIcon(): Promise<void> {
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(true);
  }

  function shortcut(target: EventTarget = document): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "T", code: "KeyT", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function dismiss(): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function deferTranslations(): Array<(value: unknown) => void> {
    const completions: Array<(value: unknown) => void> = [];
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "TRANSLATE_BATCH"
      ? new Promise((resolve) => { completions.push(resolve); }) : runtime(request));
    return completions;
  }

  it("debounces selection changes for 180 ms without translating automatically", async () => {
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(100);
    expect(visible('[data-action="translate"]')).toBe(false);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(179);
    expect(visible('[data-action="translate"]')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(visible('[data-action="translate"]')).toBe(true);
    expect(shadow().mode).toBe("open");
    expect(visible('[role="dialog"]')).toBe(false);
    expect(translationRequests()).toHaveLength(0);
  });

  it("also schedules selection inspection on mouseup", async () => {
    select();
    document.querySelector("main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(179);
    expect(visible('[data-action="translate"]')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(visible('[data-action="translate"]')).toBe(true);
    expect(translationRequests()).toHaveLength(0);
  });

  it.each(["", " \n\t ", "x".repeat(5001)])("does not offer translation for empty, whitespace-only, or oversized text (%#)", async (text) => {
    document.querySelector("#source span")!.textContent = text;
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut().defaultPrevented).toBe(false);
    await settle();
    expect(translationRequests()).toHaveLength(0);
  });

  it("accepts the 5000-character boundary and hides the icon when selection is cleared", async () => {
    document.querySelector("#source span")!.textContent = "x".repeat(5000);
    await showIcon();
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(translationRequests()).toHaveLength(0);
  });

  it.each(["true", "", "plaintext-only"])("excludes selections nested in contenteditable=%j", async (value) => {
    document.querySelector("#source")!.setAttribute("contenteditable", value);
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut().defaultPrevented).toBe(false);
    await settle();
    expect(translationRequests()).toHaveLength(0);
  });

  it.each(["input", "textarea"])("does not intercept translation while an %s has focus", async (tag) => {
    select();
    const field = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
    field.value = "Editable selection";
    document.body.append(field);
    field.focus();
    field.setSelectionRange(0, field.value.length);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut(field).defaultPrevented).toBe(false);
    await settle();
    expect(translationRequests()).toHaveLength(0);
  });

  it("ignores extension UI selections", async () => {
    const extension = document.createElement("div");
    extension.id = "wupage-floating-menu";
    extension.innerHTML = "<span>Extension controls</span>";
    document.body.append(extension);
    select(extension.firstElementChild!);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut().defaultPrevented).toBe(false);
    await settle();
    expect(translationRequests()).toHaveLength(0);
  });

  it("requests current settings on activation and sends only the trimmed selected text", async () => {
    document.querySelector("#source span")!.textContent = " \n Selected words \t ";
    await showIcon();
    settings.sourceLang = "en";
    settings.targetLang = "ja";
    settings.activeProviderId = "deepseek";
    vi.mocked(sendRuntimeRequest).mockClear();
    query<HTMLButtonElement>('[data-action="translate"]').click();
    await settle();
    expect(vi.mocked(sendRuntimeRequest).mock.calls[0][0]).toEqual({ type: "GET_SETTINGS" });
    expect(translationRequests()).toHaveLength(1);
    expect(translationRequests()[0]).toEqual({
      type: "TRANSLATE_BATCH", texts: ["Selected words"], sourceLang: "en", targetLang: "ja", providerId: "deepseek"
    });
    expect(visible('[role="dialog"]')).toBe(true);
    expect(query('[data-role="result"]').textContent).toBe("选中的文字");
  });

  it("translates the live selection immediately with Alt+Shift+T, without a preceding selectionchange", async () => {
    await showIcon();
    select(document.querySelector("#other")!);
    const event = shortcut();
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(translationRequests()).toHaveLength(1);
    expect(translationRequests()[0].texts).toEqual(["Another selection"]);
    expect(visible('[role="dialog"]')).toBe(true);
  });

  it("leaves unrelated shortcuts and Alt+Shift+T without selected text alone", async () => {
    expect(shortcut().defaultPrevented).toBe(false);
    select();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", altKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(translationRequests()).toHaveLength(0);
  });

  it("renders provider output as text, never as executable markup", async () => {
    const output = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => request.type === "TRANSLATE_BATCH"
      ? { translations: [output], cached: 0 } : runtime(request));
    select();
    shortcut();
    await settle();
    expect(query('[data-role="result"]').textContent).toBe(output);
    expect(query('[data-role="result"]').querySelector("img, script")).toBeNull();
  });

  it("shows a failed request and retries using the selected text and latest settings", async () => {
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => {
      if (request.type === "TRANSLATE_BATCH" && attempts++ === 0) throw new Error("Provider temporarily unavailable");
      return runtime(request);
    });
    select();
    shortcut();
    await settle();
    expect(shadow().textContent).toContain("Provider temporarily unavailable");
    expect(visible('[data-action="retry"]')).toBe(true);
    settings.targetLang = "fr";
    query<HTMLButtonElement>('[data-action="retry"]').click();
    await settle();
    expect(translationRequests()).toHaveLength(2);
    expect(translationRequests()[1]).toMatchObject({ texts: ["Selected words"], targetLang: "fr" });
    expect(query('[data-role="result"]').textContent).toBe("选中的文字");
  });

  it.each(["escape", "close", "outside"])("dismisses via %s and ignores the pending translation", async (method) => {
    const completions = deferTranslations();
    select();
    shortcut();
    await settle();
    expect(completions).toHaveLength(1);
    if (method === "escape") dismiss();
    else if (method === "close") query<HTMLButtonElement>('[data-action="close"]').click();
    else {
      const outside = document.querySelector("main")!;
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(visible('[role="dialog"]')).toBe(false);
    completions[0]({ translations: ["Stale dismissed result"], cached: 0 });
    await settle();
    expect(visible('[role="dialog"]')).toBe(false);
    expect(shadow().textContent).not.toContain("Stale dismissed result");
  });

  it("cancels a pending debounce on Escape instead of reopening the icon", async () => {
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(60);
    dismiss();
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(visible('[role="dialog"]')).toBe(false);
  });

  it("does not start translation when settings arrive after dismissal", async () => {
    let finishSettings!: (value: unknown) => void;
    const runtime = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation((request) => request.type === "GET_SETTINGS"
      ? new Promise((resolve) => { finishSettings = resolve; }) : runtime(request));
    select();
    shortcut();
    await settle();
    expect(finishSettings).toBeTypeOf("function");
    dismiss();
    finishSettings(settings);
    await settle();
    expect(translationRequests()).toHaveLength(0);
    expect(visible('[role="dialog"]')).toBe(false);
  });

  it("invalidates an in-flight translation as soon as a new selection is observed", async () => {
    const completions = deferTranslations();
    select();
    shortcut();
    await settle();
    select(document.querySelector("#other")!);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    completions[0]({ translations: ["Old selection result"], cached: 0 });
    await settle();
    expect(shadow().textContent).not.toContain("Old selection result");
    expect(translationRequests()).toHaveLength(1);
    shortcut();
    await settle();
    expect(translationRequests()[1].texts).toEqual(["Another selection"]);
    completions[1]({ translations: ["New selection result"], cached: 0 });
    await settle();
    expect(query('[data-role="result"]').textContent).toBe("New selection result");
  });

  it("does not let an older response overwrite a newer translation", async () => {
    const completions = deferTranslations();
    select();
    shortcut();
    await settle();
    select(document.querySelector("#other")!);
    shortcut();
    await settle();
    expect(completions).toHaveLength(2);
    completions[1]({ translations: ["Latest translation"], cached: 0 });
    await settle();
    completions[0]({ translations: ["Obsolete translation"], cached: 0 });
    await settle();
    expect(query('[data-role="result"]').textContent).toBe("Latest translation");
  });

  it("repositions the icon after scrolling and resizing without translating", async () => {
    await showIcon();
    const icon = query('[data-action="translate"]');
    const position = () => [document.querySelector<HTMLElement>("#wupage-selection-translator")!.style.cssText, icon.style.cssText];
    const initial = position();
    selectionRect = rect(220, 190, 180, 24);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(180);
    expect(position()).not.toEqual(initial);
    const scrolled = position();
    selectionRect = rect(340, 260, 180, 24);
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(180);
    expect(position()).not.toEqual(scrolled);
    expect(translationRequests()).toHaveLength(0);
  });

  function changePreferences(showIcon: boolean, key: string): void {
    settings.selectionTranslation = { showIcon, shortcut: key };
    settingsChanged({ "wupage.settings": { newValue: structuredClone(settings) } }, "local");
  }

  it("loads saved icon-off and custom shortcut settings on startup", async () => {
    cleanup();
    settings.selectionTranslation = { showIcon: false, shortcut: "Ctrl+Shift+E" };
    cleanup = initSelectionTranslation();
    await settle();
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut().defaultPrevented).toBe(false);
    const event = new KeyboardEvent("keydown", { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(visible('[role="dialog"]')).toBe(true);
  });

  it("updates icon visibility and shortcut immediately without reloading", async () => {
    await showIcon();
    changePreferences(false, "Ctrl+Shift+E");
    expect(visible('[data-action="translate"]')).toBe(false);
    expect(shortcut().defaultPrevented).toBe(false);
    changePreferences(true, "Ctrl+Shift+E");
    expect(visible('[data-action="translate"]')).toBe(true);
    expect(query('[data-action="translate"]').title).toContain("Ctrl + Shift + E");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(translationRequests()).toHaveLength(1);
  });

  it("clearing the shortcut leaves icon activation available", async () => {
    await showIcon();
    changePreferences(true, "");
    expect(shortcut().defaultPrevented).toBe(false);
    expect(query('[data-action="translate"]').title).not.toContain("Alt");
    query<HTMLButtonElement>('[data-action="translate"]').click();
    await settle();
    expect(translationRequests()).toHaveLength(1);
  });

  it("does not show the icon during pointer selection and fades in after release", async () => {
    document.querySelector("main")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    select();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(500);
    expect(visible('[data-action="translate"]')).toBe(false);
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(180);
    expect(visible('[data-action="translate"]')).toBe(true);
    expect(query('[data-action="translate"]').querySelector("svg")).toBeNull();
    expect(query('[data-action="translate"]').querySelector(".trigger-dot")).not.toBeNull();
    expect(query('[data-action="translate"]').textContent).toBe("");
  });

  it("places the dot at the lower right of the final line and clamps at the right edge", async () => {
    await showIcon();
    const icon = query('[data-action="translate"]');
    expect(icon.style.left).toBe("270px");
    expect(icon.style.top).toBe("114px");
    selectionRect = rect(window.innerWidth - 50, 100, 45, 24);
    window.dispatchEvent(new Event("resize"));
    expect(icon.style.top).toBe("114px");
    expect(parseFloat(icon.style.left)).toBeLessThanOrEqual(window.innerWidth - 40);
  });

  it("cleanup removes the host, cancels pending work, and detaches event handlers", async () => {
    select();
    document.dispatchEvent(new Event("selectionchange"));
    cleanup();
    cleanup = () => undefined;
    expect(document.querySelector("#wupage-selection-translator")).toBeNull();
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(shortcut().defaultPrevented).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(240);
    expect(document.querySelector("#wupage-selection-translator")).toBeNull();
    expect(translationRequests()).toHaveLength(0);
  });

  it("cleanup also invalidates a translation already in progress", async () => {
    const completions = deferTranslations();
    select();
    shortcut();
    await settle();
    cleanup();
    cleanup = () => undefined;
    completions[0]({ translations: ["Result after cleanup"], cached: 0 });
    await settle();
    expect(document.querySelector("#wupage-selection-translator")).toBeNull();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, x: left, y: top, width, height, toJSON: () => ({}) };
}
