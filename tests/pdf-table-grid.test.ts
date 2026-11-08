import { describe, expect, it } from "vitest";
import { extractTextBlocks, type PdfTextItemLike } from "../src/pdf/model";
import { findRuledTableCells, type PdfGridEdge } from "../src/pdf/table-grid";

describe("ruled PDF tables", () => {
  it("retains spanning headers and recognizes shaded subdivisions inside a shared border", () => {
    const edges: PdfGridEdge[] = [
      ...[0, 20, 40, 60].map(position => ({ axis: "horizontal" as const, position, from: 0, to: 100 })),
      ...[0, 100].map(position => ({ axis: "vertical" as const, position, from: 0, to: 60 })),
      { axis: "vertical", position: 50, from: 0, to: 40 }
    ];
    const header = { x: 0, y: 40, width: 100, height: 20 };
    expect(findRuledTableCells(edges)).toContainEqual(header);
    const fills = [{ ...header, width: 50 }, { ...header, x: 50, width: 50 }];
    expect(findRuledTableCells(edges, fills).filter(cell => cell.y === 40)).toEqual(fills);
    expect(findRuledTableCells(edges, fills.slice(0, 1))).toContainEqual(header);
  });

  it("keeps a raised footnote with its description and preserves the next cells' values", () => {
    const item = (str: string, x: number, y: number, width: number, height = 10): PdfTextItemLike => ({
      str, width, height, transform: [height, 0, 0, height, x, y]
    });
    const cells = [{ x: 0, y: 60, width: 110, height: 20 }, { x: 110, y: 60, width: 70, height: 20 },
      { x: 180, y: 60, width: 30, height: 20 }];
    const blocks = extractTextBlocks([
      item("Input voltage range", 4, 68, 84), item("2", 90, 71, 4, 6),
      item("–0.5", 119, 68, 18), item("V", 143, 68, 7), item("CC", 150, 65, 8, 6), item("+ 0.5", 159, 68, 18),
      item("mA", 188, 68, 12)
    ], 1, undefined, [], [], cells);
    const [description] = blocks.filter(block => block.translatable);
    expect(blocks.filter(block => block.translatable)).toHaveLength(1);
    expect(description.tableCell).toBe(cells[0]);
    expect(description.formulas?.map(formula => formula.text)).toEqual(["2"]);
    expect(description.formulas![0].x + description.formulas![0].width).toBeLessThan(110);
    expect(blocks.find(block => block.text === "–0.5")?.lines[0].sourceBounds).toEqual(cells[1]);
    expect(blocks.find(block => block.text === "mA")?.lines[0].sourceBounds).toEqual(cells[2]);
  });
});
