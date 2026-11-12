import { describe, expect, it } from "vitest";
import { findAvailableHorizontalLeft, findAvailableHorizontalRight, findAvailableVerticalBottom, getTranslatedBlockLayout } from "../src/pdf/layout";
import type { PdfTextBlock } from "../src/pdf/model";

describe("PDF translated text layout", () => {
  it("does not expand a one-line wrapping region into its adjacent artwork", () => {
    const block = { ...createBlock("A narrow fragment", 40, 100), paragraphId: "page-1-paragraph-1" };
    const layout = getTranslatedBlockLayout(createMeasureContext(), "需要限制在插图旁边的译文", block,
      [{ x: 40, y: 20, width: 100, height: 12 }], 1, 600, 600)!;
    expect(layout.left).toBe(40);
    expect(layout.width).toBe(100);
    expect(layout.textAlign).toBe("left");
  });

  it("centers a longer translated header within its own cell", () => {
    const block = createBlock("MAX", 142, 16);
    const layout = getTranslatedBlockLayout(createMeasureContext(), "最大允许值", block,
      [{ x: 142, y: 15, width: 16, height: 13 }], 1, 240, 500, 0,
      { x: 133, y: 10, width: 34, height: 18 })!;
    expect(layout.textAlign).toBe("center");
    expect(layout.left + layout.width / 2).toBe(150);
    expect(layout.left + layout.width).toBeLessThan(167);
    expect(layout.top + layout.height).toBeLessThan(28);
    const besideSymbol = getTranslatedBlockLayout(createMeasureContext(), "说明", block,
      [{ x: 142, y: 15, width: 16, height: 13 }], 1, 240, 500, 140,
      { x: 133, y: 10, width: 34, height: 18 })!;
    expect(besideSymbol.textAlign).toBe("left");
    expect(besideSymbol.left).toBe(142);
  });

  it("gives a right-aligned header space to expand leftward within its cell", () => {
    const block = createBlock("MAX", 151, 14);
    const layout = getTranslatedBlockLayout(createMeasureContext(), "最大允许值", block,
      [{ x: 151, y: 15, width: 14, height: 12 }], 1, 240, 500, 0,
      { x: 125, y: 10, width: 42, height: 18 })!;
    expect(layout.textAlign).toBe("right");
    expect(layout.width).toBeGreaterThan(14);
    expect(layout.left).toBeGreaterThan(125);
    expect(layout.left + layout.width).toBe(165);
  });

  it("stops manual vertical expansion before preserved equations as well as prose", () => {
    expect(findAvailableVerticalBottom([
      [{ x: 20, y: 30, width: 200, height: 20 }],
      [{ x: 50, y: 70, width: 100, height: 30 }],
      [{ x: 300, y: 55, width: 100, height: 10 }]
    ], 0, 800)).toBe(68);
  });
  it("measures a formula by its original aspect ratio instead of the token's text width", () => {
    const block = createBlock("Loss ⟪WUPAGE0⟫", 10, 100);
    block.formulas = [{ placeholder: "⟪WUPAGE0⟫", text: "α", x: 10, y: 90, width: 8, height: 10, baselineY: 92, fontSize: 10, display: false }];
    const layout = getTranslatedBlockLayout(createMeasureContext(), "损失 ⟪WUPAGE0⟫", block,
      [{ x: 10, y: 100, width: 100, height: 12 }], 1)!;
    expect(layout.fontSize).toBeCloseTo(9.8);
    expect(layout.lineHeight).toBeCloseTo(9.8 * 1.14);
  });
  it("starts at the source size and leaves actual wrapping to the browser", () => {
    const block = createBlock("A source heading", 100, 50);
    const layout = getTranslatedBlockLayout(createMeasureContext(), "很长的译文标题需要浏览器实际换行", block,
      [{ x: 100, y: 10, width: 50, height: 11.4 }], 2)!;
    expect(layout.fontSize).toBeCloseTo(19.6);
  });
  it("retains centered headings and source paragraph leading", () => {
    const block = createBlock("Heading", 100, 100);
    const layout = getTranslatedBlockLayout(createMeasureContext(), "标题", block,
      [{ x: 100, y: 10, width: 100, height: 11.4 }], 1, 300, 300)!;
    expect(layout.textAlign).toBe("center");
    const expanded = getTranslatedBlockLayout(createMeasureContext(), "长一些的中文标题需要扩宽原文框", block,
      [{ x: 100, y: 10, width: 100, height: 11.4 }], 1, 300, 300)!;
    expect(expanded.width).toBeGreaterThan(100);
    expect(expanded.left + expanded.width / 2).toBe(150);
    const left = findAvailableHorizontalLeft([
      [{ x: 100, y: 10, width: 100, height: 11.4 }],
      [{ x: 20, y: 10, width: 60, height: 11.4 }]
    ], 0);
    const adjacent = getTranslatedBlockLayout(createMeasureContext(), "长一些的中文标题需要扩宽原文框", block,
      [{ x: 100, y: 10, width: 100, height: 11.4 }], 1, 300, 300, left)!;
    expect(adjacent.left).toBeGreaterThanOrEqual(82);
    block.lines.push({ ...block.lines[0], baselineY: 87 });
    const paragraph = getTranslatedBlockLayout(createMeasureContext(), "分为两行的正文", block,
      [{ x: 100, y: 10, width: 100, height: 24.4 }], 1)!;
    expect(paragraph.textAlign).toBe("left");
    expect(paragraph.lineHeight / paragraph.fontSize).toBeCloseTo(1.3);
  });
  it("does not center full-width prose or bullet items and retains hanging indentation", () => {
    const block = createBlock("• A bullet item", 30, 240);
    const layout = getTranslatedBlockLayout(createMeasureContext(), "• 项目正文", block,
      [{ x: 30, y: 10, width: 240, height: 11.4 }], 1, 300, 300)!;
    expect(layout.textAlign).toBe("left");
    expect(layout.hangingIndent).toBe(10);
    block.text = "An ordinary full-width sentence.";
    const prose = getTranslatedBlockLayout(createMeasureContext(), "普通正文", block,
      [{ x: 30, y: 10, width: 240, height: 11.4 }], 1, 300, 300)!;
    expect(prose.textAlign).toBe("left");
  });
  it("keeps short translated units close to the source font size without clipping the line box", () => {
    const context = createMeasureContext();
    const block = createBlock("Hz", 402, 10);
    const rectangles = [{ x: 402, y: 100, width: 10, height: 11.4 }];
    const right = findAvailableHorizontalRight([
      [{ x: 354, y: 100, width: 28, height: 11.4 }],
      rectangles,
      [{ x: 436, y: 100, width: 70, height: 11.4 }]
    ], 1, 595);

    const layout = getTranslatedBlockLayout(context, "赫兹", block, rectangles, 1, right)!;

    expect(right).toBe(434);
    expect(layout.width).toBeGreaterThan(20);
    expect(layout.fontSize).toBeGreaterThan(8.5);
    expect(layout.lineHeight).toBeLessThanOrEqual(layout.height);
  });

  it("does not expand translated text across the next cell", () => {
    const context = createMeasureContext();
    const block = createBlock("Unit", 402, 19);
    const rectangles = [{ x: 402, y: 80, width: 19, height: 11.4 }];
    const right = findAvailableHorizontalRight([
      rectangles,
      [{ x: 436, y: 80, width: 42, height: 11.4 }]
    ], 0, 595);

    const layout = getTranslatedBlockLayout(context, "一个很长的单位名称", block, rectangles, 1, right)!;

    expect(layout.left + layout.width).toBeLessThanOrEqual(434);
  });
});

function createMeasureContext(): { font: string; measureText(text: string): { width: number } } {
  return {
    font: "",
    measureText: (text) => ({ width: Array.from(text).length * 10 })
  };
}

function createBlock(text: string, x: number, width: number): PdfTextBlock {
  return {
    id: "page-3-text-unit",
    text,
    translatable: true,
    lines: [{ text, x, baselineY: 100, width, height: 10 }],
    fontFamily: "Arial, sans-serif",
    fontWeight: 400,
    fontSize: 10
  };
}
