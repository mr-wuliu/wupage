import { describe, expect, it } from "vitest";
import { preparePdfDocumentTranslations, preparePdfPageTranslations } from "../src/pdf/paragraph-flow";
import { preparePdfTranslation } from "../src/pdf/document";
import { extractTextBlocks, type PdfTextBlock } from "../src/pdf/model";

function block(text: string, x: number, y: number, count = 4): PdfTextBlock {
  return { id: `${x}-${y}`, text, translatable: true, fontFamily: "serif", fontWeight: 400, fontSize: 10,
    lines: Array.from({ length: count }, (_, index) => ({ text, x, baselineY: y - index * 12, width: 240, height: 10 })) };
}
const firstText = "In this section, we follow the model [5] with additional inputs, including the state";
const secondText = "vector ⟪WUPAGE0⟫ and action vectors, followed by a smaller set of expert weights.";
function fragments() {
  const first = block(firstText, 50, 125, 5), second = block(secondText, 330, 735);
  second.formulas = [{ placeholder: "⟪WUPAGE0⟫", text: "qt", x: 350, y: 730, width: 10, height: 10,
    baselineY: 735, fontSize: 10, display: false }];
  return [first, second];
}

describe("PDF paragraph flow across columns", () => {
  it("translates an abstract around artwork as one paragraph and restores both physical regions", () => {
    const texts = ["The material is prepared using a process that", "combines several components and supports",
      "a wide range of environments while retaining its original structure and performance.", "These observations confirm the findings."];
    const blocks = extractTextBlocks(texts.map((str, index) => ({ str,
      transform: [10, 0, 0, 10, 40, 700 - index * 12], height: 10, width: index < 2 ? 240 : index === 2 ? 510 : 210,
      fontFamily: "serif", hasEOL: true
    })), 1);
    const page = { blocks, width: 600, height: 800 };
    const inputs = preparePdfPageTranslations(page, new Map());
    const plans = preparePdfDocumentTranslations([page], new Map());
    expect(blocks).toHaveLength(2);
    expect(inputs.size).toBe(1);
    expect(plans[0].inputs.size).toBe(1);
    const input = inputs.get(0)!;
    expect(input.text.replace(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu, "")).toBe(texts.join(" "));
    expect(input.restore(input.text)).toEqual(new Map(blocks.map((block, index) => [index, block.text])));
    expect(plans[0].inputs.get(0)!.regions).toEqual([{ pageNumber: 1, index: 0 }, { pageNumber: 1, index: 1 }]);
  });

  it("translates a continued sentence together and restores each original region with independent placeholder IDs", () => {
    const blocks = fragments(), before = structuredClone(blocks);
    const inputs = preparePdfPageTranslations({ blocks, height: 800 }, new Map());
    expect(inputs.size).toBe(1);
    const input = inputs.get(0)!;
    expect(input.text).toContain("including the state");
    expect(input.text).toContain("and action vectors");
    expect(input.restore(input.text)).toEqual(new Map([[0, firstText], [1, secondText]]));
    const translated = input.text.replace("including the state", "其中包括状态").replace("and action vectors", "和动作向量");
    expect(input.restore(translated).get(0)).toContain("其中包括状态");
    expect(input.restore(translated).get(1)).toContain("和动作向量");
    expect(blocks).toEqual(before);
  });

  it("keeps bold formatting nested within the correct physical region", () => {
    const blocks = fragments();
    blocks[0].boldPrefix = "In this section,";
    const input = preparePdfPageTranslations({ blocks, height: 800 }, new Map()).get(0)!;
    const individual = preparePdfTranslation(blocks[0], new Map());
    expect(input.restore(input.text).get(0)).toBe(individual.restore(individual.text));
    expect(() => input.restore(input.text.replace(/⟪WUPAGECLOSE\d+⟫/u, ""))).toThrow("跨栏或跨页段落");
  });

  it("uses geometry when the PDF emits the right column before the left", () => {
    const [first, second] = fragments();
    const inputs = preparePdfPageTranslations({ blocks: [second, first], height: 800 }, new Map());
    expect(inputs.size).toBe(1);
    expect(inputs.get(1)!.restore(inputs.get(1)!.text)).toEqual(new Map([[1, firstText], [0, secondText]]));
  });

  it("does not skip a new section in the middle column of a three-column page", () => {
    const [first, second] = fragments();
    first.lines.forEach(line => { line.width = 150; });
    second.lines.forEach(line => { line.x = 410; line.width = 150; });
    const heading = { ...block("A new section", 230, 735, 1), fontWeight: 700 };
    heading.lines[0].width = 150;
    expect(preparePdfPageTranslations({ blocks: [first, heading, second], height: 800 }, new Map()).size).toBe(3);
  });

  it("keeps ambiguous overlapping column endings independent", () => {
    const [first, second] = fragments();
    const other = { ...structuredClone(first), id: "overlapping-region" };
    expect(preparePdfPageTranslations({ blocks: [first, other, second], height: 800 }, new Map()).size).toBe(3);
  });

  it.each(["sentence", "heading", "table", "reference", "different-size", "middle-of-column", "text-below"])(
    "does not join unrelated regions: %s", (kind) => {
      const blocks = fragments();
      if (kind === "sentence") blocks[0].text += ".";
      if (kind === "heading") blocks.push({ ...block("A new section", 330, 750, 1), fontWeight: 700 });
      if (kind === "table") blocks[1].lines = blocks[1].lines.slice(0, 1);
      if (kind === "reference") { blocks[0].role = "reference"; blocks[0].translatable = false; }
      if (kind === "different-size") blocks[1].fontSize = 15;
      if (kind === "middle-of-column") blocks[0].lines.forEach(line => { line.baselineY += 300; });
      if (kind === "text-below") blocks.push(block("Another independent paragraph below the candidate.", 50, 60, 2));
      const inputs = preparePdfPageTranslations({ blocks, height: 800 }, new Map());
      expect(inputs.size).toBe(blocks.filter(entry => entry.translatable).length);
    }
  );
});

