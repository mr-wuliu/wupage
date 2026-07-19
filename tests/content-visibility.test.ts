// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isElementVisuallyRendered,
  isTextNodeVisuallyRendered
} from "../src/content/visibility";

describe("render-aware text visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    delete (document as unknown as {
      elementFromPoint?: Document["elementFromPoint"];
    }).elementFromPoint;
    delete (Element.prototype as unknown as {
      checkVisibility?: () => boolean;
    }).checkVisibility;
  });

  it("rejects text that has no rendered range even when its parent has a box", () => {
    const text = mountText();
    stubRendering(() => []);

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("keeps rendered text inside a display-contents ancestor", () => {
    document.body.innerHTML = `<div id="contents"><p>Visible descendant text</p></div>`;
    const text = document.querySelector("p")!.firstChild as Text;
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) {
        return this.id !== "contents";
      }
    });
    stubRendering(
      () => [rect(20, 300, 50, 20)],
      undefined,
      (element) => ({ display: element.id === "contents" ? "contents" : "block" })
    );

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("rejects text fully clipped by a hidden-overflow ancestor", () => {
    document.body.innerHTML = `<div id="clip"><p>Clipped text</p></div>`;
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(
      () => [rect(20, 250, 40, 150)],
      (element) => element.id === "clip" ? rect(0, 100, 100, 0) : rect(20, 250, 40, 150),
      (element) => ({ overflowX: element.id === "clip" ? "hidden" : "visible" })
    );

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("applies clipping from the text host itself", () => {
    document.body.innerHTML = `<p id="clip">Visually clipped text</p>`;
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(
      () => [rect(20, 300, 50, 20)],
      (element) => element.id === "clip" ? rect(20, 21, 21, 20) : rect(20, 300, 50, 20),
      (element) => element.id === "clip"
        ? { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" }
        : {}
    );

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("keeps partially clipped text when some rendered area remains", () => {
    document.body.innerHTML = `<div id="clip"><p>Partially visible text</p></div>`;
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(
      () => [rect(20, 150, 40, 50)],
      (element) => element.id === "clip" ? rect(0, 100, 100, 0) : rect(20, 150, 40, 50),
      (element) => ({ overflowX: element.id === "clip" ? "hidden" : "visible" })
    );

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("keeps offscreen text so it can be translated before scrolling", () => {
    const text = mountText();
    stubRendering(() => [rect(900, 300, 930, 20)]);
    defineHitTest(() => null);

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("rejects viewport text completely covered by an unrelated element", () => {
    const text = mountText();
    const overlay = document.body.appendChild(document.createElement("div"));
    stubRendering(() => [rect(20, 300, 50, 20)]);
    defineHitTest(() => overlay);

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("accepts viewport text when hit testing reaches its host", () => {
    const text = mountText();
    stubRendering(() => [rect(20, 300, 50, 20)]);
    defineHitTest(() => text.parentElement);

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("does not reject visible text merely because it ignores pointer events", () => {
    const text = mountText();
    const unrelated = document.body.appendChild(document.createElement("div"));
    stubRendering(
      () => [rect(20, 300, 50, 20)],
      undefined,
      (element) => ({ pointerEvents: element === text.parentElement ? "none" : "auto" })
    );
    defineHitTest(() => unrelated);

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("rejects text made transparent by an ancestor", () => {
    document.body.innerHTML = `<section id="transparent"><p>Invisible text</p></section>`;
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(
      () => [rect(20, 300, 50, 20)],
      undefined,
      (element) => ({ opacity: element.id === "transparent" ? "0" : "1" })
    );

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
    expect(isElementVisuallyRendered(text.parentElement!)).toBe(false);
  });
});

function mountText(): Text {
  document.body.innerHTML = `<main><p>Readable text</p></main>`;
  return document.querySelector("p")!.firstChild as Text;
}

function stubRendering(
  textRects: (node: Node) => DOMRect[],
  elementRect: (element: Element) => DOMRect = () => rect(20, 300, 50, 20),
  styleOverrides: (element: Element) => Partial<CSSStyleDeclaration> = () => ({})
): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    contentVisibility: "visible",
    overflow: "visible",
    overflowX: "visible",
    overflowY: "visible",
    ...styleOverrides(element)
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return elementRect(this);
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return [elementRect(this)] as unknown as DOMRectList;
  });
  vi.spyOn(document, "createRange").mockImplementation(() => {
    let selected: Node = document.body;
    return {
      selectNodeContents(node: Node) {
        selected = node;
      },
      getClientRects() {
        return textRects(selected);
      },
      detach() {}
    } as unknown as Range;
  });
}

function defineHitTest(hitTest: (x: number, y: number) => Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(hitTest)
  });
}

function rect(top: number, right: number, bottom: number, left: number): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
