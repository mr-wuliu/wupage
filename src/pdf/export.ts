import { t } from "../shared/i18n";
import { paintFormulaText } from "./math-rendering";
import type { PdfTextBlock } from "./model";
import type { PdfExportScene, PdfExportText } from "./vector-export";

export interface RasterPdfPage {
  width: number;
  height: number;
  imageBytes: Uint8Array;
  format: "jpeg" | "png";
  scene?: PdfExportScene;
}

export async function buildRasterPdf(
  pages: RasterPdfPage[],
  title: string,
  sourceBytes?: Uint8Array,
  fontBytes?: Uint8Array
): Promise<Uint8Array> {
  if (!pages.length) throw new Error(t("noPdfPagesToExport"));
  if (fontBytes && pages.some((page) => page.scene)) {
    const { buildSearchablePdf } = await import("./vector-export");
    return buildSearchablePdf(pages, title, sourceBytes, fontBytes);
  }
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.setCreator("WuPage");
  document.setProducer("WuPage PDF Translator");

  for (const source of pages) {
    const image = source.format === "png"
      ? await document.embedPng(source.imageBytes)
      : await document.embedJpg(source.imageBytes);
    const page = document.addPage([source.width, source.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: source.width,
      height: source.height
    });
  }

  return document.save({ useObjectStreams: true });
}

