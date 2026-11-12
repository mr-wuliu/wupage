import { describe, expect, it } from "vitest";
import { extractTextBlocks, normalizePdfTextItems } from "../src/pdf/model";

describe("PDF text extraction", () => {
  it("uses visible line geometry when a publisher inserts an EOL inside a sentence", () => {
    const blocks = extractTextBlocks([
      {str:"A paragraph begins here and",width:150,transform:[10,0,0,10,40,600],hasEOL:true},
      {str:"continues on the same line.",width:130,transform:[10,0,0,10,193,600],hasEOL:true},
      {str:"The following line remains in this paragraph.",width:280,transform:[10,0,0,10,40,588]}
    ].map(item=>({...item,height:10,fontFamily:"serif"})),1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lines).toHaveLength(2);
    expect(blocks[0].text).toContain("here and continues on the same line.");
  });

  it("removes duplicate text at the same position while keeping repeated labels in other cells", () => {
    const item = {str:"NOTE 5",width:28.573,height:7.91,fontName:"Helvetica",transform:[7.91,0,0,7.91,120.4968,429.2721]};
    const blocks = extractTextBlocks([item,{...item,transform:[7.91,0,0,7.91,120.5003,429.2721]},
      {...item,transform:[7.91,0,0,7.91,320,429.2721]}],1);
    expect(blocks).toHaveLength(2);
    expect(blocks.map(block=>block.text)).toEqual(["NOTE 5","NOTE 5"]);
  });

  it("keeps staggered table header rows separate from adjacent math symbols", () => {
    const blocks = extractTextBlocks([
      {str:"d",transform:[10,0,0,10,207,647.5],width:5,fontName:"CMMI10"},
      {str:"train",transform:[10,0,0,10,371,652.96],width:18,fontName:"Times-Roman"},
      {str:"steps",transform:[10,0,0,10,370.3,641.58],width:20,fontName:"Times-Roman"}
    ].map(item=>({...item,height:10,fontFamily:"serif"})),9);
    expect(blocks.filter(block=>block.translatable).map(block=>block.text)).toEqual(["train steps"]);
    expect(blocks.some(block=>block.text.includes("train")&&block.formulas?.length)).toBe(false);
  });

  it("keeps the narrow and wide parts of an abstract in separate regions around artwork", () => {
    const texts = [
      "ABSTRACT: The material is prepared using a process that",
      "combines several components with improved properties and",
      "provides a stable response under the conditions described",
      "in this study. The results support applications involving",
      "a wide range of environments while retaining the original structure and performance of the material.",
      "Further experiments confirm these observations."
    ];
    const blocks = extractTextBlocks(texts.map((str, index) => ({ str,
      transform: [10, 0, 0, 10, 40, 700 - index * 12], width: index < 4 ? 240 : index === 4 ? 510 : 220,
      height: 10, fontFamily: "serif", hasEOL: true
    })), 1);
    expect(blocks).toHaveLength(2);
    expect(blocks.map(block => block.lines.length)).toEqual([4, 2]);
    expect(blocks[0].paragraphId).toBeTruthy();
    expect(blocks[1].paragraphId).toBe(blocks[0].paragraphId);
    expect(blocks.map(block => block.text).join(" ")).toBe(texts.join(" "));
  });

  it.each([
    { widths: [510, 510, 240, 240, 200], lengths: [2, 3] },
    { widths: [240, 240, 150], lengths: [3] }
  ])("distinguishes a sustained narrower region from a short final line: $widths", ({ widths, lengths }) => {
    const blocks = extractTextBlocks(widths.map((width, index) => ({
      str: "A description of the material and its environment", width, height: 10,
      transform: [10, 0, 0, 10, 40, 700 - index * 12], fontFamily: "serif", hasEOL: true
    })), 1);
    expect(blocks.map(block => block.lines.length)).toEqual(lengths);
    expect(blocks.every(block => block.translatable)).toBe(true);
  });

  it("preserves a publisher's oversized square glyph without enlarging the section heading", () => {
    const blocks = extractTextBlocks([
      { str: "■", transform: [20, 0, 0, 20, 40, 600], width: 5, height: 20, fontFamily: "sans-serif" },
      { str: "INTRODUCTION", transform: [10, 0, 0, 10, 50, 600], width: 95, height: 10,
        fontFamily: "sans-serif", fontWeight: 700 }
    ], 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "■", translatable: false, preserveOriginal: true });
    expect(blocks[1]).toMatchObject({ text: "INTRODUCTION", translatable: true, fontSize: 10, fontWeight: 700 });
  });

  it.each(["ZapfDingbats", "Opaque1"])("preserves a dingbat square with a Latin text mapping: %s", fontName => {
    const blocks = extractTextBlocks([
      { str: "n", transform: [16, 0, 0, 16, 40, 480], width: 12.176, height: 16, fontName },
      { str: "INTRODUCTION", transform: [10, 0, 0, 10, 62, 480], width: 76.66, height: 10,
        fontName: "Helvetica-Bold", fontWeight: 700 }
    ], 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "n", translatable: false, preserveOriginal: true });
    expect(blocks[1]).toMatchObject({ text: "INTRODUCTION", translatable: true, fontSize: 10 });
  });

  it("joins a bold run-in heading with regular prose without making the whole paragraph bold", () => {
    const items = [
      { str: "Flow matching.", transform: [10, 0, 0, 10, 30, 100], width: 65, fontWeight: 700 },
      { str: " The noisy", transform: [10, 0, 0, 10, 95, 100], width: 45, fontWeight: 400 },
      { str: "action chunk is mapped to an embedding.", transform: [10, 0, 0, 10, 20, 88], width: 180, fontWeight: 400 }
    ].map(item => ({ ...item, height: 10, fontFamily: "serif" }));
    const blocks = extractTextBlocks(items, 15);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: "Flow matching. The noisy action chunk is mapped to an embedding.",
      fontWeight: 400, boldPrefix: "Flow matching.", translatable: true
    });
  });

  it("keeps a standalone bold heading separate from its following paragraph", () => {
    const blocks = extractTextBlocks([
      { str: "Section heading", transform: [10, 0, 0, 10, 20, 100], width: 80, fontWeight: 700 },
      { str: "A regular paragraph begins here.", transform: [10, 0, 0, 10, 20, 88], width: 160, fontWeight: 400 }
    ].map(item => ({ ...item, height: 10, fontFamily: "serif" })), 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ fontWeight: 700 });
    expect(blocks[0].boldPrefix).toBeUndefined();
  });

  it("normalizes a rotated page before deciding which labels need preservation", () => {
    const items = normalizePdfTextItems([
      { str: "Upright in the viewer.", transform: [0, 10, -10, 0, 100, 200], width: 100, height: 10 }
    ], { height: 612, transform: [0, 1, 1, 0, 0, 0] });
    expect(items[0].transform).toEqual([10, -0, 0, 10, 200, 512]);
    expect(extractTextBlocks(items, 1)[0]).toMatchObject({ text: "Upright in the viewer.", translatable: true });
  });

  it("accounts for cropped page origins and PDF user units", () => {
    const [item] = normalizePdfTextItems([
      { str: "Cropped", transform: [10, 0, 0, 10, 100, 200], width: 40, height: 10 }
    ], { height: 800, transform: [2, 0, 0, -2, -100, 900] });
    expect(Array.from(item.transform).slice(4)).toEqual([100, 300]);
    expect(item.width).toBe(80);
    expect(item.height).toBe(20);
  });

  it("preserves angled chart labels in their transformed bounds instead of reflowing them horizontally", () => {
    const blocks = extractTextBlocks([
      { str: "Vertical axis", transform: [0, 10, -10, 0, 100, 200], width: 50, height: 10 },
      { str: "Normal caption.", transform: [10, 0, 0, 10, 20, 180], width: 80, height: 10 }
    ], 1);
    expect(blocks[0]).toMatchObject({ text: "Vertical axis", preserveOriginal: true, translatable: false });
    const line = blocks[0].lines[0];
    expect(line.x).toBeLessThanOrEqual(91);
    expect(line.width).toBeGreaterThanOrEqual(11.4);
    expect(line.height * 1.14).toBeGreaterThanOrEqual(50);
    expect(line.baselineY - line.height * 0.24).toBeLessThanOrEqual(200);
    expect(blocks[1].translatable).toBe(true);
  });

  it("joins text items on the same visual line", () => {
    expect(extractTextBlocks([
      { str: "Hello", transform: [1, 0, 0, 12, 10, 100], width: 28 },
      { str: "world", transform: [1, 0, 0, 12, 42, 100], width: 30, hasEOL: true },
      { str: "第二行", transform: [1, 0, 0, 12, 10, 70], width: 36 }
    ], 2)).toEqual([
      {
        id: "page-2-text-1",
        text: "Hello world",
        translatable: true,
        lines: [{ text: "Hello world", x: 10, baselineY: 100, width: 62, height: 12 }],
        fontFamily: "Arial, sans-serif",
        fontWeight: 400,
        fontSize: 12
      },
      {
        id: "page-2-text-2",
        text: "第二行",
        translatable: true,
        lines: [{ text: "第二行", x: 10, baselineY: 70, width: 36, height: 12 }],
        fontFamily: "Arial, sans-serif",
        fontWeight: 400,
        fontSize: 12
      }
    ]);
  });

  it("does not insert spaces between CJK fragments and preserves number-only lines", () => {
    expect(extractTextBlocks([
      { str: "沉浸式", transform: [1, 0, 0, 11, 10, 60], width: 36 },
      { str: "翻译", transform: [1, 0, 0, 11, 48, 60], width: 22, hasEOL: true },
      { str: "2026 / 07", transform: [1, 0, 0, 11, 10, 40], width: 48 }
    ], 1)).toEqual([
      {
        id: "page-1-text-1",
        text: "沉浸式翻译",
        translatable: true,
        lines: [{ text: "沉浸式翻译", x: 10, baselineY: 60, width: 60, height: 11 }],
        fontFamily: "Arial, sans-serif",
        fontWeight: 400,
        fontSize: 11
      },
      {
        id: "page-1-text-2",
        text: "2026 / 07",
        translatable: false,
        lines: [{ text: "2026 / 07", x: 10, baselineY: 40, width: 48, height: 11 }],
        fontFamily: "Arial, sans-serif",
        fontWeight: 400,
        fontSize: 11
      }
    ]);
  });

  it("groups wrapped lines into a positioned paragraph", () => {
    const [block] = extractTextBlocks([
      { str: "A paragraph that", transform: [1, 0, 0, 10, 20, 100], width: 80, hasEOL: true },
      { str: "wraps to next line", transform: [1, 0, 0, 10, 20, 87], width: 84, hasEOL: true },
      { str: "Next paragraph.", transform: [1, 0, 0, 10, 20, 60], width: 72 }
    ], 1);

    expect(block.text).toBe("A paragraph that wraps to next line");
    expect(block.lines).toHaveLength(2);
  });

  it("translates dotted contents entries separately and preserves leaders and page numbers", () => {
    const blocks = extractTextBlocks([
      { str: "Colophon . . . . . . . . ", transform: [8, 0, 0, 8, 115, 701], width: 160 },
      { str: "1", transform: [8, 0, 0, 8, 280, 701], width: 5, hasEOL: true },
      { str: "1. Introduction. . . . . . . . 13", transform: [8, 0, 0, 8, 115, 689], width: 170, hasEOL: true },
      { str: "1.1. The Chip .... 14", transform: [8, 0, 0, 8, 127, 677], width: 158, hasEOL: true }
    ], 4, (_item, text) => text.length * 4);
    const titles = blocks.filter((block) => block.translatable);
    expect(titles.map((block) => block.text)).toEqual(["Colophon", "1. Introduction", "1.1. The Chip"]);
    expect(titles.every((block) => block.lines.length === 1 && block.tocPart === "title")).toBe(true);
    expect(titles.map((block) => block.lines[0].x)).toEqual([115, 115, 127]);
    expect(blocks.filter((block) => block.tocPart === "leader")).toHaveLength(3);
    expect(blocks.filter((block) => ["1", "13", "14"].includes(block.text))
      .every((block) => block.preserveOriginal && !block.translatable)).toBe(true);
    // Synthesized spaces in the full item must not shrink the title's crop.
    expect(titles[0].lines[0].width).toBe(36);
  });

  it("recognizes fragmented contents titles and Roman page locators without changing prose ellipses", () => {
    const blocks = extractTextBlocks([
      { str: "Legal", transform: [8, 0, 0, 8, 20, 100], width: 20 },
      { str: "notice", transform: [8, 0, 0, 8, 42, 100], width: 24 },
      { str: "........", transform: [8, 0, 0, 8, 70, 100], width: 120 },
      { str: "iv", transform: [8, 0, 0, 8, 200, 100], width: 6, hasEOL: true },
      { str: "Wait .... then continue.", transform: [8, 0, 0, 8, 20, 70], width: 100 },
      { str: "1.1. Why RP2040? .... 9", transform: [8, 0, 0, 8, 20, 40], width: 180 }
    ], 1);
    expect(blocks.filter((block) => block.translatable).map((block) => block.text))
      .toEqual(["Legal notice", "Wait .... then continue.", "1.1. Why RP2040?"]);
    expect(blocks.find((block) => block.text === "iv")).toMatchObject({ preserveOriginal: true, translatable: false });
  });

  it("splits table cells separated by a large horizontal gap", () => {
    const blocks = extractTextBlocks([
      { str: "General", transform: [1, 0, 0, 12, 64.9, 688.9], width: 42.9 },
      { str: "HFOV - Horizontal", transform: [1, 0, 0, 10, 118.8, 689.3], width: 72.8, hasEOL: true },
      { str: "Optical angle", transform: [1, 0, 0, 10, 118.8, 677.2], width: 53.1 },
      { str: "10", transform: [1, 0, 0, 10, 235.9, 683.3], width: 10.1 },
      { str: "45", transform: [1, 0, 0, 10, 363.5, 683.3], width: 10.1 },
      { str: "Deg.", transform: [1, 0, 0, 10, 402.2, 683.3], width: 18.2 }
    ], 3);

    expect(blocks.map((block) => block.text)).toEqual([
      "General",
      "HFOV - Horizontal Optical angle",
      "10",
      "45",
      "Deg."
    ]);
    expect(blocks.map((block) => block.translatable)).toEqual([true, true, false, false, true]);
  });
});
