import { describe, expect, it } from "vitest";
import { preparePdfDocument, preparePdfTranslation, pdfPageTranslationContext, type PdfDocumentPage } from "../src/pdf/document";
import { extractTextBlocks, type PdfTextBlock } from "../src/pdf/model";

function block(text: string, x: number, y: number, bold = false): PdfTextBlock {
  return { id: `${x}-${y}`, text, translatable: true, fontFamily: "serif", fontWeight: bold ? 700 : 400, fontSize: 10,
    lines: [{ text, x, baselineY: y, width: 200, height: 10 }] };
}
function page(blocks: PdfTextBlock[], sourceText = blocks.map((block) => block.text).join(" ")): PdfDocumentPage {
  return { width: 600, height: 800, blocks, sourceText };
}

describe("academic PDF document boundaries", () => {
  it("protects complete bracketed citations so their punctuation cannot be dropped", () => {
    const source = block("PaliGemma [5] uses flow matching [32, 28] and expert routing [45, 25, 12–16].", 40, 500);
    const input = preparePdfTranslation(source, new Map());
    expect(input.text).toBe("PaliGemma ⟪WUPAGE0⟫ uses flow matching ⟪WUPAGE1⟫ and expert routing ⟪WUPAGE2⟫.");
    expect(input.restore("PaliGemma ⟪WUPAGE0⟫使用流匹配⟪WUPAGE1⟫和专家路由⟪WUPAGE2⟫。"))
      .toBe("PaliGemma [5]使用流匹配[32, 28]和专家路由[45, 25, 12–16]。");
  });

  it("uses the source title and abstract rather than author metadata as translation context", () => {
    const title = { ...block("⟪WUPAGE0⟫: A Vision-Language-Action Flow Model", 40, 730), fontSize: 18,
      formulas: [{ placeholder: "⟪WUPAGE0⟫", text: "π0", x: 40, y: 730, width: 10, height: 18,
        baselineY: 730, fontSize: 18, display: false }] };
    const authors = block("Alice Author, Bob Contributor, Carol Researcher", 40, 680);
    authors.lines = Array.from({ length: 3 }, () => authors.lines[0]);
    const abstract = block("Abstract — We learn robot control with a flow matching model.", 40, 500);
    const document = preparePdfDocument([page([title, authors, abstract])], "paper.pdf");
    expect(document.context).toContain("Academic document: π0: A Vision-Language-Action Flow Model");
    expect(document.context).toContain("Document overview (source material): Abstract — We learn robot control");
    expect(document.context).not.toContain("Alice Author");
    expect(document.context).not.toContain("⟪WUPAGE0⟫");
  });

  it("preserves a run-in heading's format markers while protecting numeric literals", () => {
    const paragraph = { ...block("Step 1. The noisy action is mapped to an embedding.", 20, 100), boldPrefix: "Step 1." };
    const input = preparePdfTranslation(paragraph, new Map([["VLA", "vision language action"]]));
    expect(input.text).toBe("⟪WUPAGEOPEN0⟫Step ⟪WUPAGE0⟫.⟪WUPAGECLOSE0⟫ The noisy action is mapped to an embedding.");
    const result = input.restore("⟪WUPAGEOPEN0⟫步骤 ⟪WUPAGE0⟫。⟪WUPAGECLOSE0⟫带噪动作被映射到嵌入。");
    expect(result).toBe("⟪WUPAGEOPEN0⟫步骤 1。⟪WUPAGECLOSE0⟫带噪动作被映射到嵌入。");
    expect(() => input.restore("步骤 ⟪WUPAGE0⟫。带噪动作被映射到嵌入。")).toThrow("文字格式");
    expect(() => input.restore("⟪WUPAGECLOSE0⟫步骤 ⟪WUPAGE0⟫。⟪WUPAGEOPEN0⟫带噪动作被映射到嵌入。")).toThrow("文字格式");
  });

  it("preserves a right-column bibliography and its continuation without skipping the left-column discussion", () => {
    const discussion = block("Discussion of these findings continues here.", 40, 300);
    const pages = [page([discussion, block("References", 330, 500, true),
      block("1 Smith J. A study of measurements. Journal 2018; 2: 10-20.", 330, 480),
      block("2 Jones A. Another study. Journal 2019; 3: 20-30.", 330, 450)]),
    page([block("3 Brown B. Further observations. Journal 2020; 4: 1-9.", 40, 650),
      block("Appendix", 40, 500, true), block("This appendix must still be translated.", 40, 470)])];
    preparePdfDocument(pages, "paper.pdf");
    expect(discussion.translatable).toBe(true);
    expect(pages[0].blocks[1].translatable).toBe(true);
    expect(pages[0].blocks.slice(2).every((block) => block.role === "reference" && !block.translatable)).toBe(true);
    expect(pages[1].blocks[0].role).toBe("reference");
    expect(pages[1].blocks.slice(1).every((block) => block.translatable)).toBe(true);
  });

  it("handles a bibliography that starts in the left column and continues at the top of the right", () => {
    const pages = [page([block("Body text above the reference section.", 40, 700), block("Bibliography", 40, 300, true),
      block("[1] Smith J. First paper. 2020.", 40, 270), block("[2] Brown K. Second paper. 2021.", 330, 700)])];
    preparePdfDocument(pages, "paper.pdf");
    expect(pages[0].blocks.map((block) => block.translatable)).toEqual([true, true, false, false]);
  });

  it("ends reference preservation at a heading centered within the left column", () => {
    const appendix = block("APPENDIX", 150, 440);
    appendix.lines[0].width = 45;
    const bibliography = page([block("References", 330, 700), block("[1] Smith J. First paper. 2020.", 330, 670)]);
    const continuation = page([
      block("[2] Brown K. Second paper. 2021.", 50, 700), appendix,
      block("A. Contributions The authors contributed to the following areas.", 50, 420),
      block("B. Model Architecture Details We add an input for the state", 50, 120),
      block("vector and action vectors, followed by a smaller action expert.", 330, 730),
    ]);
    continuation.blocks[2].lines.push({ ...continuation.blocks[2].lines[0], baselineY: 408 });
    const referenceFragment = block("A justified reference fragment", 235, 680);
    referenceFragment.lines[0].width = 65;
    continuation.blocks.splice(1, 0, referenceFragment);
    preparePdfDocument([bibliography, continuation], "paper.pdf");
    expect(continuation.blocks[0].role).toBe("reference");
    expect(referenceFragment.role).toBe("reference");
    expect(continuation.blocks.slice(2).every((entry) => entry.translatable && !entry.preserveOriginal)).toBe(true);
  });

  it("recognizes author-year entries while leaving a normal use of the word references alone", () => {
    const pages = [page([block("The references in this argument need careful interpretation.", 40, 700),
      block("References", 40, 500, true), block("Smith, J. (2020). First study.", 40, 470), block("Brown, A. (2021). Second study.", 40, 440)])];
    preparePdfDocument(pages, "paper.pdf");
    expect(pages[0].blocks[0].translatable).toBe(true);
    expect(pages[0].blocks.slice(2).every((block) => block.preserveOriginal)).toBe(true);
    const ordinary = page([block("References", 40, 500), block("A normal paragraph without bibliographic entries.", 40, 470)]);
    preparePdfDocument([ordinary], "manual.pdf");
    expect(ordinary.blocks.every((block) => block.translatable)).toBe(true);
  });

  it("does not activate bibliography preservation from a contents entry, and accepts a single reference", () => {
    const title = block("References", 40, 600); title.tocPart = "title";
    const pages = [page([title, block("1 Introduction", 40, 570), block("2 Methods", 40, 550)]),
      page([block("This ordinary chapter must be translated.", 40, 650)])];
    preparePdfDocument(pages, "book.pdf");
    expect(pages.flatMap((page) => page.blocks).every((block) => block.translatable)).toBe(true);
    const single = page([block("References", 40, 600, true), block("1 Smith J. A study. Journal 2020; 2: 1-5.", 40, 570)]);
    preparePdfDocument([single], "short-paper.pdf");
    expect(single.blocks[1].role).toBe("reference");
  });

  it("uses document-defined acronyms in table cells and shared page context", () => {
    const pages = [page([block("PPV", 100, 500), block("NPV", 200, 500), block("RNN", 100, 470),
      block("The model predicts postoperative complications using routinely collected measurements.", 40, 700)],
    "PPV=positive predictive value. NPV=negative predictive value. RNN=recurrent neural network.")];
    const context = preparePdfDocument(pages, "Clinical prediction.pdf");
    expect(pages[0].blocks.slice(0, 3).every((block) => block.role === "identifier" && !block.translatable)).toBe(true);
    expect(context.abbreviations.get("PPV")).toBe("positive predictive value");
    expect(pdfPageTranslationContext(context, pages[0].blocks)).toContain("postoperative complications");
    const source = block("PPV was 0·90 at 24 hours (95% CI 0·87–0·94).", 40, 400);
    const input = preparePdfTranslation(source, context.abbreviations);
    expect(input.text).not.toContain("PPV");
    expect(input.text).not.toContain("0·90");
    expect(input.restore(input.text)).toBe(source.text);
    expect(() => input.restore(input.text.replace(/⟪WUPAGE\d+⟫/u, ""))).toThrow();
  });

  it("supplies adjacent prose as bounded context while excluding preserved references", () => {
    const current = block("The model follows the procedure introduced earlier in the document.", 40, 500);
    const previous = block("The previous page defines the procedure and its interpretation.", 40, 100);
    const reference = { ...block("[1] A bibliography entry that must not become prose context.", 40, 100), translatable: false };
    const document = preparePdfDocument([page([current])], "paper.pdf");
    const context = pdfPageTranslationContext(document, [current], [previous, reference]);
    expect(context).toContain("Adjacent page passages (context only; translate only the requested texts)");
    expect(context).toContain(previous.text);
    expect(context).not.toContain(reference.text);
  });

  it("protects panel letters without treating an ordinary sentence beginning with A as a panel", () => {
    const a = block("A Bleeding", 40, 600, true), b = block("B Mortality", 40, 400, true), c = block("C Renal failure", 40, 200, true);
    const ordinary = block("A prediction should retain its clinical meaning.", 330, 600);
    preparePdfDocument([page([a, b, c, ordinary])], "paper.pdf");
    const input = preparePdfTranslation(c, new Map());
    expect(input.text).toMatch(/^⟪WUPAGE\d+⟫ Renal failure$/u);
    expect(input.restore(input.text)).toBe("C Renal failure");
    expect(ordinary.role).toBeUndefined();
  });

  it("keeps chart keys separate, joins justified prose and repairs typographic word splits", () => {
    const item = (str: string, x: number, y: number, width: number, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, fontFamily: "serif" });
    const blocks = extractTextBlocks([
      item("renal", 20, 700, 20), item("failure", 48, 700, 25), item("requiring treatment", 81, 700, 95),
      item("Clinical electronic records provide relevant information.", 20, 670, 220),
      item("These elec", 20, 650, 45), item("tronic records contain rele vant information.", 65, 650, 180),
      item("RNN", 300, 400, 20, 7), item("Clinical reference tool", 300, 391.6, 70, 7)
    ], 1);
    expect(blocks[0].text).toBe("renal failure requiring treatment");
    expect(blocks.find((block) => block.text.includes("These electronic"))?.text).toContain("relevant");
    expect(blocks.slice(-2).map((block) => block.text)).toEqual(["RNN", "Clinical reference tool"]);
  });

  it("keeps superscript citations inline and leaves sample counts protected inside translated table headings", () => {
    const item = (str: string, x: number, y: number, size: number, width: number) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, fontFamily: "serif", fontName: "Times-Roman" });
    const blocks = extractTextBlocks([item("A complete clinical sentence", 20, 700, 10, 120), item("12", 140, 703.5, 5, 5),
      item("continues after the citation.", 148, 700, 10, 120),
      item("Training (n=4180)", 20, 400, 7, 49), item("Test (n=464)", 80, 400, 7, 35)], 1);
    expect(blocks[0].text).toMatch(/sentence ⟪WUPAGE\d+⟫ continues/u);
    expect(blocks[0].formulas?.[0]).toMatchObject({ text: "12", display: false, fontSize: 10, baselineY: 700 });
    expect(blocks.filter((block) => block.translatable).some((block) => block.text.startsWith("Training"))).toBe(true);
    expect(blocks.filter((block) => block.translatable).some((block) => block.text.startsWith("Test"))).toBe(true);
  });
});
