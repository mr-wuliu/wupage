// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditableTranslationBlock } from "../src/pdf/editor";
import { collectPdfExportScene, paintTranslationLayer } from "../src/pdf/export";
import { getFormulaViewportRect, readFormulaText } from "../src/pdf/math-rendering";
import type { PdfFormula } from "../src/pdf/math";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("PDF inline formula rendering", () => {
  it("exports isolated rotated glyphs without copying the source prose in their bounding boxes", async () => {
    const original = document.createElement("canvas"), background = document.createElement("canvas");
    original.width = background.width = 600; original.height = background.height = 800;
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      callback(new Blob([new Uint8Array([this === background ? 1 : 2])]));
    });
    const scene = await collectPdfExportScene(original, document.createElement("div"), [
      { id: "watermark", text: "REVIEW COPY", translatable: false, preserveOriginal: true, backgroundText: true,
        lines: [{ text: "REVIEW COPY", x: 100, baselineY: 200, width: 350, height: 300 }], fontSize: 44, fontFamily: "serif", fontWeight: 400 }
    ], 600, 800, [1, 0, 0, -1, 0, 800], background);
    expect(drawImage).not.toHaveBeenCalled();
    expect(encode).toHaveBeenCalledOnce();
    expect(scene.images).toHaveLength(1);
    expect(scene.images[0]).toMatchObject({ x: 0, y: 0, width: 600, height: 800 });
    expect(Array.from(scene.images[0].bytes)).toEqual([1]);
  });
  it("keeps a translated bold lead-in editable and preserves its weight in both exports", async () => {
    const layer = document.createElement("div"); layer.style.width = "400px";
    const source = "⟪WUPAGEOPEN0⟫标题。⟪WUPAGECLOSE0⟫正文。";
    const block = createEditableTranslationBlock(layer, {
      id: "emphasis", text: source, fontSize: 20, fontFamily: "Arial", fontWeight: 400,
      color: "#222", lineHeight: 24, left: 10, top: 20, width: 300, height: 80
    });
    layer.append(block); document.body.append(layer);
    const editor = block.querySelector<HTMLElement>(".translation-block-text")!;
    expect(editor.textContent).toBe("标题。正文。");
    expect(editor.querySelector("strong")!.textContent).toBe("标题。");
    expect(readFormulaText(editor)).toBe(source);
    editor.querySelector("strong")!.firstChild!.textContent = "修订。";
    expect(readFormulaText(editor)).toBe("⟪WUPAGEOPEN0⟫修订。⟪WUPAGECLOSE0⟫正文。");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400));
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 300, 80));
    vi.spyOn(document, "createRange").mockReturnValue({ setStart: vi.fn(), setEnd: vi.fn(),
      getBoundingClientRect: () => new DOMRect(10, 20, 20, 24) } as unknown as Range);
    const painted: Array<{ text: string; font: string }> = [];
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      font: "", fillText: (text: string) => painted.push({ text, font: context.font }),
      measureText: () => ({ width: 20, fontBoundingBoxDescent: 4 }) } as unknown as CanvasRenderingContext2D;
    paintTranslationLayer(context, layer);
    expect(painted.find(run => run.text === "修")!.font).toBe("700 20px Arial");
    expect(painted.find(run => run.text === "正")!.font).toBe("400 20px Arial");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const original = document.createElement("canvas"); original.width = 400;
    const scene = await collectPdfExportScene(original, layer, [], 400, 400, [1, 0, 0, -1, 0, 400]);
    expect(scene.text.find(run => run.text === "修")!.bold).toBe(true);
    expect(scene.text.find(run => run.text === "正")!.bold).toBe(false);
  });

  it("includes both fractional pixel edges when cropping formula glyphs and vector bars", () => {
    const rect = getFormulaViewportRect({
      placeholder: "⟪WUPAGE0⟫", text: "x", x: 10.4, y: 20.4, width: 10.2, height: 5.2,
      baselineY: 21, fontSize: 10, display: false
    }, { convertToViewportPoint: (x, y) => [x * 2, 200 - y * 2] });
    expect(rect).toEqual({ x: 20, y: 148, width: 22, height: 12 });
  });
  it("keeps formulas as non-editable images while serializing surrounding text edits", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const layer = document.createElement("div");
    const onTextChange = vi.fn();
    const formula: PdfFormula = {
      placeholder: "⟪WUPAGE0⟫", text: "ρτ(μ)", x: 10, y: 88, width: 30, height: 12,
      baselineY: 91, fontSize: 10, display: false
    };
    const block = createEditableTranslationBlock(layer, {
      id: "math", text: "其中 ⟪WUPAGE0⟫ 为损失函数", fontSize: 20, fontFamily: "Arial", fontWeight: 400,
      color: "#222", lineHeight: 24, left: 10, top: 20, width: 300, height: 80,
      formulaImages: [{ formula, canvas: document.createElement("canvas") }], onTextChange
    });
    const editor = block.querySelector<HTMLElement>(".translation-block-text")!;
    const image = editor.querySelector<HTMLCanvasElement>(".pdf-inline-formula")!;
    expect(image.contentEditable).toBe("false");
    expect(image.style.width).toBe("60px");
    expect(image.style.height).toBe("24px");
    expect(image.style.verticalAlign).toBe("-6px");
    expect(editor.textContent).not.toContain("WUPAGE");
    editor.firstChild!.textContent = "修订后的 ";
    editor.dispatchEvent(new Event("input"));
    expect(onTextChange).toHaveBeenCalledWith("修订后的 ⟪WUPAGE0⟫ 为损失函数");
    expect(readFormulaText(editor)).toContain("⟪WUPAGE0⟫");
  });

  it("exports inline images and text using browser positions and an alphabetic baseline before measuring", () => {
    const layer = document.createElement("div");
    layer.style.width = "400px";
    layer.innerHTML = '<div class="translation-block" style="left:10px;top:20px;width:300px;height:80px"><div class="translation-block-text" style="font-size:20px;line-height:24px">其中 <canvas class="pdf-inline-formula" data-formula-token="⟪WUPAGE0⟫"></canvas></div></div>';
    document.body.append(layer);
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 200, 200));
    const image = layer.querySelector("canvas")!;
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 220, 30, 12));
    const range = { setStart: vi.fn(), setEnd: vi.fn(), getBoundingClientRect: () => new DOMRect(110, 212, 10, 12) };
    vi.spyOn(document, "createRange").mockReturnValue(range as unknown as Range);
    const fillText = vi.fn();
    const drawImage = vi.fn();
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fillText, drawImage, textBaseline: "top",
      measureText: vi.fn(() => {
        expect(context.textBaseline).toBe("alphabetic");
        return { fontBoundingBoxDescent: 4, width: 20 };
      })
    } as unknown as CanvasRenderingContext2D;
    paintTranslationLayer(context, layer);
    expect(drawImage).toHaveBeenCalledWith(image, 60, 40, 60, 24);
    expect(fillText).toHaveBeenCalledWith("其", 20, 44);
    expect(fillText).toHaveBeenCalledWith("中", 20, 44);
  });
});