describe("PDF paragraph flow across pages", () => {
  const page = (blocks: PdfTextBlock[]) => ({ blocks, width: 600, height: 800 });
  function spread() {
    const [first, second] = fragments();
    second.lines.forEach(line => { line.x = 50; });
    return [page([first]), page([second])];
  }

  it("owns a shared cross-page paragraph once and restores page-local placeholders independently", () => {
    const pages = spread(), before = structuredClone(pages);
    const plans = preparePdfDocumentTranslations(pages, new Map());
    const input = plans[0].inputs.get(0)!;
    expect(input.regions).toEqual([{ pageNumber: 1, index: 0 }, { pageNumber: 2, index: 0 }]);
    expect(plans[1].inputs.size).toBe(0);
    expect(plans[1].incoming).toEqual([{ pageNumber: 1, index: 0 }]);
    expect([...input.restore(input.text)]).toEqual([[input.regions[0], firstText], [input.regions[1], secondText]]);
    expect(pages).toEqual(before);
  });

  it("ignores running headers, small footnotes and a figure caption before the next page's continuation", () => {
    const pages = spread();
    const header = { ...block("Journal of Robot Research", 50, 770, 1), role: "identifier" as const, translatable: false };
    pages[1].blocks.unshift(header, block("Fig. 14: A plot of the timestep distribution.", 50, 720));
    pages[1].blocks[2].lines.forEach(line => { line.baselineY -= 240; });
    const footnote = { ...block("1 An explanatory footnote unrelated to the paragraph.", 50, 55, 2), fontSize: 8 };
    pages[0].blocks.push(footnote);
    const input = preparePdfDocumentTranslations(pages, new Map())[0].inputs.get(0)!;
    expect(input.regions).toEqual([{ pageNumber: 1, index: 0 }, { pageNumber: 2, index: 2 }]);
    expect(input.text).not.toContain("Journal");
    expect(input.text).not.toContain("Fig.");
    expect(input.text).not.toContain("footnote");
  });

  it("joins a column continuation followed by a page continuation into one logical paragraph", () => {
    const [first, middle] = fragments();
    middle.text = middle.text.replace(/\.$/u, "");
    middle.lines = Array.from({ length: 57 }, (_, index) => ({ ...middle.lines[0], baselineY: 735 - 12 * index }));
    const last = block("and preserve the original values throughout the remaining computation.", 50, 735);
    const plans = preparePdfDocumentTranslations([page([first, middle]), page([last])], new Map());
    expect(plans[0].inputs.size).toBe(1);
    expect(plans[0].inputs.get(0)!.regions).toHaveLength(3);
    expect(plans[1].incoming).toHaveLength(1);
  });

  it("removes a discretionary page-end hyphen before translating the split word", () => {
    const pages = spread();
    pages[0].blocks[0].text = "For the following experiment, we collect the robot obser-";
    pages[1].blocks[0].text = "vations before predicting a sequence of actions for the robot.";
    pages[1].blocks[0].formulas = undefined;
    const input = preparePdfDocumentTranslations(pages, new Map())[0].inputs.get(0)!;
    expect(input.text.replace(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu, "")).toContain("robot observations");
  });

  it("accepts a short one-line continuation using the surrounding prose column", () => {
    const pages = spread();
    pages[1].blocks[0] = block("state and action.", 50, 735, 1);
    pages[1].blocks[0].lines[0].width = 80;
    pages[1].blocks.push(block("A separate paragraph provides the remaining column geometry.", 50, 500));
    const plans = preparePdfDocumentTranslations(pages, new Map());
    expect(plans[0].inputs.get(0)!.regions).toHaveLength(2);
    expect(plans[1].inputs.size).toBe(1);
  });

  it("does not classify prose mentioning a figure as a caption", () => {
    const pages = spread();
    pages[0].blocks[0].text = "Figure 3 shows how the same model processes the robot";
    expect(preparePdfDocumentTranslations(pages, new Map())[0].inputs.get(0)!.regions).toHaveLength(2);
  });

  it("bounds very long chains without losing an earlier-emitted region", () => {
    const [first, second] = fragments();
    first.text = "A detailed description of " + "the model ".repeat(1300);
    const plans = preparePdfDocumentTranslations([page([second, first])], new Map());
    expect(plans[0].inputs.size).toBe(2);
    expect([...plans[0].inputs.values()].flatMap(input => input.regions).map(region => region.index).sort()).toEqual([0, 1]);
  });

  it.each(["complete", "new-section", "blank-page", "font-change", "column-change", "last-column", "table-row", "multiline-table-row"])("respects page boundaries: %s", (kind) => {
    const pages = spread();
    if (kind === "complete") pages[0].blocks[0].text += ".";
    if (kind === "new-section") pages[1].blocks.unshift({ ...block("APPENDIX", 150, 750, 1), fontWeight: 700 });
    if (kind === "blank-page") pages.splice(1, 0, page([]));
    if (kind === "font-change") pages[1].blocks[0].fontSize = 16;
    if (kind === "column-change") pages[1].blocks[0].lines.forEach(line => { line.width = 490; });
    if (kind === "last-column") pages[0].blocks.push(block("A complete paragraph in the last column ends here.", 330, 125));
    if (kind === "table-row" || kind === "multiline-table-row") {
      const count = kind === "table-row" ? 1 : 2;
      const cells = [block("mean predicted value for the current group", 50, 60, count),
        block("standard deviation measured for this group", 180, 60, count)];
      for (const cell of cells) cell.lines.forEach(line => { line.width = 110; });
      pages[0].blocks.push(...cells);
    }
    const plans = preparePdfDocumentTranslations(pages, new Map());
    expect(plans.every(plan => plan.incoming.length === 0)).toBe(true);
    expect(plans[0].inputs.get(0)!.regions.every(region => region.pageNumber === 1)).toBe(true);
  });
});
