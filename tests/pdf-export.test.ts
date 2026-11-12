// @vitest-environment jsdom

import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createEditableTranslationBlock } from "../src/pdf/editor";
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
  it("rejects truncated text in image-only export as well as searchable export", () => {
    const layer = document.createElement("div");
    layer.innerHTML = '<div class="translation-block" data-layout-overflow="true"><div class="translation-block-text">完整译文不能静默丢失</div></div>';
    const context = { save: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D;
    expect(() => paintTranslationLayer(context, layer)).toThrow("超出可读排版范围");
    expect(context.fillText).not.toHaveBeenCalled();
  });

  it("checks live overflow after editing and permits export after the block is repaired", () => {
    const layer = document.createElement("div");
    layer.innerHTML = '<div class="translation-block" style="width:80px;height:20px"><div class="translation-block-text">完整译文</div></div>';
    const block = layer.firstElementChild!, text = block.firstElementChild!;
    let contentHeight = 50;
    Object.defineProperties(text, { clientWidth: { value: 80 }, clientHeight: { value: 20 },
      scrollWidth: { value: 80 }, scrollHeight: { get: () => contentHeight } });
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fillText: vi.fn(), measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D;
    expect(() => paintTranslationLayer(context, layer)).toThrow();
    expect(text.getAttribute("aria-invalid")).toBe("true");
    contentHeight = 20;
    expect(() => paintTranslationLayer(context, layer)).not.toThrow();
    expect(block.hasAttribute("data-layout-overflow")).toBe(false);
    expect(text.hasAttribute("aria-invalid")).toBe(false);
  });

  it("converts minimum-font-safe text coordinates back to PDF canvas coordinates", () => {
    const layer = document.createElement("div");
    layer.dataset.coordinateScale = "12";
    layer.innerHTML = '<div class="translation-block" style="left:120px;top:240px;width:1200px;height:480px"><div class="translation-block-text" style="font-size:240px;line-height:288px">文字</div></div>';
    const context = {
      save: vi.fn(), restore: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fillText: vi.fn(), measureText: () => ({ width: 240 })
    } as unknown as CanvasRenderingContext2D;
    paintTranslationLayer(context, layer);
    expect(context.scale).toHaveBeenCalledWith(1 / 12, 1 / 12);
    expect(context.font).toBe("400 240px sans-serif");
    expect(context.rect).toHaveBeenCalledWith(120, 240, 1200, 480);
  });
  it("exports the font size chosen with the toolbar, not its initial size", () => {
    const layer = document.createElement("div");
    const block = createEditableTranslationBlock(layer, {
      id: "font-export", text: "人工调大字号", color: "#222", fontFamily: "Arial", fontSize: 20,
      fontSizeStep: 2, fontWeight: 400, lineHeight: 24, left: 10, top: 20, width: 300, height: 80
    });
    layer.append(block);
    block.querySelector<HTMLButtonElement>('[aria-label="增大字号"]')!.click();
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(),
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D;
    paintTranslationLayer(context, layer);
    expect(context.font).toBe("400 22px Arial");
    expect(context.fillText).toHaveBeenCalledWith("人工调大字号", 10, expect.any(Number));
  });
  it("uses browser line positions for ordinary prose, matching the editable preview", () => {
    const layer = document.createElement("div");
    layer.style.width = "100px";
    layer.innerHTML = '<div class="translation-block" style="left: 20px; top: 30px; width: 80px; height: 50px"><div class="translation-block-text" style="font-size: 12px">ab cd</div></div>';
    const text = layer.querySelector<HTMLElement>(".translation-block-text")!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100 } as DOMRect);
    vi.spyOn(text, "getBoundingClientRect").mockReturnValue({ width: 80 } as DOMRect);
    let offset = 0;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart: (_node: Node, index: number) => { offset = index; }, setEnd: vi.fn(),
      getBoundingClientRect: () => ({ left: 20 + (offset < 3 ? offset : offset - 3) * 8, bottom: offset < 3 ? 44 : 60, width: offset === 2 ? 0 : 8 })
    } as unknown as Range);
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(),
      measureText: () => ({ width: 8, fontBoundingBoxDescent: 3 })
    } as unknown as CanvasRenderingContext2D;
    paintTranslationLayer(context, layer);
    expect(context.fillText).toHaveBeenCalledWith("a", 20, 41);
    expect(context.fillText).toHaveBeenCalledWith("c", 20, 57);
    expect(context.fillText).toHaveBeenCalledWith("d", 28, 57);
    vi.restoreAllMocks();
  });

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
