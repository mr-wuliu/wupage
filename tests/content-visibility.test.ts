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

  it.each(["fixed", "absolute"])("keeps a %s reader outside an unrelated ancestor's overflow clip", position => {
    document.body.innerHTML = '<div id="clip"><section id="reader"><p>Readable document text</p></section></div>';
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "clip" ? rect(0, 600, 1, 0) : rect(80, 600, 400, 80),
      element => ({ position: element.id === "reader" ? position : "static",
        overflowY: element.id === "clip" ? "hidden" : "visible" }));
    expect(isTextNodeVisuallyRendered(text)).toBe(true);
    expect(isElementVisuallyRendered(text.parentElement!)).toBe(true);
  });

  it("still applies clipping inside a fixed reader", () => {
    document.body.innerHTML = '<section id="reader"><div id="clip"><p>Clipped document text</p></div></section>';
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "clip" ? rect(0, 600, 1, 0) : rect(80, 600, 400, 80),
      element => ({ position: element.id === "reader" ? "fixed" : "static",
        overflowY: element.id === "clip" ? "hidden" : "visible" }));
    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it.each([
    { transform: "matrix(1,0,0,1,0,0)" }, { translate: "0px" }, { perspective: "1000px" },
    { filter: "blur(0px)" }, { contain: "paint" }, { willChange: "transform" }, { contentVisibility: "auto" }
  ])("retains a fixed containing block's clip with %j", containingStyle => {
    document.body.innerHTML = '<div id="clip"><section id="reader"><p>Clipped document text</p></section></div>';
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "clip" ? rect(0, 600, 1, 0) : rect(80, 600, 400, 80),
      element => ({ position: element.id === "reader" ? "fixed" : "static",
        ...(element.id === "clip" ? { overflowY: "hidden", ...containingStyle } : {}) }));
    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it.each(["fixed", "absolute"])("skips intermediate overflow clips up to a %s reader's containing block", position => {
    document.body.innerHTML = '<div id="containing"><div id="clip"><section id="reader"><p>Visible text</p></section></div></div>';
    const text = document.querySelector("p")!.firstChild as Text;
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "clip" ? rect(0, 600, 1, 0) : rect(0, 600, 400, 0),
      element => ({ position: element.id === "reader" ? position : "static",
        transform: element.id === "containing" ? "matrix(1,0,0,1,0,0)" : "none",
        overflowY: ["clip", "containing"].includes(element.id) ? "hidden" : "visible" }));
    expect(isTextNodeVisuallyRendered(text)).toBe(true);
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

  it("uses the viewport overflow propagated from body rather than its zero-height box", () => {
    const text = mountText();
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element === document.body ? rect(0, 600, 0, 0) : rect(100, 500, 140, 100),
      element => element === document.body ? { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" } : {});
    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("keeps body clipping local when containment disables viewport propagation", () => {
    const text = mountText();
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element === document.body ? rect(0, 600, 1, 0) : rect(100, 500, 140, 100),
      element => element === document.body ? { contain: "layout", overflowX: "hidden", overflowY: "hidden" } : {});
    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("does not apply overflow clipping to a non-replaced inline box", () => {
    document.body.innerHTML = '<span id="inline"><p>Visible overflow</p></span>';
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "inline" ? rect(0, 600, 1, 0) : rect(100, 500, 140, 100),
      element => element.id === "inline" ? { display: "inline", overflowY: "hidden", transform: "matrix(1,0,0,1,0,0)" } : {});
    expect(isTextNodeVisuallyRendered(document.querySelector("p")!.firstChild as Text)).toBe(true);
  });

  it("honors paint containment even without overflow:hidden", () => {
    document.body.innerHTML = '<div id="clip"><p>Clipped text</p></div>';
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "clip" ? rect(0, 600, 1, 0) : rect(100, 500, 140, 100),
      element => element.id === "clip" ? { contain: "paint" } : {});
    expect(isTextNodeVisuallyRendered(document.querySelector("p")!.firstChild as Text)).toBe(false);
  });

  it("uses the painted slot ancestors for slotted text, including bare text nodes", () => {
    const host = document.body.appendChild(document.createElement("x-reader"));
    host.textContent = "Slotted text";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<div id="clip"><slot></slot></div>';
    stubRendering(() => [rect(100, 500, 140, 100)], undefined,
      element => element.id === "clip" ? { opacity: "0" } : {});
    expect(isTextNodeVisuallyRendered(host.firstChild as Text)).toBe(false);
  });

  it("escapes ancestor opacity and clipping for modal top-layer content", () => {
    document.body.innerHTML = '<div id="outer"><dialog><p>Visible modal text</p></dialog></div>';
    const dialog = document.querySelector("dialog")!;
    vi.spyOn(dialog, "matches").mockImplementation(selector => selector === ":modal");
    stubRendering(() => [rect(100, 500, 140, 100)],
      element => element.id === "outer" ? rect(0, 600, 1, 0) : rect(100, 500, 140, 100),
      element => element.id === "outer" ? { opacity: "0", overflowY: "hidden", transform: "matrix(1,0,0,1,0,0)" } : { position: "fixed" });
    expect(isTextNodeVisuallyRendered(document.querySelector("p")!.firstChild as Text)).toBe(true);
  });

  it.each(["inset(50%)", "circle(0px)", "ellipse(0px 10px)", "polygon(0% 0%, 100% 0%, 100% 0%)", "polygon(0% 0%, 100% 100%, 50% 50%)"])("rejects an empty clip path %s", clipPath => {
    const text = mountText();
    stubRendering(() => [rect(20, 300, 50, 20)], undefined, element => element === text.parentElement ? { clipPath } : {});
    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it.each(["inset(0px)", "circle(100%)", "ellipse(100% 100%)", "polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)"])("keeps visible text inside %s", clipPath => {
    const text = mountText();
    stubRendering(() => [rect(20, 300, 50, 20)], undefined, element => element === text.parentElement ? { clipPath } : {});
    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("applies clip-path across a positioned element's overflow escape", () => {
    document.body.innerHTML = '<div id="clip"><p>Clipped fixed text</p></div>';
    stubRendering(() => [rect(20, 300, 50, 20)], undefined, element => element.id === "clip"
      ? { clipPath: "inset(50%)" } : { position: "fixed" });
    expect(isTextNodeVisuallyRendered(document.querySelector("p")!.firstChild as Text)).toBe(false);
  });

  it("retains the visible lobes of a self-intersecting polygon", () => {
    const text = mountText();
    stubRendering(() => [rect(20, 300, 50, 20)], undefined, element => element === text.parentElement
      ? { clipPath: "polygon(0 0, 100% 100%, 0 100%, 100% 0)" } : {});
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
    stubRendering(() => [rect(20, 300, 50, 20)], () => rect(0, 320, 60, 0),
      element => ({ backgroundColor: element === overlay ? "rgb(255, 255, 255)" : "transparent" }));
    defineHitTest(() => overlay);

    expect(isTextNodeVisuallyRendered(text)).toBe(false);
  });

  it("keeps visible text behind an unrelated transparent pointer layer", () => {
    const text = mountText();
    const overlay = document.body.appendChild(document.createElement("div"));
    stubRendering(() => [rect(20, 300, 50, 20)], undefined, () => ({ backgroundColor: "rgba(0, 0, 0, 0)" }));
    defineHitTest(() => overlay);

    expect(isTextNodeVisuallyRendered(text)).toBe(true);
  });

  it("keeps a visible child of a visibility-hidden element", () => {
    document.body.innerHTML = `<section id="hidden"><p>Visible override</p></section>`;
    stubRendering(() => [rect(20, 300, 50, 20)], undefined,
      element => ({ visibility: element.id === "hidden" ? "hidden" : "visible" }));

    expect(isTextNodeVisuallyRendered(document.querySelector("p")!.firstChild as Text)).toBe(true);
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
