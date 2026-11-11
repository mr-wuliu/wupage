// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextFlowSnapshot, textNodeAtPoint } from "../src/content/text-flow";
import {
  clearTranslations, collectParagraphTextSegments, collectTextSegmentsProgressive, collectAdditionalTextSegmentsProgressive,
  findTranslatableParagraph, invalidateStaleSegments, renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { structuredTranslation, withoutMarkup } from "./helpers/structured-translation";

const opening = "An opening sentence with a reference and important details.";
const following = "An independent paragraph follows the opening.";

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 32));
});
afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("layout text flows", () => {
  it.each(["div", "span", "section"])("finds an anonymous opening and tail in an ordinary %s inside a layout table", async tag => {
    document.body.innerHTML = `<table><tr><td><div>Example author</div><${tag} id="body">An opening sentence with <a href="/ref">a reference</a> and <em>important details</em>.<p>${following}</p>A final unwrapped paragraph.</${tag}><div>Reply controls</div></td></tr></table>`;
    const body = document.querySelector("#body")!;
    const original = document.body.innerHTML, children = [...body.childNodes];
    const first = findTranslatableParagraph(body, body.firstChild!)!;
    const tail = findTranslatableParagraph(body, body.lastChild!)!;
    expect(first.textContent).toBe(opening);
    expect(tail.textContent).toBe("A final unwrapped paragraph.");
    expect(collectParagraphTextSegments(first).map(segment => segment.text)).toEqual([opening]);
    clearTranslations();
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => withoutMarkup(segment.requestText ?? segment.text)))
      .toEqual(["Example author", opening, following, "A final unwrapped paragraph.", "Reply controls"]);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
    expect([...body.childNodes]).toEqual(children);
  });

  it.each(["div", "span", "p"])("follows computed CSS when %s is inline formatting", async tag => {
    document.body.innerHTML = `<style>.format{display:inline}</style><section><article id="body">An opening sentence with <${tag} class="format"><a href="/ref">a reference</a></${tag}> and <em>important details</em>.</article></section>`;
    const original = document.body.innerHTML, link = document.querySelector("a");
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => withoutMarkup(segment.requestText ?? segment.text))).toEqual([opening]);
    renderTranslations(segments.map(segment => ({ id: segment.id,
      text: structuredTranslation(segment.requestText!, "对应单位的译文。") })), "replace");
    expect(document.querySelector("a")).toBe(link);
    expect(link!.textContent).toBe("对应单位的译文。");
    clearTranslations(); expect(document.body.innerHTML).toBe(original);
  });

  it.each(["span", "a", "em"])("keeps a CSS block %s separate from surrounding prose", async tag => {
    document.body.innerHTML = `<style>.field{display:block}</style><section>Opening outside the field.<${tag} class="field">An independent text field.</${tag}>Closing outside the field.</section>`;
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text))
      .toEqual(["Opening outside the field.", "An independent text field.", "Closing outside the field."]);
  });

  it.each(["flex", "grid"])("keeps the fields in a %s container independent", async display => {
    document.body.innerHTML = `<div style="display:${display}"><span>First field with <em>emphasis</em>.</span><span>Second field with <a href="/ref">a link</a>.</span></div>`;
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text))
      .toEqual(["First field with emphasis.", "Second field with a link."]);
  });

  it("preserves a hard line break and inline nodes through all display modes", async () => {
    document.body.innerHTML = '<section id="body">Read from a<br><a id="link" href="/ref">sketchboard</a> before continuing.<p>An unrelated paragraph.</p></section>';
    const original = document.body.innerHTML;
    const link = document.querySelector("#link")!, br = document.querySelector("br")!;
    const target = findTranslatableParagraph(document.querySelector("#body"), document.querySelector("#body")!.firstChild!)!;
    const [segment] = collectParagraphTextSegments(target);
    expect(segment.requestText).toContain("⟪WUPAGEBREAK0⟫");
    expect(segment.requestText).toContain("sketchboard");
    renderTranslations([{ id: segment.id, text: structuredTranslation(segment.requestText!, "这一行的译文。") }]);
    for (const mode of ["replace", "bilingual-accent", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector("#link")).toBe(link);
      expect(link.textContent?.trim()).not.toBe("");
      expect(br.isConnected).toBe(true);
      expect(invalidateStaleSegments()).toEqual([]);
      expect(document.querySelector("p")!.textContent).toBe("An unrelated paragraph.");
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("does not change the DOM when computing text ranges", () => {
    document.body.innerHTML = `<div id="body">Bare opening.<p>${following}</p>Bare ending.</div>`;
    const original = document.body.innerHTML, body = document.querySelector("#body")!;
    const unit = new TextFlowSnapshot().containing(body.firstChild!);
    expect(unit?.nodes).toEqual([body.firstChild]);
    expect(unit?.whole).toBe(false);
    expect(document.body.innerHTML).toBe(original);
  });

  it("does not select an outer container when the host empties an anonymous source", () => {
    document.body.innerHTML = '<section>Bare opening.<p>A remaining independent paragraph.</p></section>';
    const source = findTranslatableParagraph(document.querySelector("section"))!;
    source.replaceChildren();
    expect(findTranslatableParagraph(source)).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("A remaining independent paragraph.");
  });

  it("keeps an independent button out of the surrounding prose and retains its handler", async () => {
    document.body.innerHTML = '<section>Read this opening paragraph.<button>Open settings</button>Read this closing paragraph.</section>';
    const original = document.body.innerHTML, button = document.querySelector("button")!;
    const clicked = vi.fn(); button.addEventListener("click", clicked);
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Read this opening paragraph.", "Open settings", "Read this closing paragraph."]);
    renderTranslations(segments.map(segment => ({ id: segment.id,
      text: structuredTranslation(segment.requestText ?? segment.text, "对应单位的译文。") })), "replace");
    expect(document.querySelector("button")).toBe(button);
    button.click(); expect(clicked).toHaveBeenCalledOnce();
    clearTranslations(); expect(document.body.innerHTML).toBe(original);
  });

  it.each([false, true])("invalidates changed layout boundaries before accepting a response, rendered=%s", async rendered => {
    document.body.innerHTML = '<style>.split em{display:block}</style><section><div>A complete sentence with <em>an independent field</em> and an ending.</div></section>';
    const [segment] = await collectTextSegmentsProgressive();
    const translation = { id: segment.id, text: structuredTranslation(segment.requestText!, "对应单位的译文。") };
    if (rendered) renderTranslations([translation]);
    document.querySelector("section")!.className = "split";
    expect(renderTranslations([translation])).toEqual([]);
    expect(invalidateStaleSegments()).toContain(segment.id);
    const updated = await collectAdditionalTextSegmentsProgressive([document.querySelector("section")!]);
    expect(updated.map(entry => entry.text)).toEqual(["A complete sentence with", "an independent field", "and an ending."]);
  });

  it("recovers short articles and spaces split across formatting nodes", async () => {
    document.body.innerHTML = '<article><span>from </span><span>a</span> <a href="/ref">sketchboard</a></article>';
    const [segment] = await collectTextSegmentsProgressive();
    expect(withoutMarkup(segment.requestText ?? segment.text)).toBe("from a sketchboard");
  });

  it("keeps a rich paragraph intact beyond the progressive scan chunk size", async () => {
    const words = Array.from({ length: 160 }, (_, index) => `<span>word${index} </span>`);
    document.body.innerHTML = `<section><div id="body">An opening ${words.join("")}sentence.</div><div>A separate closing paragraph.</div></section>`;
    const segments = await collectTextSegmentsProgressive();
    expect(segments).toHaveLength(2);
    expect(withoutMarkup(segments[0].requestText ?? segments[0].text)).toBe(`An opening ${words.map((_, index) => `word${index}`).join(" ")} sentence.`);
    expect(segments[1].text).toBe("A separate closing paragraph.");
  });

  it("uses native text hit testing to distinguish ranges in the same element", () => {
    document.body.innerHTML = '<section id="body">Opening paragraph.<p>A middle paragraph.</p>Ending paragraph.</section>';
    const body = document.querySelector("#body")!, first = body.firstChild!, last = body.lastChild!;
    const caret = vi.fn((_x, y) => ({ offsetNode: y < 40 ? first : last, offset: 1 }));
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: caret });
    try {
      expect(findTranslatableParagraph(body, textNodeAtPoint(document, 20, 10)!)!.textContent).toBe("Opening paragraph.");
      expect(findTranslatableParagraph(body, textNodeAtPoint(document, 20, 80)!)!.textContent).toBe("Ending paragraph.");
    } finally { Reflect.deleteProperty(document, "caretPositionFromPoint"); }
  });
});
