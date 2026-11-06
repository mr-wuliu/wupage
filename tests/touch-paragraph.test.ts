// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchParagraphController } from "../src/content/touch-paragraph";
import { translateParagraph } from "../src/content/paragraph-translation";

vi.mock("../src/content/paragraph-translation", () => ({ translateParagraph: vi.fn(async () => {}) }));
let controller: TouchParagraphController;
function pointer(type: string, target: Element, x = 50, y = 100) {
  const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}
function tap(target: Element) {
  pointer("pointerdown", target); pointer("pointerup", target);
  const event = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 });
  target.dispatchEvent(event); return event;
}
beforeEach(() => {
  document.body.innerHTML = '<p id="first">Read this paragraph before continuing.</p><p id="second">Another paragraph with <a>a link</a>.</p><div contenteditable="plaintext-only"><p id="draft">Private draft text.</p></div><button>Website action</button><label><input type="checkbox">Subscribe to updates</label><div role="button">Website action</div>';
  controller = new TouchParagraphController(); controller.start();
});
afterEach(() => { controller.close(); vi.clearAllMocks(); document.body.replaceChildren(); });

describe("touch paragraph picking", () => {
  it("translates exactly one tapped paragraph and leaves the next tap alone", async () => {
    const paragraph = document.getElementById("first")!;
    expect(tap(paragraph).defaultPrevented).toBe(true);
    expect(translateParagraph).toHaveBeenCalledExactlyOnceWith(paragraph);
    expect(tap(document.getElementById("second")!).defaultPrevented).toBe(false);
    expect(translateParagraph).toHaveBeenCalledTimes(1);
  });
  it.each(["a", "button", "#draft", "label", "[role='button']"])("leaves %s usable without consuming the paragraph action", selector => {
    expect(tap(document.querySelector(selector)!).defaultPrevented).toBe(false);
    expect(translateParagraph).not.toHaveBeenCalled();
    tap(document.getElementById("first")!);
    expect(translateParagraph).toHaveBeenCalledTimes(1);
  });
  it.each(["movement", "pointercancel", "scroll"])("does not translate after %s", reason => {
    const paragraph = document.getElementById("first")!;
    pointer("pointerdown", paragraph);
    if (reason === "movement") pointer("pointermove", paragraph, 51, 125);
    else if (reason === "pointercancel") pointer("pointercancel", paragraph);
    else document.dispatchEvent(new Event("scroll"));
    pointer("pointerup", paragraph);
    expect(paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(true);
    expect(translateParagraph).not.toHaveBeenCalled();
    tap(paragraph); expect(translateParagraph).toHaveBeenCalledOnce();
  });
  it("restores a translated paragraph through the shared toggle engine", () => {
    const original = document.getElementById("first")!;
    original.setAttribute("data-wupage-target-id", "paragraph-1");
    const result = document.createElement("div");
    result.className = "wupage-translation"; result.setAttribute("data-wupage-translation-target", "paragraph-1");
    result.textContent = "这是一段译文。"; original.after(result);
    tap(result); expect(translateParagraph).toHaveBeenCalledExactlyOnceWith(original);
  });
  it.each(["cancel", "pagehide", "popstate", "Escape"])("stops picking on %s", action => {
    if (action === "cancel") document.querySelector("#wupage-touch-paragraph")!.shadowRoot!.querySelector("button")!.click();
    else if (action === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else window.dispatchEvent(new Event(action));
    expect(document.getElementById("wupage-touch-paragraph")).toBeNull();
    expect(tap(document.getElementById("first")!).defaultPrevented).toBe(false);
    expect(translateParagraph).not.toHaveBeenCalled();
  });
  it("keeps request errors visible after leaving selection mode", async () => {
    vi.mocked(translateParagraph).mockRejectedValueOnce(new Error("翻译服务暂不可用"));
    tap(document.getElementById("first")!);
    await vi.waitFor(() => expect(document.getElementById("wupage-touch-paragraph")!.shadowRoot!.textContent).toContain("翻译服务暂不可用"));
    tap(document.getElementById("second")!); expect(translateParagraph).toHaveBeenCalledOnce();
  });
});
