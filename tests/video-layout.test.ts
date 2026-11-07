// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoView, type VideoViewActions } from "../src/content/video-view";
import { subtitleLayoutBounds } from "../src/content/video-layout";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { DEFAULT_VIDEO_LAYOUT, normalizeVideoTranslation } from "../src/shared/video";

let view: VideoView;
let actions: VideoViewActions;
const query = <T extends HTMLElement = HTMLElement>(selector: string) => view.root.querySelector<T>(selector)!;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const range = (selector: string, value: number) => { const input = query<HTMLInputElement>(selector); input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true })); };
const open = () => query<HTMLButtonElement>(".layout-open").click();
const click = (selector: string) => query<HTMLButtonElement>(selector).click();
const pointer = (target: HTMLElement, type: string, x: number, y: number, id = 1) => {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, button: { value: 0 }, pointerId: { value: id }, isPrimary: { value: true } });
  target.dispatchEvent(event); return event;
};

beforeEach(() => {
  actions = { toggle: vi.fn(), frame: vi.fn(), retry: vi.fn(), source: vi.fn(), settings: vi.fn(), preferences: vi.fn(), layout: vi.fn(async () => {}), import: vi.fn(), offset: vi.fn() };
  view = new VideoView(actions, "fixture"); document.body.append(view.host);
  view.host.style.setProperty("--wp-layer-width", "640px"); view.host.style.setProperty("--wp-layer-height", "360px");
  vi.spyOn(view.host, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 640, 360));
  for (const selector of [".captions", ".layout-preview"]) {
    Object.defineProperty(query(selector), "offsetHeight", { configurable: true, value: 70 });
  }
  const preview = query(".layout-preview");
  vi.spyOn(preview, "getBoundingClientRect").mockImplementation(() => {
    const width = parseFloat(preview.style.width) / 100 * 640;
    return new DOMRect(100 + parseFloat(preview.style.left) - width / 2, 50 + 360 - parseFloat(preview.style.bottom) - 70, width, 70);
  });
  view.settings(DEFAULT_SETTINGS, "fixture");
});

