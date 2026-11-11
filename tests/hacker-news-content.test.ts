// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://news.ycombinator.com/item?id=50388513"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, clearTranslationsIn, collectAdditionalTextSegmentsProgressive,
  collectParagraphTextSegments, collectTextSegmentsProgressive, findTranslatableParagraph,
  invalidateStaleSegments, renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { structuredTranslation } from "./helpers/structured-translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { translateShortcutParagraphs } from "../src/content/paragraph-shortcut";
import { sendRuntimeRequest } from "../src/content/runtime";
import { isHackerNewsCommentChrome } from "../src/content/hacker-news-content";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

const first = "The opening paragraph has a reference and an important detail.";
const second = "The next paragraph should have its own translation.";
const third = "The final paragraph belongs to the same comment body.";
const fixture = `<table><tbody>
  <tr class="athing comtr" id="single-row"><td class="votelinks"><a href="/vote">vote</a></td><td class="default">
    <div class="comhead"><a id="author" class="hnuser" href="/user?id=example">ExampleAuthor</a> three days ago | parent | next</div><br>
    <div class="comment"><div class="commtext c00" id="single">A short comment.</div><div class="reply"><a id="reply" href="/reply?id=1">reply</a></div></div>
  </td></tr>
  <tr class="athing comtr" id="multiple-row"><td class="votelinks"></td><td class="default">
    <div class="comhead">AnotherAuthor three days ago | parent | next</div><br>
    <div class="comment"><div class="commtext c00" id="multiple">The opening paragraph has <a id="reference" href="/item?id=2">a reference</a> and <i>an important detail</i>.<p id="second">${second}</p><p id="third">${third}</p></div><div class="reply"><a href="/reply?id=2">reply</a></div></div>
  </td></tr>
</tbody></table>`;

beforeEach(() => {
  document.body.innerHTML = fixture;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: element.matches("span,a,i,em,strong,b,code,br") ? "inline" : "block",
    visibility: "visible", opacity: "1"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 36));
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  clearTranslations(); window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset(); document.body.replaceChildren();
});

