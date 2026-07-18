import { describe, expect, it } from "vitest";
import { findAvailableHorizontalRight, getTranslatedBlockLayout } from "../src/pdf/layout";
import type { PdfTextBlock } from "../src/pdf/model";

describe("PDF translated text layout", () => {
  it("keeps short translated units at the source font size when the cell has room", () => {
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
    expect(layout.fontSize).toBeCloseTo(9.4);
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
