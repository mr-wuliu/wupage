import { t } from "../shared/i18n";
import { OPS, type PDFPageProxy } from "pdfjs-dist";
import { isRotatedPdfText } from "./model";

interface RenderOperatorList {
  fnArray: number[];
  argsArray?: unknown[][];
}

type Matrix = number[];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** Keep angled original glyphs without copying any surrounding prose pixels. */
export function rotatedTextFilter(viewport: ArrayLike<number>): (operation: number, args: unknown[]) => boolean {
  let state = { matrix: identity(), text: identity(), direction: 1 };
  const saved: typeof state[] = [];
  const textOps = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const paintingOps = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.shadingFill, OPS.rawFillPath,
    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageXObject,
    OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask
  ]);
  return (operation, args) => {
    if (operation === OPS.save || operation === OPS.paintFormXObjectBegin) {
      saved.push({ ...state });
      if (operation === OPS.paintFormXObjectBegin && args[0]) state.matrix = multiply(state.matrix, Array.from(args[0] as ArrayLike<number>));
    } else if (operation === OPS.restore || operation === OPS.paintFormXObjectEnd) state = saved.pop() ?? state;
    else if (operation === OPS.transform) state.matrix = multiply(state.matrix, args as number[]);
    else if (operation === OPS.beginText) state.text = identity();
    else if (operation === OPS.setTextMatrix) state.text = args.length === 1
      ? Array.from(args[0] as ArrayLike<number>) : args as number[];
    else if (operation === OPS.setFont) state.direction = Number(args[1]) < 0 ? -1 : 1;
    if (textOps.has(operation)) {
      const matrix = multiply(Array.from(viewport), multiply(state.matrix, state.text));
      const a = matrix[0] * state.direction, b = matrix[1] * state.direction;
      return isRotatedPdfText([a, b]);
    }
    // Path construction may include its paint operation in optimized lists.
    // Retain clipping paths, whose final operation consumes rather than paints.
    if (operation === OPS.constructPath) return args[0] === OPS.endPath;
    return !paintingOps.has(operation);
  };
}

export async function renderRotatedPdfText(
  page: PDFPageProxy, canvas: HTMLCanvasElement, viewport: ReturnType<PDFPageProxy["getViewport"]>
): Promise<void> {
  canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return;
  const filter = rotatedTextFilter(viewport.transform);
  let task: ReturnType<PDFPageProxy["render"]> | undefined;
  task = page.render({ canvas: null, canvasContext: context, viewport, background: "rgba(0,0,0,0)",
    operationsFilter: index => {
      const operators = (task?._internalRenderTask as { operatorList?: RenderOperatorList } | null | undefined)?.operatorList;
      if (!operators) throw new Error(t("incompatiblePdfRenderingInterfaceCannotSafelyRemoveThe"));
      return filter(operators.fnArray[index], operators.argsArray?.[index] ?? []);
    }
  });
  await task.promise;
}

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
