import { describe, expect, it, vi } from "vitest";
import { OPS, type PDFPageProxy } from "pdfjs-dist";
import { renderPageWithoutText, renderRotatedPdfText, rotatedTextFilter } from "../src/pdf/rendering";

vi.mock("pdfjs-dist", () => ({ OPS: { save: 10, restore: 11, transform: 12, fill: 22, endPath: 28,
  clip: 29, beginText: 31, setFont: 37, setTextMatrix: 42, showText: 44, showSpacedText: 45,
  nextLineShowText: 46, nextLineSetSpacingShowText: 47, setGState: 9, paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75, paintImageXObject: 85, constructPath: 91 } }));

describe("rotated PDF text background", () => {
  const viewport = [1, 0, 0, -1, 0, 800];
  it("preserves watermark glyphs while excluding upright body text, paths and images", () => {
    const filter = rotatedTextFilter(viewport);
    expect(filter(OPS.setTextMatrix, [1, 1, -1, 1, 80, 100])).toBe(true);
    expect(filter(OPS.showText, [])).toBe(true);
    expect(filter(OPS.setGState, [[['ca', 0.2]]])).toBe(true);
    expect(filter(OPS.constructPath, [OPS.fill])).toBe(false);
    expect(filter(OPS.paintImageXObject, [])).toBe(false);
    expect(filter(OPS.clip, [])).toBe(true);
    expect(filter(OPS.constructPath, [OPS.endPath])).toBe(true);
    filter(OPS.setTextMatrix, [1, 0, 0, 1, 80, 100]);
    for (const op of [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]) expect(filter(op, [])).toBe(false);
  });
  it("tracks nested form transforms and restores the body text orientation", () => {
    const filter = rotatedTextFilter(viewport);
    filter(OPS.paintFormXObjectBegin, [[0.7, 0.7, -0.7, 0.7, 0, 0]]);
    filter(OPS.beginText, []);
    expect(filter(OPS.showText, [])).toBe(true);
    filter(OPS.save, []);
    filter(OPS.transform, [1, -1, 1, 1, 0, 0]);
    expect(filter(OPS.showText, [])).toBe(false);
    filter(OPS.restore, []);
    expect(filter(OPS.showText, [])).toBe(true);
    filter(OPS.paintFormXObjectEnd, []);
    expect(filter(OPS.showText, [])).toBe(false);
  });
  it("uses displayed page rotation instead of treating an upright rotated page as a watermark", () => {
    const filter = rotatedTextFilter([0, 1, 1, 0, 0, 0]);
    filter(OPS.setTextMatrix, [0, 1, -1, 0, 100, 200]);
    expect(filter(OPS.showText, [])).toBe(false);
    filter(OPS.setTextMatrix, [1, 0, 0, 1, 100, 200]);
    expect(filter(OPS.showText, [])).toBe(true);
  });
  it("uses a transparent canvas and the render task's own optimized operations", async () => {
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const results: boolean[] = [];
    const fnArray = [OPS.setTextMatrix, OPS.showText, OPS.setTextMatrix, OPS.showText, OPS.paintImageXObject];
    const argsArray = [[new Float32Array([1, 1, -1, 1, 0, 0])], [], [new Float32Array([1, 0, 0, 1, 0, 0])], [], []];
    const render = vi.fn(({ operationsFilter }) => ({
      _internalRenderTask: { operatorList: { fnArray, argsArray } },
      promise: Promise.resolve().then(() => fnArray.forEach((_, index) => results.push(operationsFilter(index))))
    }));
    await renderRotatedPdfText({ render } as unknown as PDFPageProxy, canvas,
      { width: 600, height: 800, transform: viewport } as ReturnType<PDFPageProxy['getViewport']>);
    expect(results).toEqual([true, true, true, false, false]);
    expect(render.mock.calls[0][0].background).toBe('rgba(0,0,0,0)');
  });
});

describe("renderPageWithoutText", () => {
  it("skips all PDF text operators, including vector glyphs, while retaining graphics", async () => {
    const paintedText: string[] = [];
    const fillText = (text: string): void => { paintedText.push(`fill:${text}`); };
    const strokeText = (text: string): void => { paintedText.push(`stroke:${text}`); };
    const context = { fillText, strokeText } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context)
    } as unknown as HTMLCanvasElement;
    const viewport = { width: 612.8, height: 792.2 } as ReturnType<PDFPageProxy["getViewport"]>;
    const drawVector = vi.fn();
    const page = {
      // Deliberately differs from the optimized list used by render().
      getOperatorList: async () => ({ fnArray: [44, 45, 46, 47, 91] }),
      render: vi.fn(({ operationsFilter }: { operationsFilter: (index: number) => boolean }) => {
        return {
          _internalRenderTask: { operatorList: { fnArray: [91, 44, 45, 46, 47] } },
          promise: Promise.resolve().then(() => {
            for (let index = 0; index < 5; index++) {
              if (!operationsFilter(index)) continue;
              if (index > 0) paintedText.push("vector font glyph");
              else drawVector();
            }
          })
        };
      })
    } as unknown as PDFPageProxy;

    await renderPageWithoutText(page, canvas, viewport);

    expect(paintedText).toEqual([]);
    expect(drawVector).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(612);
    expect(canvas.height).toBe(792);
    expect(context.fillText).toBe(fillText);
    expect(context.strokeText).toBe(strokeText);
  });

  it("propagates rendering failures without changing canvas text methods", async () => {
    const fillText = vi.fn();
    const strokeText = vi.fn();
    const context = { fillText, strokeText } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context)
    } as unknown as HTMLCanvasElement;
    const viewport = { width: 100, height: 100 } as ReturnType<PDFPageProxy["getViewport"]>;
    const page = {
      getOperatorList: async () => ({ fnArray: [] }),
      render: () => ({ promise: Promise.reject(new Error("render failed")) })
    } as unknown as PDFPageProxy;

    await expect(renderPageWithoutText(page, canvas, viewport)).rejects.toThrow("render failed");
    expect(context.fillText).toBe(fillText);
    expect(context.strokeText).toBe(strokeText);
  });
});
