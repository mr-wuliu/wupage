import { t } from "../shared/i18n";
import { OPS, type PDFPageProxy } from "pdfjs-dist";

export async function renderPageWithoutText(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: ReturnType<PDFPageProxy["getViewport"]>
): Promise<void> {
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;

  // Type 3 and fallback fonts paint vector paths instead of calling fillText.
  // Filter PDF text-show operations so these glyphs cannot remain underneath
  // the translation, while retaining image and ordinary drawing operations.
  const textOperators = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  let task: ReturnType<PDFPageProxy["render"]> | undefined;
  task = page.render({
    canvas: null, canvasContext: context, viewport,
    operationsFilter: (index) => {
      // getOperatorList() is unoptimized, whereas render() merges drawing
      // operations. Their indices diverge on dense diagrams. Read the current
      // render task's own list; never apply indices from the other list.
      const internal = task?._internalRenderTask as { operatorList?: { fnArray: number[] } } | null | undefined;
      const operators = internal?.operatorList?.fnArray;
      if (!operators) throw new Error(t("incompatiblePdfRenderingInterfaceCannotSafelyRemoveThe"));
      return !textOperators.has(operators[index]);
    }
  });
  await task.promise;
}
