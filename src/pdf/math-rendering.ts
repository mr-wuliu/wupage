import type { PdfFormula } from "./math";

export interface PdfFormulaImage {
  formula: PdfFormula;
  canvas: HTMLCanvasElement;
}

export function getFormulaViewportRect(formula: PdfFormula, viewport: { convertToViewportPoint(x: number, y: number): number[] }): {
  x: number; y: number; width: number; height: number;
} {
  const start = viewport.convertToViewportPoint(formula.x, formula.y);
  const end = viewport.convertToViewportPoint(formula.x + formula.width, formula.y + formula.height);
  const x = Math.max(0, Math.floor(Math.min(start[0], end[0])));
  const y = Math.max(0, Math.floor(Math.min(start[1], end[1])));
  return { x, y, width: Math.max(1, Math.ceil(Math.max(start[0], end[0])) - x), height: Math.max(1, Math.ceil(Math.max(start[1], end[1])) - y) };
}

export function createFormulaImages(
  formulas: ReadonlyArray<PdfFormula>,
  original: HTMLCanvasElement,
  viewport: { convertToViewportPoint(x: number, y: number): number[] }
): PdfFormulaImage[] {
  return formulas.map((formula) => {
    const { x, y, width, height } = getFormulaViewportRect(formula, viewport);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(original, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return { formula, canvas };
  });
}

export function renderFormulaText(element: HTMLElement, text: string, images: ReadonlyArray<PdfFormulaImage>, fontSize: number): void {
  const byToken = new Map(images.map((image) => [image.formula.placeholder, image]));
  const parents = [element];
  for (const part of text.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu)) {
    const format = /^⟪WUPAGE(OPEN|CLOSE)(\d+)⟫$/u.exec(part);
    if (format) {
      if (format[1] === "OPEN") {
        const strong = document.createElement("strong");
        strong.dataset.pdfFormatId = format[2];
        strong.style.fontWeight = "700";
        parents.at(-1)!.append(strong);
        parents.push(strong);
      } else if (parents.length > 1 && parents.at(-1)!.dataset.pdfFormatId === format[2]) parents.pop();
      continue;
    }
    const image = byToken.get(part);
    if (!image) {
      parents.at(-1)!.append(document.createTextNode(part));
      continue;
    }
    const { formula } = image;
    const canvas = document.createElement("canvas");
    canvas.width = image.canvas.width;
    canvas.height = image.canvas.height;
    canvas.getContext("2d")?.drawImage(image.canvas, 0, 0);
    canvas.className = "pdf-inline-formula";
    canvas.dataset.formulaToken = part;
    canvas.contentEditable = "false";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", formula.text);
    canvas.style.width = `${formula.width / formula.fontSize * fontSize}px`;
    canvas.style.height = `${formula.height / formula.fontSize * fontSize}px`;
    canvas.style.verticalAlign = `${-(formula.baselineY - formula.y) / formula.fontSize * fontSize}px`;
    parents.at(-1)!.append(canvas);
  }
}

export function readFormulaText(element: Node): string {
  if (element instanceof HTMLElement && element.dataset.formulaToken) return element.dataset.formulaToken;
  if (element instanceof HTMLElement && element.dataset.pdfFormatId !== undefined) {
    const id = element.dataset.pdfFormatId;
    return `⟪WUPAGEOPEN${id}⟫${Array.from(element.childNodes, readFormulaText).join("")}⟪WUPAGECLOSE${id}⟫`;
  }
  if (element.nodeType === Node.TEXT_NODE) return element.textContent ?? "";
  if (element instanceof HTMLBRElement) return "\n";
  return Array.from(element.childNodes, readFormulaText).join("");
}

// Browser line breaking determines where an inline formula lands after the
// surrounding prose is translated/edited. Export that same geometry.
export function paintFormulaText(context: CanvasRenderingContext2D, layer: HTMLElement, element: HTMLElement): void {
  const layerBounds = layer.getBoundingClientRect();
  const scale = layerBounds.width / (Number.parseFloat(layer.style.width) || layerBounds.width) || 1;
  const position = (rect: DOMRect) => ({
    x: (rect.left - layerBounds.left) / scale + element.scrollLeft,
    y: (rect.bottom - layerBounds.top) / scale + element.scrollTop
  });
  const paint = (node: Node): void => {
    if (node instanceof HTMLCanvasElement && node.dataset.formulaToken) {
      const rect = node.getBoundingClientRect();
      const point = position(rect);
      context.drawImage(node, point.x, point.y - rect.height / scale, rect.width / scale, rect.height / scale);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const style = getComputedStyle(node.parentElement ?? element);
      const size = Number.parseFloat(style.fontSize) || Number.parseFloat(element.style.fontSize);
      if (size) context.font = `${style.fontWeight || element.style.fontWeight || "400"} ${size}px ${style.fontFamily || element.style.fontFamily || "sans-serif"}`;
      const range = document.createRange();
      let offset = 0;
      for (const character of node.textContent ?? "") {
        range.setStart(node, offset);
        offset += character.length;
        range.setEnd(node, offset);
        const rect = range.getBoundingClientRect();
        if (!rect.width) continue;
        const point = position(rect);
        context.textBaseline = "alphabetic";
        const descent = context.measureText(character).fontBoundingBoxDescent || 0;
        context.fillText(character, point.x, point.y - descent);
      }
    } else {
      node.childNodes.forEach(paint);
    }
  };
  paint(element);
}
