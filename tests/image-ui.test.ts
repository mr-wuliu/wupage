// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImageTranslationEnabled, translateContextImage } from "../src/content/image-translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { renderImageTranslation, wrapImageText } from "../src/content/image-rendering";
import { sendRuntimeRequest } from "../src/content/runtime";
import type { ImageTextRegion, TranslateImageResponse } from "../src/shared/types";
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn(), hasRuntimeContext: () => true }));

const region: ImageTextRegion = { box: [100, 100, 700, 200], text: "Hello world", translation: "你好，世界", foreground: "#111111", background: "#ffffff", align: "left", bold: false };
const context = { drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(),
  fillText: vi.fn(), measureText: (text: string) => ({ width: Array.from(text).length * 6 }), font: "" };
function shadow() { return document.querySelector("#wupage-image-tools")!.shadowRoot!; }
function button() { return shadow().querySelector("button")!; }
async function movePointer(x = 100, y = 100) {
  document.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,aGVsbG8=");
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 20, left: 20, right: 420, bottom: 220, width: 400, height: 200 } as DOMRect);
  document.body.innerHTML = '<img src="https://example.com/picture.png" alt="Example">';
  const image = document.querySelector("img")!;
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  vi.mocked(sendRuntimeRequest).mockResolvedValue({ regions: [region], targetLang: "zh-CN", cached: false });
});
afterEach(() => {
  setImageTranslationEnabled(false); vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset(); document.body.innerHTML = "";
  context.fillText.mockClear(); context.fillRect.mockClear();
  document.documentElement.removeAttribute("style");
  document.getElementById("wupage-image-context-notice")?.remove();
  delete (document as Partial<Document>).elementFromPoint;
});