export async function collectPdfExportScene(original: HTMLCanvasElement, layer: HTMLElement,
  blocks: PdfTextBlock[], width: number, height: number, transform: number[]): Promise<PdfExportScene> {
  const scene: PdfExportScene = { text: [], images: [], transform, unchanged: blocks.every((block) => !block.translatable) };
  const pixelScale = original.width / width;
  const measure = document.createElement("canvas").getContext("2d");
  const image = async (canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): Promise<void> => {
    if (w <= 0 || h <= 0) return;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t("couldNotEncodeThePreservedPdfContent"))), "image/png"));
    scene.images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), x, y, width: w, height: h });
  };
  for (const block of blocks.filter((block) => !block.translatable)) for (const line of block.lines) {
    const left = Math.max(0, Math.floor(line.x * pixelScale));
    const top = Math.max(0, Math.floor((height - line.baselineY - line.height * 0.9) * pixelScale));
    const right = Math.min(original.width, Math.ceil((line.x + line.width) * pixelScale));
    const bottom = Math.min(original.height, Math.ceil((height - line.baselineY + line.height * 0.24) * pixelScale));
    if (right <= left || bottom <= top) continue;
    const crop = document.createElement("canvas");
    crop.width = right - left; crop.height = bottom - top;
    crop.getContext("2d")?.drawImage(original, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    await image(crop, left / pixelScale, top / pixelScale, crop.width / pixelScale, crop.height / pixelScale);
    scene.text.push({ text: line.text.replace(/⟪WUPAGE\d+⟫/gu, (marker) => block.formulas?.find((formula) => formula.placeholder === marker)?.text ?? ""),
      x: line.x, y: height - line.baselineY, width: line.width, size: line.height, color: [0, 0, 0], invisible: true });
  }
  const layerBounds = layer.getBoundingClientRect();
  const coordinateScale = Number(layer.dataset.coordinateScale) || 1;
  const cssScale = layerBounds.width / (Number.parseFloat(layer.style.width) || layerBounds.width) || 1;
  const toPdf = 1 / (cssScale * coordinateScale * pixelScale);
  for (const block of layer.querySelectorAll<HTMLElement>(".translation-block")) {
    const element = block.querySelector<HTMLElement>(".translation-block-text");
    if (!element) continue;
    if (block.dataset.layoutOverflow) throw new Error(t("someTranslatedTextDoesNotFitAtA"));
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
    const fontSize = Number.parseFloat(element.style.fontSize);
    if (measure) measure.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
    const color = (style.color.match(/[\d.]+/gu)?.slice(0, 3).map((channel) => Number(channel) / 255) ?? [0, 0, 0]) as [number, number, number];
    const point = (rect: DOMRect) => ({ x: (rect.left - layerBounds.left + element.scrollLeft * cssScale) * toPdf,
      y: (rect.bottom - layerBounds.top + element.scrollTop * cssScale) * toPdf });
    const read = async (node: Node): Promise<void> => {
      if (node instanceof HTMLCanvasElement && node.dataset.formulaToken) {
        const rect = node.getBoundingClientRect(), position = point(rect);
        await image(node, position.x, position.y - rect.height * toPdf, rect.width * toPdf, rect.height * toPdf);
        scene.text.push({ text: node.getAttribute("aria-label") ?? "", x: position.x, y: position.y,
          width: rect.width * toPdf, size: fontSize / coordinateScale / pixelScale, color, invisible: true });
      } else if (node.nodeType === Node.TEXT_NODE) {
        const runStyle = getComputedStyle(node.parentElement ?? element);
        const runSize = Number.parseFloat(runStyle.fontSize) || fontSize;
        const runWeight = runStyle.fontWeight || style.fontWeight;
        if (measure) measure.font = `${runWeight} ${runSize}px ${runStyle.fontFamily || style.fontFamily}`;
        const range = document.createRange();
        let offset = 0;
        for (const character of node.textContent ?? "") {
          range.setStart(node, offset); offset += character.length; range.setEnd(node, offset);
          const rect = range.getBoundingClientRect();
          if (!rect.width || rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
          const position = point(rect), descent = measure?.measureText(character).fontBoundingBoxDescent || 0;
          const run: PdfExportText = { text: character, x: position.x, y: position.y - descent / coordinateScale / pixelScale,
            width: rect.width * toPdf, size: runSize / coordinateScale / pixelScale, color, bold: Number(runWeight) >= 600 };
          scene.text.push(run);
        }
      } else for (const child of node.childNodes) await read(child);
    };
    await read(element);
  }
  return scene;
}

export function composeTranslatedPageCanvas(
  baseCanvas: HTMLCanvasElement,
  translationLayer: HTMLElement
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = baseCanvas.width;
  canvas.height = baseCanvas.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error(t("theBrowserCouldNotCreateThePdfExport"));
  context.drawImage(baseCanvas, 0, 0);
  paintTranslationLayer(context, translationLayer);
  return canvas;
}

export function paintTranslationLayer(
  context: CanvasRenderingContext2D,
  translationLayer: HTMLElement
): void {
  const coordinateScale = Number(translationLayer.dataset.coordinateScale) || 1;
  if (coordinateScale !== 1) {
    context.save();
    context.scale(1 / coordinateScale, 1 / coordinateScale);
  }
  translationLayer.querySelectorAll<HTMLElement>(".translation-block").forEach((block) => {
    const textElement = block.querySelector<HTMLElement>(".translation-block-text");
    const text = textElement?.textContent ?? "";
    if (!textElement || (!text.trim() && !textElement.querySelector(".pdf-inline-formula"))) return;

    const left = numericStyle(block.style.left);
    const top = numericStyle(block.style.top);
    const width = numericStyle(block.style.width);
    const height = numericStyle(block.style.height);
    const fontSize = numericStyle(textElement.style.fontSize) || 12;
    const lineHeight = numericStyle(textElement.style.lineHeight) || fontSize * 1.2;
    const fontWeight = textElement.style.fontWeight || "400";
    const fontFamily = textElement.style.fontFamily || "sans-serif";
    if (width <= 0 || height <= 0) return;

    context.save();
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
    context.fillStyle = textElement.style.color || "#202826";
    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    context.textBaseline = "top";
    if (textElement.getBoundingClientRect().width > 0 || textElement.querySelector(".pdf-inline-formula")) {
      paintFormulaText(context, translationLayer, textElement);
      context.restore();
      return;
    }
    const lines = wrapCanvasText(context, text, width);
    const maximumLines = Math.max(1, Math.ceil(height / lineHeight));
    const textOffset = Math.max(0, (lineHeight - fontSize) / 2);
    lines.slice(0, maximumLines).forEach((line, index) => {
      context.fillText(line, left, top + textOffset + index * lineHeight);
    });
    context.restore();
  });
  if (coordinateScale !== 1) context.restore();
}

export function wrapCanvasText(
  context: Pick<CanvasRenderingContext2D, "measureText">,
  text: string,
  maximumWidth: number
): string[] {
  if (maximumWidth <= 0) return [];
  const output: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    let line = "";
    for (const character of paragraph) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maximumWidth) {
        output.push(line.trimEnd());
        line = /^\s$/u.test(character) ? "" : character;
      } else {
        line = candidate;
      }
    }
    output.push(line.trimEnd());
  }
  return output;
}

export async function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
  quality = 0.94
): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error(t("couldNotEncodeThePdfPageImage")));
    }, "image/jpeg", quality);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function translatedPdfFileName(sourceName: string): string {
  const base = sourceName
    .replace(/\.pdf$/iu, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .trim();
  return `${base || "document"}-translated.pdf`;
}

export function downloadPdfBytes(bytes: Uint8Array, fileName: string): void {
  const data = bytes.slice().buffer as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function numericStyle(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
