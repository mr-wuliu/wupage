import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import { renderPageWithoutText } from "../src/pdf/rendering";

describe("renderPageWithoutText", () => {
  it("suppresses PDF canvas glyph painting and restores the context", async () => {
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
    const page = {
      render: vi.fn(({ canvasContext }: { canvasContext: CanvasRenderingContext2D }) => {
        canvasContext.fillText("source", 0, 0);
        canvasContext.strokeText("source", 0, 0);
        return { promise: Promise.resolve() };
      })
    } as unknown as PDFPageProxy;

    await renderPageWithoutText(page, canvas, viewport);

    expect(paintedText).toEqual([]);
    expect(canvas.width).toBe(612);
    expect(canvas.height).toBe(792);
    expect(context.fillText).toBe(fillText);
    expect(context.strokeText).toBe(strokeText);
  });

  it("restores canvas text methods when PDF.js rendering fails", async () => {
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
      render: () => ({ promise: Promise.reject(new Error("render failed")) })
    } as unknown as PDFPageProxy;

    await expect(renderPageWithoutText(page, canvas, viewport)).rejects.toThrow("render failed");
    expect(context.fillText).toBe(fillText);
    expect(context.strokeText).toBe(strokeText);
  });
});