describe("image translation controls", () => {
  function contextMessages() {
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request) => request.type === "GET_SETTINGS"
      ? { ...DEFAULT_SETTINGS, imageTranslationEnabled: true }
      : { regions: [region], targetLang: "zh-CN", cached: false });
  }
  it("translates the right-clicked duplicate and keeps repeat menu clicks showing the translation", async () => {
    contextMessages();
    const second = document.querySelector("img")!.cloneNode() as HTMLImageElement;
    Object.defineProperties(second, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    document.body.append(second);
    setImageTranslationEnabled(true);
    second.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(await translateContextImage(second.src)).toEqual({ started: true });
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    expect(shadow().querySelectorAll("button")[0].textContent).toBe("译");
    expect(shadow().querySelectorAll("button")[1].textContent).toBe("原");
    await translateContextImage(second.src);
    expect(shadow().querySelector("canvas")!.hidden).toBe(false);
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_IMAGE")).toHaveLength(1);
  });
  it("shows a manually requested translation when a site overlay hides the automatic button", async () => {
    contextMessages();
    const overlay = document.createElement("div"); document.body.append(overlay);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => overlay });
    setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
    const image = document.querySelector("img")!;
    image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await translateContextImage(image.src);
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    await movePointer();
    expect(button().hidden).toBe(false);
    expect(shadow().querySelector("canvas")!.hidden).toBe(false);
  });
  it("does not translate a different copy after the right-clicked post is removed", async () => {
    contextMessages(); setImageTranslationEnabled(true);
    const image = document.querySelector("img")!;
    image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const url = image.src; image.remove();
    expect(await translateContextImage(url)).toEqual({ started: false });
    expect(document.querySelector("#wupage-image-context-notice")?.shadowRoot?.textContent).toContain("已变化");
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "TRANSLATE_IMAGE")).toBe(false);
  });
  it("overlays the visible background when the clicked img is a transparent accessibility layer", async () => {
    contextMessages();
    const image = document.querySelector("img")!;
    const parent = document.createElement("div");
    parent.style.backgroundImage = `url("${image.src}")`;
    parent.style.backgroundSize = "cover";
    document.body.append(parent); parent.append(image);
    image.style.opacity = "0";
    setImageTranslationEnabled(true);
    await movePointer();
    expect(button().hidden).toBe(false);
    image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await translateContextImage(image.src);
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    const canvas = shadow().querySelector("canvas")!;
    expect(canvas.hidden).toBe(false);
    expect(canvas.style.opacity).not.toBe("0");
    expect(canvas.style.objectFit).toBe("cover");
  });
  it("shows the button and right-click translation on X's sibling background, including after replacement", async () => {
    contextMessages();
    const image = document.querySelector("img")!;
    const photo = document.createElement("div"); photo.dataset.testid = "tweetPhoto"; photo.style.overflow = "hidden";
    let background = document.createElement("div");
    background.style.cssText = `background-image:url("${image.src}");background-size:cover;background-position:50% 50%;opacity:1`;
    document.body.append(photo); photo.append(background, image); image.style.opacity = "0";
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => background });
    setImageTranslationEnabled(true);
    await movePointer();
    expect(button().hidden).toBe(false);
    image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await translateContextImage(image.src);
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    const canvas = shadow().querySelector("canvas")!;
    expect(canvas.hidden).toBe(false);
    expect(canvas.style.opacity).toBe("1");
    expect(canvas.style.objectFit).toBe("cover");
    expect(canvas.style.objectPosition).toBe("50% 50%");
    expect(canvas.style.left).toBe("20px");
    expect(canvas.style.width).toBe("400px");
    background.remove();
    await vi.waitFor(() => expect(canvas.hidden).toBe(true));
    background = background.cloneNode() as HTMLDivElement; photo.prepend(background);
    await vi.waitFor(() => expect(canvas.hidden).toBe(false));
    button().click(); expect(canvas.hidden).toBe(true);
    button().click(); expect(canvas.hidden).toBe(false);
    photo.style.display = "none";
    await vi.waitFor(() => expect(canvas.hidden).toBe(true));
  });
  it.each(["different source", "different bounds"])("does not use a sibling background with %s", (mismatch) => {
    const image = document.querySelector("img")!;
    image.style.opacity = "0";
    const background = document.createElement("div");
    background.style.backgroundImage = `url("${mismatch === "different source" ? "https://example.com/other.png" : image.src}")`;
    if (mismatch === "different bounds") vi.spyOn(background, "getBoundingClientRect").mockReturnValue({ left: 50, top: 20, width: 400, height: 200 } as DOMRect);
    document.body.append(background);
    setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
  });
  it("allows an explicit right-click on an image excluded by automatic size filtering", async () => {
    contextMessages();
    const small = new Image(); small.src = "https://example.com/small.png";
    Object.defineProperties(small, { complete: { value: true }, naturalWidth: { value: 60 }, naturalHeight: { value: 40 } });
    document.body.replaceChildren(small);
    setImageTranslationEnabled(true);
    expect(shadow().querySelector("button")).toBeNull();
    small.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await translateContextImage(small.src);
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
  });
  it("shows partial-result warnings while retaining the valid overlay and original toggle", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue({ regions: [region], targetLang: "zh-CN", cached: false,
      skippedRegions: 1, warning: "另有 1 处识别异常，未覆盖这些区域。" });
    setImageTranslationEnabled(true); button().click();
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    expect(shadow().querySelector(".status")!.textContent).toContain("未覆盖这些区域");
    button().click(); expect(shadow().querySelector("canvas")!.hidden).toBe(true);
  });
  it("only uploads after clicking, overlays translation, and toggles the original without another request", async () => {
    setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
    await movePointer();
    expect(button().hidden).toBe(false);
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
    button().click();
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    expect(context.fillRect).toHaveBeenCalledWith(80, 40, 560, 80);
    expect(context.fillText).toHaveBeenCalled();
    expect(button().textContent).toBe("原");
    button().click(); expect(shadow().querySelector("canvas")!.hidden).toBe(true);
    button().click(); expect(shadow().querySelector("canvas")!.hidden).toBe(false);
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
    expect(document.querySelector("img")!.src).toBe("https://example.com/picture.png");
  });

  it("keeps the hover button reachable across the gap, then hides it without hiding the translation", async () => {
    setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
    await movePointer(); expect(button().hidden).toBe(false);
    await movePointer(422, 30); expect(button().hidden).toBe(false);
    await movePointer(435, 30); expect(button().hidden).toBe(false);
    button().click();
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    await movePointer(700, 300);
    expect(button().hidden).toBe(true);
    expect(shadow().querySelector("canvas")!.hidden).toBe(false);
    await movePointer(); expect(button().hidden).toBe(false);
    window.dispatchEvent(new Event("blur"));
    await vi.waitFor(() => expect(button().hidden).toBe(true));
    setImageTranslationEnabled(false); setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
  });

  it("hides the button after the image scrolls away from a stationary pointer", async () => {
    setImageTranslationEnabled(true); await movePointer();
    expect(button().hidden).toBe(false);
    vi.spyOn(document.querySelector("img")!, "getBoundingClientRect").mockReturnValue({ left: 20, top: 250, right: 420, bottom: 450, width: 400, height: 200 } as DOMRect);
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(button().hidden).toBe(true));
  });

  it("shows hover controls and translation in a fixed X photo viewer after root scrolling is locked", async () => {
    const image = document.querySelector("img")!;
    const viewer = document.createElement("div"); viewer.style.position = "fixed";
    const background = document.createElement("div");
    background.style.backgroundImage = `url("${image.src}")`;
    document.body.append(viewer); viewer.append(background, image); image.style.opacity = "0";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overflowX = "hidden";
    document.documentElement.style.overflowY = "hidden";
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({ left: 0, top: -2100, right: 1024, bottom: -1332, width: 1024, height: 768 } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => image });
    setImageTranslationEnabled(true);
    expect(button().hidden).toBe(true);
    await movePointer(); expect(button().hidden).toBe(false);
    button().click();
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
    expect(shadow().querySelector("canvas")!.hidden).toBe(false);
    await movePointer(700, 300); expect(button().hidden).toBe(true);
    expect(shadow().querySelector("canvas")!.hidden).toBe(false);
  });

  it("still clips images hidden by an ordinary scroll container", async () => {
    const pane = document.createElement("div"); pane.style.overflowX = "hidden"; pane.style.overflowY = "hidden";
    document.body.append(pane); pane.append(document.querySelector("img")!);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ left: 0, top: -250, right: 500, bottom: -50, width: 500, height: 200 } as DOMRect);
    setImageTranslationEnabled(true); await movePointer();
    expect(button().hidden).toBe(true);
  });

  it("does not display a late response after the switch is disabled", async () => {
    let release!: (result: TranslateImageResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    setImageTranslationEnabled(true); button().click();
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalled());
    setImageTranslationEnabled(false);
    release({ regions: [region], targetLang: "zh-CN", cached: false });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector("#wupage-image-tools")).toBeNull();
  });

  it("discards results if a lazy-loaded image changes source while translating", async () => {
    let release!: (result: TranslateImageResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    setImageTranslationEnabled(true); button().click();
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalled());
    document.querySelector("img")!.src = "https://example.com/other.png";
    release({ regions: [region], targetLang: "zh-CN", cached: false });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(shadow().querySelector("canvas")).toBeNull();
  });

  it("keeps the source visible and allows retry when translation fails", async () => {
    vi.mocked(sendRuntimeRequest).mockRejectedValueOnce(new Error("Service unavailable"));
    setImageTranslationEnabled(true); button().click();
    await vi.waitFor(() => expect(shadow().querySelector(".status")!.textContent).toContain("Service unavailable"));
    expect(button().disabled).toBe(false); expect(shadow().querySelector("canvas")).toBeNull();
    button().click();
    await vi.waitFor(() => expect(shadow().querySelector("canvas")).not.toBeNull());
  });

  it("wraps mixed-language text and paints only bounded regions", () => {
    const lines = wrapImageText(context as unknown as CanvasRenderingContext2D, "Hello world 这是长句子\nNext", 36);
    expect(lines.every((line) => context.measureText(line).width <= 36)).toBe(true);
    expect(lines.join("")).toContain("这是长句子");
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 400;
    renderImageTranslation(canvas, document.querySelector("img")!, [region]);
    expect(context.rect).toHaveBeenCalledWith(80, 40, 560, 80);
    expect(context.clip).toHaveBeenCalled();
  });
});
