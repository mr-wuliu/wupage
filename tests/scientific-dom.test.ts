// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectTextSegmentsProgressive,
  hideTranslations,
  invalidateStaleSegments,
  renderTranslations,
  restoreTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

const formula = (name: string) => `<span class="MATH"><img src="${name}.png" alt="$ ${name}$" width="40" height="31"></span>`;
const prose = `Bare introduction with a <a href="#ref">1</a> citation and <i>emphasized words</i> is one paragraph.`;

describe("LaTeX2HTML article translation", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="Generator" content="LaTeX2HTML v2002-2-1">';
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: (element as HTMLElement).style.display || "block", visibility: "visible", opacity: "1", color: "rgb(0, 0, 0)"
    }) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600, height: 20, top: 0, right: 600, bottom: 20, left: 0, x: 0, y: 0, toJSON: () => ({})
    });
  });
  afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.head.innerHTML = ""; document.body.innerHTML = ""; });

  it.each([false, true])("groups bare prose and reference links with lowercase tag names=%s", async lowercase => {
    document.body.innerHTML = `<h1><a name="intro">Introduction</a></h1>${prose}<p>Next paragraph.</p>`;
    if (lowercase) for (const element of document.querySelectorAll("a,i")) Object.defineProperty(element, "tagName", { value: element.localName });
    const link = document.querySelector('a[href]');
    const segments = (await collectTextSegmentsProgressive());
    const bare = segments.find(segment => segment.text.startsWith("Bare introduction"))!;
    expect(bare.text).toBe("Bare introduction with a ⟪WUPAGE0⟫ citation and emphasized words is one paragraph.");
    expect(bare.element).not.toBe(document.body);
    expect(segments).toHaveLength(3);
    renderTranslations([{ id: bare.id, text: `译文 ${bare.text}` }], "replace");
    expect(document.querySelector('.wupage-translation a')?.getAttribute("href")).toBe("#ref");
    expect(document.querySelector('.wupage-translation a')?.textContent).toBe("1");
    expect(link?.isConnected).toBe(true);
    expect(link?.classList.contains("wupage-replaced-source")).toBe(true);
  });

  it("treats legacy centered titles and the abstract as complete blocks", async () => {
    document.body.innerHTML = `<div align="center"><big>Abstract</big></div><div class="ABSTRACT">Our model preserves the ${formula("tail")} asymptotic behavior.</div>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(s => s.text)).toEqual(["Abstract", "Our model preserves the ⟪WUPAGE0⟫ asymptotic behavior."]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文 ${text}` })));
    expect(document.querySelector('.ABSTRACT .wupage-translation img')?.getAttribute("src")).toBe("tail.png");
    expect(document.querySelector('big .wupage-translation')).toBeNull();
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("preserves inline formulas through %s, hide, resume and clear", async mode => {
    document.body.innerHTML = `<h2>Model</h2>where ${formula("x")} and ${formula("y")} denote the inputs, see <a href="#ref">2</a>.<p></p>`;
    const original = document.body.innerHTML;
    const originalNodes = [...document.body.childNodes];
    const images = [...document.querySelectorAll("img")];
    const segments = (await collectTextSegmentsProgressive());
    const paragraph = segments.find(s => s.text.startsWith("where"))!;
    expect(paragraph.text).toBe("where ⟪WUPAGE0⟫ and ⟪WUPAGE1⟫ denote the inputs, see ⟪WUPAGE2⟫ .");
    renderTranslations([{ id: paragraph.id, text: `译文 ${paragraph.text}` }], mode);
    expect([...document.querySelectorAll('.wupage-translation img')].map(img => img.getAttribute('alt'))).toEqual(["$ x$", "$ y$"]);
    setTranslationDisplayMode("replace");
    expect(images.every(img => img.parentElement?.classList.contains("wupage-replaced-source"))).toBe(true);
    hideTranslations();
    expect(document.querySelector('.wupage-replaced-source')).toBeNull();
    restoreTranslations("bilingual");
    expect(document.querySelectorAll('.wupage-translation img')).toHaveLength(2);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
    expect([...document.body.childNodes]).toEqual(originalNodes);
    expect([...document.querySelectorAll('img')]).toEqual(images);
  });

  it("excludes display equations, their numbers and long formula alt text", async () => {
    document.body.innerHTML = `<div class="mathdisplay"><table class="equation"><tr><td>${formula("very_long_formula_".repeat(9))}</td><td class="eqno">(19)</td></tr></table></div><br clear="all"><p></p>where ${formula("x")} is a variable.<p>${formula("another_long_formula_".repeat(9))}</p>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(s => s.text)).toEqual(["where ⟪WUPAGE0⟫ is a variable."]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文 ${text}` })), "replace");
    expect(document.querySelector('.eqno')?.textContent).toBe("(19)");
    expect(document.querySelector('.mathdisplay .wupage-translation')).toBeNull();
  });

  it("keeps protected citation text intact and invalidates a citation updated by the host", async () => {
    document.body.innerHTML = `<p>Read the model in <a href="#ref">12</a> before continuing.</p>`;
    const citation = document.querySelector("a")!;
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: `译文 ${segment.text}` }], "replace");
    expect(citation.textContent).toBe("12");
    expect(invalidateStaleSegments()).toEqual([]);
    citation.firstChild!.textContent = "13";
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(citation.textContent).toBe("13");
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });

  it("does not copy hidden math into the output or confuse ordinary image descriptions with formulas", async () => {
    document.body.innerHTML = `<p>A visible paragraph ${formula("x").replace('class="MATH"', 'class="MATH" style="display:none"')} remains readable.</p><p><span class="MATH"><img alt="${'A descriptive caption is ordinary prose. '.repeat(3)}"></span></p>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments[0].text).toBe("A visible paragraph remains readable.");
    expect(segments.some(s => s.text.includes("descriptive caption"))).toBe(true);
  });

  it("collects newly inserted bare prose without nesting or duplicating source runs", async () => {
    document.body.innerHTML = `<h1>Introduction</h1>${prose}<p>Next paragraph.</p>`;
    (await collectTextSegmentsProgressive());
    document.body.append(document.createTextNode("Newly inserted "));
    const emphasis = document.createElement("i"); emphasis.textContent = "scientific prose"; document.body.append(emphasis, document.createTextNode(" forms a paragraph."));
    const added = (await collectAdditionalTextSegmentsProgressive([emphasis]));
    expect(added.map(s => s.text)).toEqual(["Newly inserted scientific prose forms a paragraph."]);
    expect(document.querySelector('[data-wupage-scientific-source] [data-wupage-scientific-source]')).toBeNull();
    const source = emphasis.firstChild!; source.textContent = "updated prose";
    expect(invalidateStaleSegments()).toContain(added[0].id);
    expect((await collectAdditionalTextSegmentsProgressive([added[0].element]))[0].text).toContain("updated prose");
  });

  it("leaves other documents and ordinary equation-named table cells on their normal path", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<h1>Introduction</h1>${prose}<table class="equation"><tr><td class="eqno">An ordinary table label</td></tr></table>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(document.querySelector('[data-wupage-scientific-source]')).toBeNull();
    expect(segments.some(s => s.text === "An ordinary table label")).toBe(true);
  });
});
