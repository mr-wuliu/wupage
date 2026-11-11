// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, collectAdditionalTextSegmentsProgressive, collectTextSegmentsProgressive,
  findTranslatableParagraph, hideTranslations, invalidateStaleSegments, renderTranslations,
  restoreTranslations, setTranslationDisplayMode
} from "../src/content/dom";

describe("legacy prose separated by blank lines", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
      display: element.matches("span,i,em,strong,a,code") ? "inline" : "block",
      visibility: "visible", opacity: "1"
    }) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 700, height: 24, top: 0, left: 0, right: 700, bottom: 24
    } as DOMRect);
  });
  afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it("keeps a long DeviantArt-style legacy journal in paragraphs across scan chunks", async () => {
    // Observed markup: /joinerofsonicfans/art/Legends--Scavenger-Hunt-132307382
    // (2009): div.legacy-journal, 135 BRs, inline emphasis, no P elements.
    // Use original fixture text rather than copying the author's story.
    const paragraphs = Array.from({ length: 70 }, (_, index) => `Chapter passage ${index}: The traveler followed the river toward the distant village.`);
    document.body.innerHTML = `<main role="main"><section><div class="legacy-journal">${paragraphs.join("<br><br>\n")}</div></section></main>`;
    const original = document.body.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(paragraphs);
    expect(new Set(segments.map(segment => segment.element)).size).toBe(paragraphs.length);
    renderTranslations(segments.slice(0, 2).map(segment => ({ id: segment.id, text: `译文：${segment.requestText}` })));
    const outputs = [...document.querySelectorAll(".wupage-translation")];
    expect(outputs).toHaveLength(2);
    expect(outputs[0].previousSibling).toBe(segments[0].element);
    expect(outputs[0].nextSibling?.nodeName).toBe("BR");
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it.each(["div", "span", "p"])("recognizes ordinary %s prose without a site or main/article selector", async tag => {
    document.body.innerHTML = `<${tag}>“Yes.”<br>\n &nbsp;<br> “No.”</${tag}>`;
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["“Yes.”", "“No.”"]);
  });

  it("preserves inline structure, original nodes and restoration through every display mode", async () => {
    document.body.innerHTML = '<main><div id="story">The <i id="emphasis">quiet traveler</i> read <a id="link" href="/map">the map</a>.<br><br>“I counted <strong>3</strong> lights.”<br><br>“Go.”</div></main>';
    const original = document.body.innerHTML;
    const story = document.querySelector("#story")!;
    const children = [...story.childNodes];
    const emphasis = document.querySelector("#emphasis")!;
    const link = document.querySelector("#link")!;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["The quiet traveler read the map.", "“I counted 3 lights.”", "“Go.”"]);
    expect(segments[0].requestText).toContain("WUPAGEOPEN0");
    expect(findTranslatableParagraph(emphasis)).toBe(segments[0].element);
    const translations = segments.map(segment => ({ id: segment.id, text: `译文：${segment.requestText}` }));
    expect(renderTranslations(translations, "replace")).toHaveLength(3);
    expect(document.querySelector("#emphasis")).toBe(emphasis);
    expect(document.querySelector("#link")).toBe(link);
    expect(story.textContent).toContain("译文：");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(invalidateStaleSegments()).toEqual([]);
      hideTranslations();
      expect(story.textContent).toBe("The quiet traveler read the map.“I counted 3 lights.”“Go.”");
      restoreTranslations(mode);
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
    expect([...story.childNodes]).toEqual(children);
  });

  it("keeps complete rich paragraphs intact even when the document exceeds the scan chunk size", async () => {
    const paragraphs = Array.from({ length: 65 }, (_, i) => `Passage ${i} has <em>important words</em> and an ending.`);
    document.body.innerHTML = `<main><div>${paragraphs.join("<br><br>")}</div></main>`;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(paragraphs.map(text => text.replace(/<\/?em>/g, "")));
    expect(segments.every(segment => segment.requestText?.includes("⟪WUPAGEOPEN0⟫important words⟪WUPAGECLOSE0⟫"))).toBe(true);
  });

  it("rediscovers edited and newly appended paragraphs without duplicating existing translations", async () => {
    document.body.innerHTML = '<main><div id="story">Opening passage.<br><br>The traveler continued.</div></main>';
    const story = document.querySelector("#story")!;
    const initial = await collectTextSegmentsProgressive();
    renderTranslations(initial.map(segment => ({ id: segment.id, text: `译文：${segment.requestText}` })));
    expect(await collectAdditionalTextSegmentsProgressive([story])).toEqual([]);
    initial[1].element.firstChild!.textContent = "The traveler returned.";
    expect(invalidateStaleSegments([initial[1].element])).toEqual([initial[1].id]);
    expect((await collectAdditionalTextSegmentsProgressive([initial[1].element])).map(segment => segment.text))
      .toEqual(["The traveler returned."]);
    story.insertAdjacentHTML("beforeend", "<br><br>A newly loaded ending.");
    expect((await collectAdditionalTextSegmentsProgressive([story])).map(segment => segment.text))
      .toEqual(["A newly loaded ending."]);
    clearTranslations();
    expect(story.innerHTML).toBe("Opening passage.<br><br>The traveler returned.<br><br>A newly loaded ending.");
  });

  it.each([
    '<pre>const value = 1;<br><br>// Explain the next line</pre>',
    '<div class="highlight">const value = 1;<br><br>// Explain the next line</div>',
    '<div contenteditable="true">An unsent draft.<br><br>Another private paragraph.</div>',
    '<div translate="no">Untranslated passage.<br><br>Another passage.</div>',
    '<button>First control.<br><br>Second control.</button>',
    '<div>First line.<br>Second line.</div>'
  ])("leaves code, editors, opted-out content and layout boundaries intact: %s", async html => {
    document.body.innerHTML = html;
    await collectTextSegmentsProgressive();
    expect(document.body.innerHTML).toBe(html);
    expect(document.querySelector("[data-wupage-prose-source]")).toBeNull();
  });

  it("does not group inline tags that actually contain independent layout fields", async () => {
    document.body.innerHTML = '<main><div>First label.<br><br><span class="fields"><span>Subject</span><span>Author</span></span></div></main>';
    const original = document.body.innerHTML;
    vi.mocked(window.getComputedStyle).mockImplementation(element => ({
      display: element.matches(".fields") ? "grid" : element.matches("span") ? "inline" : "block",
      visibility: "visible", opacity: "1"
    }) as CSSStyleDeclaration);
    const segments = await collectTextSegmentsProgressive();
    expect(segments.some(segment => segment.text.includes("First label") && /Subject|Author/u.test(segment.text))).toBe(false);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });
});
