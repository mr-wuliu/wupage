export interface RasterPdfPage {
  width: number;
  height: number;
  imageBytes: Uint8Array;
  format: "jpeg" | "png";
}

export async function buildRasterPdf(
  pages: RasterPdfPage[],
  title: string
): Promise<Uint8Array> {
  if (!pages.length) throw new Error("没有可导出的 PDF 页面。");
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

export function composeTranslatedPageCanvas(
  baseCanvas: HTMLCanvasElement,
  translationLayer: HTMLElement
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = baseCanvas.width;
  canvas.height = baseCanvas.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建 PDF 导出画布。");
  context.drawImage(baseCanvas, 0, 0);
  paintTranslationLayer(context, translationLayer);
  return canvas;
}

export function paintTranslationLayer(
  context: CanvasRenderingContext2D,
  translationLayer: HTMLElement
): void {
  translationLayer.querySelectorAll<HTMLElement>(".translation-block").forEach((block) => {
    const textElement = block.querySelector<HTMLElement>(".translation-block-text");
    const text = textElement?.textContent ?? "";
    if (!textElement || !text.trim()) return;

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
    const lines = wrapCanvasText(context, text, width);
    const maximumLines = Math.max(1, Math.ceil(height / lineHeight));
    const textOffset = Math.max(0, (lineHeight - fontSize) / 2);
    lines.slice(0, maximumLines).forEach((line, index) => {
      context.fillText(line, left, top + textOffset + index * lineHeight);
    });
    context.restore();
  });
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
      else reject(new Error("无法编码 PDF 页面图像。"));
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
