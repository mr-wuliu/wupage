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
  textAlign: "left" | "center";
  hangingIndent: number;
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

export function findAvailableVerticalBottom(
  rectangleGroups: ReadonlyArray<ReadonlyArray<PdfLayoutRectangle>>,
  blockIndex: number,
  pageHeight: number
): number {
  const current = getBounds(rectangleGroups[blockIndex] ?? []);
  if (!current) return pageHeight;
  let bottom = pageHeight;
  rectangleGroups.forEach((rectangles, index) => {
    if (index === blockIndex) return;
    for (const rect of rectangles) {
      if (rect.y > current.top + 0.5 && rect.x < current.right && rect.x + rect.width > current.left) {
        bottom = Math.min(bottom, rect.y - 2);
      }
    }
  });
  return Math.max(current.bottom, bottom);
}

export function findAvailableHorizontalLeft(
  rectangleGroups: ReadonlyArray<ReadonlyArray<PdfLayoutRectangle>>,
  blockIndex: number
): number {
  const current = getBounds(rectangleGroups[blockIndex] ?? []);
  if (!current) return 0;
  let left = 0;
  rectangleGroups.forEach((rectangles, index) => {
    if (index === blockIndex) return;
    for (const rect of rectangles) {
      if (rect.x + rect.width >= current.right - 0.5) continue;
      const overlap = Math.min(current.bottom, rect.y + rect.height) - Math.max(current.top, rect.y);
      if (overlap > Math.min(current.height, rect.height) * 0.2) left = Math.max(left, rect.x + rect.width + 2);
    }
  });
  return Math.min(current.left, left);
}

export function getTranslatedBlockLayout(
  context: TextMeasureContext,
  text: string,
  block: PdfTextBlock,
  rectangles: ReadonlyArray<PdfLayoutRectangle>,
  scale: number,
  availableRight?: number,
  pageWidth?: number,
  availableLeft = 0
): TranslatedBlockLayout | undefined {
  const bounds = getBounds(rectangles);
  if (!bounds || !text.trim()) return undefined;
  const originalWidth = Math.max(4, bounds.width);
  const height = Math.max(4, bounds.height);
  const preferredSize = Math.max(1, block.fontSize * scale * 0.98);
  const family = normalizeCanvasFontFamily(block.fontFamily);
  const measure = (value: string): number => value.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu).reduce((width, part) => {
    if (/^⟪WUPAGE(?:OPEN|CLOSE)\d+⟫$/u.test(part)) return width;
    const formula = block.formulas?.find((entry) => entry.placeholder === part);
    const size = Number(/([\d.]+)px/u.exec(context.font)?.[1]) || preferredSize;
    return width + (formula ? formula.width / formula.fontSize * size : context.measureText(part).width);
  }, 0);
  context.font = `${block.fontWeight} ${preferredSize}px ${family}`;

  const preferredTextWidth = block.lines.length === 1
    ? measure(text.trim()) + preferredSize * 0.25
    : originalWidth;
  const horizontalLimit = Math.max(bounds.right, availableRight ?? bounds.right);
  let width = Math.max(4, Math.min(Math.max(originalWidth, preferredTextWidth), horizontalLimit - bounds.left));

  const ascent = Math.max(0.9, ...(block.formulas ?? []).map((formula) =>
    (formula.y + formula.height - formula.baselineY) / formula.fontSize));
  const descent = Math.max(0.24, ...(block.formulas ?? []).map((formula) =>
    (formula.baselineY - formula.y) / formula.fontSize));
  const gaps = block.lines.slice(1).map((line, index) =>
    Math.abs(block.lines[index].baselineY - line.baselineY) / block.fontSize).filter((gap) => gap > 0);
  const sourceLeading = gaps.length ? Math.min(1.6, Math.min(...gaps)) : 1.14;
  // Start each block at the source size. The browser performs the final fit
  // using the actual CJK fallback font and inline images, not an approximate
  // second line-breaking implementation that can shrink it prematurely.
  const lineHeight = preferredSize * Math.max(sourceLeading, ascent + descent);
  const listItem = /^[•●▪◦·‣⁃]\s/u.test(block.text);
  const centered = Boolean(pageWidth && block.lines.length === 1 && !listItem && !block.tocPart && bounds.width < pageWidth * 0.75
    && Math.abs(bounds.left + bounds.right - pageWidth) < block.fontSize * scale);
  const center = (bounds.left + bounds.right) / 2;
  if (centered) width = Math.min(width, 2 * Math.min(center - availableLeft, horizontalLimit - center));

  return {
    left: centered ? center - width / 2 : bounds.left,
    top: bounds.top,
    width,
    height,
    fontFamily: family,
    fontSize: preferredSize,
    lineHeight,
    textAlign: centered ? "center" : "left",
    hangingIndent: listItem ? Math.max(block.fontSize, (block.lines[1]?.x ?? block.lines[0].x) - block.lines[0].x) * scale : 0
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

function normalizeCanvasFontFamily(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "Arial, sans-serif";
  return normalized.includes(",") || /^(serif|sans-serif|monospace)$/u.test(normalized)
    ? normalized
    : `"${normalized.replace(/["\\]/gu, "")}", Arial, sans-serif`;
}
