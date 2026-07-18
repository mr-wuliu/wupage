import type { PdfTextBlock } from "./model";

export interface PdfLayoutRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TranslatedBlockLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

interface TextMeasureContext {
  font: string;
  measureText(text: string): { width: number };
}

export function findAvailableHorizontalRight(
  rectangleGroups: ReadonlyArray<ReadonlyArray<PdfLayoutRectangle>>,
  blockIndex: number,
  pageWidth: number
): number {
  const current = getBounds(rectangleGroups[blockIndex] ?? []);
  if (!current) return pageWidth;
  let availableRight = pageWidth;

  rectangleGroups.forEach((rectangles, index) => {
    if (index === blockIndex) return;
    for (const rectangle of rectangles) {
      if (rectangle.x <= current.left + 0.5) continue;
      const overlap = Math.min(current.bottom, rectangle.y + rectangle.height)
        - Math.max(current.top, rectangle.y);
      const overlapThreshold = Math.min(current.height, rectangle.height) * 0.2;
      if (overlap <= overlapThreshold) continue;
      availableRight = Math.min(availableRight, rectangle.x - 2);
    }
  });

  return Math.max(current.right, availableRight);
}

export function getTranslatedBlockLayout(
  context: TextMeasureContext,
  text: string,
  block: PdfTextBlock,
  rectangles: ReadonlyArray<PdfLayoutRectangle>,
  scale: number,
  availableRight?: number
): TranslatedBlockLayout | undefined {
  const bounds = getBounds(rectangles);
  if (!bounds || !text.trim()) return undefined;
  const originalWidth = Math.max(4, bounds.width);
  const height = Math.max(4, bounds.height);
  const preferredSize = Math.max(6, block.fontSize * scale * 0.94);
  const minimumSize = Math.max(5, preferredSize * 0.46);
  const family = normalizeCanvasFontFamily(block.fontFamily);
  context.font = `${block.fontWeight} ${preferredSize}px ${family}`;

  const preferredTextWidth = block.lines.length === 1
    ? context.measureText(text.trim()).width + preferredSize * 0.25
    : originalWidth;
  const horizontalLimit = Math.max(bounds.right, availableRight ?? bounds.right);
  const width = Math.max(4, Math.min(Math.max(originalWidth, preferredTextWidth), horizontalLimit - bounds.left));

  let fontSize = preferredSize;
  let lines: string[] = [];
  let lineHeight = fontSize * 1.22;
  while (fontSize >= minimumSize) {
    context.font = `${block.fontWeight} ${fontSize}px ${family}`;
    lines = wrapCanvasText(context, text.trim(), width);
    lineHeight = fontSize * 1.22;
    if (lines.length * lineHeight <= height + fontSize * 0.38) break;
    fontSize -= Math.max(0.5, preferredSize * 0.045);
  }

  return {
    left: bounds.left,
    top: bounds.top,
    width,
    height,
    fontFamily: family,
    fontSize,
    lineHeight
  };
}

function getBounds(rectangles: ReadonlyArray<PdfLayoutRectangle>): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} | undefined {
  if (!rectangles.length) return undefined;
  const left = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const top = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.width));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function wrapCanvasText(
  context: TextMeasureContext,
  text: string,
  maxWidth: number
): string[] {
  const characters = Array.from(text);
  const lines: string[] = [];
  let current = "";
  for (const character of characters) {
    if (character === "\n") {
      if (current.trim()) lines.push(current.trimEnd());
      current = "";
      continue;
    }
    const candidate = `${current}${character}`;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current.trimEnd());
      current = character.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim() || !lines.length) lines.push(current.trim());
  return lines;
}

function normalizeCanvasFontFamily(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "Arial, sans-serif";
  return normalized.includes(",") || /^(serif|sans-serif|monospace)$/u.test(normalized)
    ? normalized
    : `"${normalized.replace(/["\\]/gu, "")}", Arial, sans-serif`;
}
