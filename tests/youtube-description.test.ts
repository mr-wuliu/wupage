// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegments,
  collectParagraphTextSegments,
  collectTextSegments,
  findTranslatableParagraph,
  invalidateStaleSegments,
  renderTranslationPlaceholders,
  renderTranslations
} from "../src/content/dom";

describe("YouTube description layout", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      display: "inline", visibility: "visible", opacity: "1", whiteSpace: "pre-wrap"
    } as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200,
      x: 0, y: 0, toJSON: () => ({})
    } as DOMRect);
    // Matches YouTube's attributed text: newlines inside spans, URLs and
    // decorated video links between text runs, all inside one inline host.
    document.body.innerHTML = `<ytd-text-inline-expander id="description-inline-expander"><div id="expanded"><yt-attributed-string><span class="ytAttributedStringHost ytAttributedStringWhiteSpacePreWrap"><span>Support-free horizontal overhangs on a standard FDM printer.\n\n📄 The paper (open access)  \n</span><span><a href="https://doi.org/paper">https://doi.org/paper</a></span><span>\n\n🖨️ Try it yourself  \nPrusaSlicer fork by Steven McCulloch:  \n</span><span><a href="https://github.com/example/slicer">https://github.com/example/slicer</a></span><span>\nThe CNC Kitchen video:\n</span><span><a href="/watch?v=B0yo-o47688"><img alt="">Arc Overhangs make Supports Obsolete!</a></span><span>\n\nTools used\nAnimations made with <b>Manim</b>.</span></span></yt-attributed-string></div></ytd-text-inline-expander>`;
  });

  afterEach(() => {
    clearTranslations();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("pairs each authored line with a block translation while preserving links and blank lines", () => {
    const host = document.querySelector(".ytAttributedStringHost")!;
    const originalHtml = host.innerHTML;
    const links = [...host.querySelectorAll("a")];
    const segments = collectTextSegments();
    expect(segments.map(({ text }) => text)).toEqual([
      "Support-free horizontal overhangs on a standard FDM printer.",
      "📄 The paper (open access)",
      "🖨️ Try it yourself",
      "PrusaSlicer fork by Steven McCulloch:",
      "The CNC Kitchen video:",
      "Tools used",
      "Animations made with Manim.",
      "Arc Overhangs make Supports Obsolete!"
    ]);
    renderTranslationPlaceholders(segments);
    expect(host.querySelectorAll(".wupage-translation-pending")).toHaveLength(8);
    renderTranslations(segments.map(({ id }, index) => ({ id, text: `译文${index}` })));
    const translations = [...host.querySelectorAll<HTMLElement>(".wupage-translation")];
    expect(translations).toHaveLength(8);
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(8);
    expect(host.querySelectorAll(".wupage-translation-pending")).toHaveLength(0);
    expect(translations.filter((el) => el.dataset.wupageMode === "block")).toHaveLength(7);
    expect(translations[0].dataset.wupageContainer).toBe("youtube-description");
    expect(translations[0].nextSibling?.textContent).toBe("\n\n");
    expect(translations[1].nextSibling?.textContent).toBe("\n");
    expect(translations[1].compareDocumentPosition(links[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...host.querySelectorAll("a")]).toEqual(links);
    expect(links[0].textContent).toBe("https://doi.org/paper");
    expect(links[2].querySelector(".wupage-translation")?.getAttribute("data-wupage-mode")).toBe("inline");
    expect(collectAdditionalTextSegments(host)).toEqual([]);
    clearTranslations();
    expect(host.innerHTML).toBe(originalHtml);
  });

  it("keeps replacement translations in source order and restores the original description", () => {
    const host = document.querySelector(".ytAttributedStringHost")!;
    const originalHtml = host.innerHTML;
    const segments = collectTextSegments();
    renderTranslations(segments.map(({ id }, index) => ({ id, text: `译文${index}` })), "replace");
    expect(host.textContent).toBe("译文0\n\n译文1\nhttps://doi.org/paper\n\n译文2\n译文3\nhttps://github.com/example/slicer\n译文4\n译文7\n\n译文5\n译文6");
    expect(invalidateStaleSegments()).toEqual([]);
    clearTranslations();
    expect(host.innerHTML).toBe(originalHtml);
  });

  it("supports paragraph translation, br boundaries and the legacy description renderer", () => {
    document.body.innerHTML = `<div id="description"><yt-formatted-string class="content">First line.<br>Second line.\r\n\r\nFinal line.</yt-formatted-string></div>`;
    const host = document.querySelector("yt-formatted-string")!;
    expect(findTranslatableParagraph(host)).toBe(host);
    const segments = collectParagraphTextSegments(host);
    expect(segments.map(({ text }) => text)).toEqual(["First line.", "Second line.", "Final line."]);
    renderTranslations(segments.map(({ id }, index) => ({ id, text: `译文${index}` })));
    expect(host.querySelectorAll(".wupage-translation")).toHaveLength(3);
    expect(host.querySelector(".wupage-translation")?.nextSibling?.nodeName).toBe("BR");
  });

  it("recollects changed descriptions without accumulating old translations", () => {
    const host = document.querySelector(".ytAttributedStringHost")!;
    const segments = collectTextSegments();
    renderTranslations(segments.map(({ id }, index) => ({ id, text: `译文${index}` })));
    host.firstChild!.firstChild!.textContent = "Updated introduction.";
    expect(invalidateStaleSegments()).toContain(segments[0].id);
    const updated = collectAdditionalTextSegments(host);
    expect(updated[0].text).toBe("Updated introduction.");
    renderTranslations(updated.map(({ id }, index) => ({ id, text: `新译文${index}` })));
    expect(host.querySelectorAll(".wupage-translation")).toHaveLength(8);
    expect([...host.querySelectorAll(".wupage-translation")].map((el) => el.textContent)).not.toContain("译文0");
  });
});
