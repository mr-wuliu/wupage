import type { OcrLine } from "../shared/ocr";
import type { ImageTextRegion } from "../shared/types";

export function needsImageTranslation(text: string): boolean {
  const value = text.trim();
  if (!value || !/\p{L}/u.test(value)) return false;
  // Keep chart values, percentages, multipliers and abbreviated counts untouched.
  if (/^[+−-]?[\d\s.,]+\s*(?:%|‰|[kmbt]|[x×]|[kmgt]?b)?$/i.test(value)) return false;
  return true;
}

export function positionedLines(lines: OcrLine[], width: number, height: number): ImageTextRegion[] {
  return lines.flatMap((line) => {
    if (line.score < 0.6 || !needsImageTranslation(line.text) || line.poly.length !== 4
      || line.poly.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)))) return [];
    const xs = line.poly.map(([x]) => x), ys = line.poly.map(([, y]) => y);
    const left = Math.max(0, Math.min(...xs) - 1), top = Math.max(0, Math.min(...ys) - 1);
    const right = Math.min(width, Math.max(...xs) + 1), bottom = Math.min(height, Math.max(...ys) + 1);
    if (right <= left || bottom <= top) return [];
    return [{ box: [left / width * 1000, top / height * 1000, (right - left) / width * 1000, (bottom - top) / height * 1000] as ImageTextRegion["box"],
      text: line.text, translation: line.text, foreground: "#111111", background: "#ffffff", align: "left" as const, bold: false,
      sampleColors: true }];
  });
}