describe("Hacker News comment paragraphs", () => {
  it("selects a single comment body without its author or reply controls", () => {
    expect(findTranslatableParagraph(document.querySelector("#single"))).toBe(document.querySelector("#single"));
    expect(findTranslatableParagraph(document.querySelector("#author"))).toBeNull();
    expect(findTranslatableParagraph(document.querySelector("#reply"))).toBeNull();
  });

  it("selects the unwrapped opening paragraph and the following paragraphs independently", () => {
    const original = document.body.innerHTML;
    const body = document.querySelector("#multiple")!;
    const link = document.querySelector("#reference")!;
    const firstParagraph = findTranslatableParagraph(body)!;
    expect(firstParagraph.textContent).toBe(first);
    expect(firstParagraph.parentElement).toBe(body);
    expect(firstParagraph.querySelector("#reference")).toBe(link);
    expect(findTranslatableParagraph(link)).toBe(firstParagraph);
    expect(findTranslatableParagraph(document.querySelector("#second"))).toBe(document.querySelector("#second"));
    expect(findTranslatableParagraph(document.querySelector("#third"))).toBe(document.querySelector("#third"));
    expect(body.querySelectorAll("[data-wupage-prose-source]")).toHaveLength(1);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it.each(["div", "span"])("preserves authored line breaks in a %s comment body", tag => {
    const oldBody = document.querySelector("#multiple")!;
    const body = document.createElement(tag); body.className = oldBody.className;
    body.innerHTML = `The first authored line.<br>The next authored line.<p>${second}</p>`;
    oldBody.replaceWith(body);
    const original = document.body.innerHTML, lineBreak = body.querySelector("br");
    const segments = collectParagraphTextSegments(body);
    expect(segments).toHaveLength(2);
    expect(segments[0].requestText).toContain("⟪WUPAGEBREAK0⟫");
    renderTranslations(segments.map(segment => ({ id: segment.id,
      text: structuredTranslation(segment.requestText ?? segment.text, "这一行的译文。") })));
    expect(body.querySelector("br")).toBe(lineBreak);
    expect(body.querySelector(".wupage-translation")!.querySelectorAll("br")).toHaveLength(1);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("keeps %s output next to each paragraph and before the reply controls", async mode => {
    const original = document.body.innerHTML;
    const body = document.querySelector("#multiple")!;
    const link = document.querySelector("#reference")!;
    const segments = collectParagraphTextSegments(body);
    expect(segments.map(segment => segment.text)).toEqual([first, second, third]);
    const translations = segments.map((segment, index) => ({ id: segment.id,
      text: structuredTranslation(segment.requestText ?? segment.text, `第${index + 1}段译文。`) }));
    expect(renderTranslations(translations, mode)).toHaveLength(3);
    expect(document.querySelectorAll("td > .wupage-translation,.comhead .wupage-translation,.reply .wupage-translation")).toHaveLength(0);
    for (const index of [1, 2, 3]) expect(body.textContent).toContain(`第${index}段译文。`);
    if (mode !== "replace") expect(body.querySelectorAll(".wupage-translation")).toHaveLength(3);
    expect(document.querySelector("#reference")).toBe(link);
    const elements = [...body.children];
    const secondParagraph = document.querySelector("#second")!;
    if (mode !== "replace") {
      const firstOutput = body.querySelector(".wupage-translation")!;
      expect(elements.indexOf(firstOutput)).toBeLessThan(elements.indexOf(secondParagraph));
    }
    expect(invalidateStaleSegments()).toEqual([]);
    clearTranslationsIn(body);
    expect(body.querySelector(".wupage-translation")).toBeNull();
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("uses the same comment boundaries for whole-page and incremental translation", async () => {
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["A short comment.", first, second, third]);
    renderTranslations(segments.map(segment => ({ id: segment.id,
      text: structuredTranslation(segment.requestText ?? segment.text, "评论译文。") })));
    expect(document.querySelector("#single .wupage-translation")).not.toBeNull();
    expect(document.querySelector("#single + .reply")).not.toBeNull();
    const firstParagraph = document.querySelector("#multiple > [data-wupage-prose-source]")!;
    firstParagraph.firstChild!.textContent = "An updated opening paragraph has ";
    expect(invalidateStaleSegments([firstParagraph])).toContain(segments[1].id);
    const updated = await collectAdditionalTextSegmentsProgressive([firstParagraph]);
    expect(updated.map(segment => segment.text)).toEqual(["An updated opening paragraph has a reference and an important detail."]);
    setTranslationDisplayMode("replace");
    expect(document.querySelectorAll(".comhead .wupage-translation,.reply .wupage-translation")).toHaveLength(0);
  });

  it("translates all selected comment paragraphs once through the shared shortcut entry point", async () => {
    vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return structuredClone(DEFAULT_SETTINGS);
      if (request.type === "TRANSLATE_BATCH") return {
        translations: request.texts.map(text => structuredTranslation(text, "评论段落译文。")), cached: 0
      };
    });
    const body = document.querySelector("#multiple")!;
    const range = document.createRange(); range.selectNodeContents(body);
    window.getSelection()!.addRange(range);
    await translateShortcutParagraphs();
    const requests = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request)
      .filter(request => request.type === "TRANSLATE_BATCH");
    expect(requests).toHaveLength(3);
    expect(requests.flatMap(request => request.texts).join(" ")).not.toMatch(/AnotherAuthor|reply|parent/);
    expect(body.querySelectorAll(".wupage-translation")).toHaveLength(3);
    expect(document.querySelector("#single-row .wupage-translation")).toBeNull();
  });

  it.each(["hidden", "translate", "contenteditable"])("respects %s on a comment body", async attribute => {
    const body = document.querySelector("#multiple")!;
    body.setAttribute(attribute, attribute === "translate" ? "no" : "true");
    expect(findTranslatableParagraph(body)).toBeNull();
    expect(collectParagraphTextSegments(body)).toEqual([]);
  });

  it("keeps rich comment paragraphs intact across progressive scan chunks", async () => {
    const row = document.querySelector("#multiple-row")!;
    for (let index = 0; index < 65; index++) row.parentElement!.append(row.cloneNode(true));
    const segments = await collectTextSegmentsProgressive();
    expect(segments).toHaveLength(1 + 66 * 3);
    expect(segments.filter(segment => segment.text === first)).toHaveLength(66);
    expect(segments.filter(segment => segment.text === first).every(segment => segment.requestText?.includes("WUPAGEOPEN"))).toBe(true);
  });

  it("leaves matching classes in unrelated documents alone", () => {
    const other = document.implementation.createHTMLDocument();
    other.body.innerHTML = fixture;
    const body = other.querySelector("#multiple")!;
    expect(isHackerNewsCommentChrome(other.querySelector("#author")!)).toBe(false);
    expect(body.querySelector("[data-wupage-prose-source]")).toBeNull();
  });
});
