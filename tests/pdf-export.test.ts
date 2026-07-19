// @vitest-environment jsdom

import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildRasterPdf,
  paintTranslationLayer,
  translatedPdfFileName,
  wrapCanvasText
} from "../src/pdf/export";

afterEach(() => {
  document.body.replaceChildren();
});

describe("translated PDF export", () => {
  it("packages rasterized pages using their original PDF dimensions", async () => {
    const onePixelPng = new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ));

    const bytes = await buildRasterPdf([{
      width: 612,
      height: 792,
      imageBytes: onePixelPng,
      format: "png"
    }], "Translated document");
    const document = await PDFDocument.load(bytes);

    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(document.getTitle()).toBe("Translated document");
  });

  it("paints the current editable block geometry and text", () => {
    const layer = document.createElement("div");
    layer.innerHTML = `
      <div class="translation-block" style="left: 20px; top: 30px; width: 80px; height: 50px">
        <div class="translation-block-text"
          style="color: rgb(10, 20, 30); font-family: Arial; font-size: 12px; font-weight: 600; line-height: 16px"
        >一段可编辑的译文</div>
      </div>
    `;
    const fillText = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fillText,
      measureText: (text: string) => ({ width: text.length * 10.5 }),
      fillStyle: "",
      font: "",
      textBaseline: "alphabetic"
    } as unknown as CanvasRenderingContext2D;

    paintTranslationLayer(context, layer);

    expect(context.rect).toHaveBeenCalledWith(20, 30, 80, 50);
    expect(context.font).toBe("600 12px Arial");
    expect(context.fillStyle).toBe("rgb(10, 20, 30)");
    expect(fillText).toHaveBeenCalledWith("一段可编辑的译", 20, 32);
    expect(fillText).toHaveBeenCalledWith("文", 20, 48);
  });

  it("wraps explicit lines and creates a safe translated filename", () => {
    const context = {
      measureText: (text: string) => ({ width: text.length * 8 })
    } as Pick<CanvasRenderingContext2D, "measureText">;

    expect(wrapCanvasText(context, "abcd\nef", 24)).toEqual(["abc", "d", "ef"]);
    expect(translatedPdfFileName("report:final.pdf")).toBe("report_final-translated.pdf");
    expect(translatedPdfFileName(".pdf")).toBe("document-translated.pdf");
  });
});
