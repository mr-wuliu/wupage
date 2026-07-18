import { describe, expect, it } from "vitest";
import { extractTextBlocks } from "../src/pdf/model";

describe("PDF text extraction", () => {
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
