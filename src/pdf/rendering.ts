import type { PDFPageProxy } from "pdfjs-dist";

export async function renderPageWithoutText(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: ReturnType<PDFPageProxy["getViewport"]>
): Promise<void> {
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;

  // PDF.js paints glyphs through these two Canvas APIs. Suppressing them keeps
  // images, vector graphics and page backgrounds intact without drawing the
  // source-language text.
  const fillText = context.fillText;
  const strokeText = context.strokeText;
  context.fillText = () => undefined;
  context.strokeText = () => undefined;
  try {
    await page.render({ canvas: null, canvasContext: context, viewport }).promise;
  } finally {
    context.fillText = fillText;
    context.strokeText = strokeText;
  }
}