afterEach(() => { view.dispose(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("subtitle layout editing", () => {
  it("rolls long Western originals while translated pages keep following media time", () => {
    const preferences = normalizeVideoTranslation({ displayMode: "western" });
    view.settings({ ...DEFAULT_SETTINGS, videoTranslation: preferences }, "fixture");
    const source = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const translated = "译文内容".repeat(60);
    const first = view.render(source, translated, preferences, 0);
    expect(first.source).toContain("word39");
    expect(first.source).not.toContain("word0");
    expect(first.source.split("\n").length).toBeLessThanOrEqual(2);
    const later = view.render(source, translated, preferences, .9);
    expect(later.source).toBe(first.source);
    expect(later.translation).not.toBe(first.translation);
    expect(view.render("word0 word1", translated, preferences, 0).source).toBe("word0 word1");
  });
  it("opens layout editing without invoking the file picker and reserves the picker for subtitle import", () => {
    const picker = vi.spyOn(query<HTMLInputElement>(".file"), "click");
    open();
    expect(view.host.hasAttribute("data-layout-editing")).toBe(true);
    expect(picker).not.toHaveBeenCalled();
    click(".layout-cancel");
    click(".import");
    expect(picker).toHaveBeenCalledOnce();
    expect(view.host.hasAttribute("data-layout-editing")).toBe(false);
  });

  it("previews stable text and appearance without saving or changing live subtitles, and cancels with Escape", () => {
    view.render("Original subtitle", "原译文", normalizeVideoTranslation(undefined));
    const before = query(".captions").style.cssText;
    open(); range(".layout-width", 60); range(".layout-font", 28);
    view.render("Next subtitle", "下一条", normalizeVideoTranslation(undefined));
    expect(query(".layout-preview .translation span").textContent).toBe("原译文");
    expect(query(".layout-preview").style.width).toBe("60%");
    expect(query(".layout-preview").style.getPropertyValue("--wp-video-font")).toBe("28px");
    expect(actions.layout).not.toHaveBeenCalled(); expect(actions.preferences).not.toHaveBeenCalled();
    query(".layout-width").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.host.hasAttribute("data-layout-editing")).toBe(false);
    expect(query(".captions").style.cssText).toBe(before);
    expect(query(".captions .translation span").textContent).toBe("下一条");
  });

  it("provides a sample in subtitle gaps, supports keyboard movement, and saves only on Done", async () => {
    open();
    expect(query(".layout-preview .translation span").textContent).toContain("拖动调整");
    query(".layout-preview").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }));
    range(".layout-width", 65); range(".layout-font", 30);
    click(".layout-done"); click(".layout-done"); await flush();
    expect(actions.layout).toHaveBeenCalledExactlyOnceWith({ x: 50, bottom: 15, width: 65, fontSize: 30 });
    expect(view.host.hasAttribute("data-layout-editing")).toBe(false);
    expect(query(".captions").style.width).toBe("65%");
  });

  it("moves both caption lines, captures a drag, ignores other pointers, and keeps resizing inside the player", async () => {
    open(); range(".layout-width", 60);
    const preview = query(".layout-preview");
    const capture = vi.fn(), release = vi.fn();
    preview.setPointerCapture = capture; preview.hasPointerCapture = () => true; preview.releasePointerCapture = release;
    pointer(preview, "pointerdown", 400, 300); expect(capture).toHaveBeenCalledWith(1);
    pointer(preview, "pointermove", 464, 264, 2);
    expect(preview.style.left).toBe("320px");
    pointer(preview, "pointermove", 464, 264); pointer(preview, "pointerup", 464, 264);
    expect(release).toHaveBeenCalledWith(1);
    expect(preview.style.left).toBe("384px"); expect(preview.style.bottom).toBe("72px");
    const right = query(".layout-right");
    pointer(right, "pointerdown", 676, 300); pointer(right, "pointermove", 2000, 300); pointer(right, "pointerup", 2000, 300);
    const width = parseFloat(preview.style.width) / 100 * 640;
    expect(parseFloat(preview.style.left) + width / 2).toBeLessThanOrEqual(632.01);
    click(".layout-done"); await flush(); expect(actions.layout).toHaveBeenCalledOnce();
  });

  it("converts transformed player coordinates before saving", async () => {
    view.host.getBoundingClientRect = () => new DOMRect(100, 50, 320, 180);
    query(".layout-preview").getBoundingClientRect = () => new DOMRect(116, 177, 288, 35);
    open();
    const preview = query(".layout-preview");
    pointer(preview, "pointerdown", 240, 190); pointer(preview, "pointermove", 240, 172); pointer(preview, "pointercancel", 240, 172);
    click(".layout-done"); await flush();
    expect(actions.layout).toHaveBeenCalledWith(expect.objectContaining({ x: 50, bottom: 20 }));
  });

  it("keeps the editor open after a failed save and permits retry", async () => {
    vi.mocked(actions.layout).mockRejectedValueOnce(new Error("storage failure"));
    open(); range(".layout-font", 32); click(".layout-done"); await flush();
    expect(view.host.hasAttribute("data-layout-editing")).toBe(true);
    expect(query(".layout-error").hidden).toBe(false);
    expect(query<HTMLButtonElement>(".layout-done").disabled).toBe(false);
    click(".layout-done"); await flush();
    expect(actions.layout).toHaveBeenCalledTimes(2);
    expect(view.host.hasAttribute("data-layout-editing")).toBe(false);
  });

  it("loads only the current website layout and resets the draft without saving until Done", async () => {
    const preferences = normalizeVideoTranslation({ siteLayouts: [
      { id: location.hostname, x: 45, bottom: 25, width: 60, fontSize: 32 },
      { id: "other.example", x: 50, bottom: 30, width: 40, fontSize: 28 }
    ] });
    view.settings({ ...DEFAULT_SETTINGS, videoTranslation: preferences }, "fixture");
    expect(query(".captions").style.width).toBe("60%");
    expect(query<HTMLSelectElement>(".font").value).toBe("32");
    open(); click(".layout-reset"); expect(actions.layout).not.toHaveBeenCalled(); click(".layout-cancel");
    expect(query(".captions").style.width).toBe("60%");
    open(); click(".layout-reset"); click(".layout-done"); await flush();
    expect(actions.layout).toHaveBeenCalledWith(DEFAULT_VIDEO_LAYOUT);
  });
  it("does not replace newer storage settings with a delayed save acknowledgement", async () => {
    let finish!: () => void;
    vi.mocked(actions.layout).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    open(); range(".layout-width", 40); click(".layout-done");
    view.settings({ ...DEFAULT_SETTINGS, videoTranslation: normalizeVideoTranslation({ siteLayouts: [
      { id: location.hostname, x: 50, bottom: 20, width: 75, fontSize: 24 }
    ] }) }, "fixture");
    finish(); await flush();
    expect(query(".captions").style.width).toBe("75%");
  });

  it("temporarily clamps a saved bottom edge on small players and restores it when enlarged", () => {
    const settings = { ...DEFAULT_SETTINGS, videoTranslation: normalizeVideoTranslation({ siteLayouts: [
      { id: location.hostname, x: 50, bottom: 80, width: 70, fontSize: 22 }
    ] }) };
    view.settings(settings, "fixture");
    expect(parseFloat(query(".captions").style.bottom)).toBeCloseTo(282.8);
    view.host.style.setProperty("--wp-layer-height", "180px"); view.resizeLayout();
    expect(parseFloat(query(".captions").style.bottom)).toBe(106.4);
    view.host.style.setProperty("--wp-layer-height", "600px"); view.resizeLayout();
    expect(parseFloat(query(".captions").style.bottom)).toBe(480);
    expect(actions.layout).not.toHaveBeenCalled();
  });

  it("cancels an unsaved edit when native video fullscreen hides the overlay", () => {
    open(); range(".layout-width", 40); view.host.hidden = true; view.resizeLayout();
    expect(view.host.hasAttribute("data-layout-editing")).toBe(false);
    expect(actions.layout).not.toHaveBeenCalled();
  });
});

describe("subtitle layout settings", () => {
  it("keeps old settings compatible and bounds invalid imported layouts", () => {
    expect(normalizeVideoTranslation(undefined)).not.toHaveProperty("siteLayouts");
    expect(normalizeVideoTranslation({ siteLayouts: [null, { id: "bad/site" },
      { id: "example.com", x: -50, bottom: Infinity, width: 400, fontSize: 1 },
      { id: "[::1]", x: 50, bottom: 10, width: 90, fontSize: 22 }
    ] }).siteLayouts).toEqual([
      { id: "example.com", x: 2, bottom: 10, width: 96, fontSize: 14 },
      { id: "[::1]", ...DEFAULT_VIDEO_LAYOUT }
    ]);
  });

  it("constrains the complete box while keeping the saved layout unchanged", () => {
    const layout = { x: 98, bottom: 98, width: 90, fontSize: 22 };
    const bounds = subtitleLayoutBounds(layout, 640, 360, 90);
    expect(bounds.width).toBe(576); expect(bounds.x).toBeCloseTo(344.8); expect(bounds.bottom).toBeCloseTo(262.8);
    expect(layout.x).toBe(98); expect(layout.bottom).toBe(98);
  });
});
