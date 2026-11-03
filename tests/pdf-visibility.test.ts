import { describe, expect, it } from "vitest";
import { filterVisiblePdfText, type PdfFontVisibility } from "../src/pdf/visibility";

const ops = { save: 1, restore: 2, setTextRenderingMode: 3, setGState: 4, beginMarkedContent: 5,
  beginMarkedContentProps: 6, endMarkedContent: 7, showText: 8, showSpacedText: 9, nextLineShowText: 10, nextLineSetSpacingShowText: 11,
  transform: 12, paintFormXObjectBegin: 13, paintFormXObjectEnd: 14, setCharWidth: 15, setCharWidthAndBounds: 16,
  setFont: 17, fill: 18 };
const glyphs = (text: string) => Array.from(text, (unicode) => ({ unicode }));

describe("PDF text visibility", () => {
  it("excludes non-painting Type 3 text without discarding visible or unknown Type 3 glyphs", () => {
    const items = [
      { str: "Ghost label", fontName: "empty" }, { str: "Visible label", fontName: "draws" },
      { str: "Unknown program", fontName: "unknown" }, { str: "Missing program", fontName: "missing" },
      { str: "Ordinary text", fontName: "ordinary" }
    ];
    const fonts = new Map<string, PdfFontVisibility>([
      ["empty", { isType3Font: true, charProcOperatorList: { C0: { fnArray: [16, 12] }, C1: { fnArray: [15, 1, 2] } } }],
      ["draws", { isType3Font: true, charProcOperatorList: { space: { fnArray: [16] }, C0: { fnArray: [16, 18] } } }],
      ["unknown", { isType3Font: true, charProcOperatorList: { C0: { fnArray: [999] } } }],
      ["missing", { isType3Font: true }], ["ordinary", { isType3Font: false }]
    ]);
    expect(filterVisiblePdfText(items, undefined, ops, undefined, fonts)).toEqual(items.slice(1));
  });

  it("does not match a visible duplicate against discarded Type 3 text inside a clipped form", () => {
    const items = [
      { str: "Same", fontName: "empty", transform: [10, 0, 0, 10, 0, 200], width: 30 },
      { str: "Same", fontName: "regular", transform: [10, 0, 0, 10, 0, 100], width: 30 }
    ];
    const operators = { fnArray: [13, 17, 8, 14, 17, 8], argsArray: [
      [[1, 0, 0, 1, 0, 0], [0, 0, 100, 50]], ["empty", 10], [glyphs("Same")], [], ["regular", 10], [glyphs("Same")]
    ] };
    const fonts = new Map([["empty", { isType3Font: true, charProcOperatorList: { C0: { fnArray: [16, 12] } } }]]);
    expect(filterVisiblePdfText(items, operators, ops, undefined, fonts)).toEqual([items[1]]);
  });

  it("excludes subplot titles outside a nested figure's crop box", () => {
    const items = [
      { str: "Title", transform: [10, 0, 0, 10, 100, 270], width: 40 },
      { str: "Axis", transform: [10, 0, 0, 10, 110, 230], width: 25 },
      { str: "Caption", transform: [10, 0, 0, 10, 100, 170], width: 40 }
    ];
    const operators = { fnArray: [13, 8, 8, 14, 8], argsArray: [
      [[1, 0, 0, 1, 100, 200], [0, 0, 100, 50]], [glyphs("Title")], [glyphs("Axis")], [], [glyphs("Caption")]
    ] };
    expect(filterVisiblePdfText(items, operators, ops)).toEqual(items.slice(1));
  });

  it("excludes disabled optional-content titles without hiding the visible chart labels", () => {
    const items = ["Input-Input Layer 5", "The Law", "Visible caption"].map((str) => ({ str }));
    const operators = {
      fnArray: [6, 8, 7, 8, 8],
      argsArray: [["OC", { id: "hidden" }], [glyphs("Input-Input Layer5")], [], [glyphs("TheLaw")], [glyphs("Visiblecaption")]]
    };
    expect(filterVisiblePdfText(items, operators, ops, { isVisible: () => false })).toEqual(items.slice(1));
  });

  it("matches duplicate words in drawing order and inherits hidden parent groups", () => {
    const items = [{ str: "Same" }, { str: "Same" }, { str: "Same" }];
    const operators = { fnArray: [8, 6, 5, 8, 7, 7, 8], argsArray: [[glyphs("Same")], ["OC", {}], ["Span"], [glyphs("Same")], [], [], [glyphs("Same")]] };
    expect(filterVisiblePdfText(items, operators, ops, { isVisible: () => false })).toEqual([items[0], items[2]]);
  });

  it("excludes invisible OCR text and restores rendering mode across graphics states", () => {
    const items = [{ str: "Hidden OCR" }, { str: "Visible text" }];
    const operators = { fnArray: [1, 3, 8, 2, 8], argsArray: [[], [3], [glyphs("HiddenOCR")], [], [glyphs("Visibletext")]] };
    expect(filterVisiblePdfText(items, operators, ops)).toEqual([items[1]]);
  });

  it("keeps visible strokes when fill opacity is zero", () => {
    const items = [{ str: "Hidden" }, { str: "Outlined" }];
    const operators = { fnArray: [4, 8, 3, 8], argsArray: [[[["ca", 0]]], [glyphs("Hidden")], [1], [glyphs("Outlined")]] };
    expect(filterVisiblePdfText(items, operators, ops)).toEqual([items[1]]);
  });

  it("keeps unmatched text and handles ligature normalization", () => {
    const items = [{ str: "Unknown" }, { str: "final" }, { str: "Visible" }];
    const operators = { fnArray: [3, 8, 3, 8], argsArray: [[3], [glyphs("ﬁnal")], [0], [glyphs("Visible")]] };
    expect(filterVisiblePdfText(items, operators, ops)).toEqual([items[0], items[2]]);
  });
});
