import type { OcrLine } from "../shared/ocr";

interface LineBounds {
  line: OcrLine;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function bounds(line: OcrLine): LineBounds {
  return { line, left: Math.min(...line.poly.map(([x]) => x)), top: Math.min(...line.poly.map(([, y]) => y)),
    right: Math.max(...line.poly.map(([x]) => x)), bottom: Math.max(...line.poly.map(([, y]) => y)) };
}

export function refineTextStripLines(lines: OcrLine[], pixels: Uint8ClampedArray, width: number, height: number): OcrLine[] {
  // Wide, mostly transparent text strips can contain inline fragments around
  // dashes or punctuation. Do not merge columns of artwork, tables or posters.
  if (!lines.length || width < height * 4 || pixels.length !== width * height * 4
    || lines.some((line) => line.poly.length !== 4 || line.poly.some((point) =>
      point.length !== 2 || point.some((value) => !Number.isFinite(value))))) return lines;
  let clear = 0;
  for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] < 16) clear++;
  if (clear < width * height * 0.5) return lines;
  const groups: LineBounds[] = [];
  for (const candidate of lines.map(bounds).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const h = candidate.bottom - candidate.top;
    const group = groups.find((row) => {
      const rowHeight = row.bottom - row.top;
      const overlap = Math.min(row.bottom, candidate.bottom) - Math.max(row.top, candidate.top);
      const gap = Math.max(candidate.left - row.right, row.left - candidate.right);
      return overlap >= Math.min(h, rowHeight) * 0.7 && Math.min(h, rowHeight) >= Math.max(h, rowHeight) * 0.6
        && gap >= -Math.min(h, rowHeight) * 0.2 && gap <= Math.max(h, rowHeight) * 2.5;
    });
    if (!group) { groups.push({ ...candidate, line: { ...candidate.line } }); continue; }
    group.line.text = candidate.left < group.left
      ? `${candidate.line.text} ${group.line.text}` : `${group.line.text} ${candidate.line.text}`;
    group.line.score = group.line.score === undefined || candidate.line.score === undefined
      ? undefined : Math.min(group.line.score, candidate.line.score);
    group.right = Math.max(group.right, candidate.right);
    group.left = Math.min(group.left, candidate.left);
    group.top = Math.min(group.top, candidate.top);
    group.bottom = Math.max(group.bottom, candidate.bottom);
  }
  return groups.map((group) => {
    const h = group.bottom - group.top;
    let leftLimit = 0, rightLimit = width;
    for (const other of groups) {
      if (other === group || other.bottom <= group.top || other.top >= group.bottom) continue;
      if (other.right <= group.left) leftLimit = Math.max(leftLimit, (other.right + group.left) / 2);
      if (other.left >= group.right) rightLimit = Math.min(rightLimit, (other.left + group.right) / 2);
    }
    const left = Math.max(0, Math.ceil(leftLimit), Math.floor(group.left - h * 0.65));
    const right = Math.min(width, Math.floor(rightLimit), Math.ceil(group.right + h * 0.65));
    const top = Math.max(0, Math.floor(group.top - 3));
    const bottom = Math.min(height, Math.ceil(group.bottom + 3));
    let inkLeft = right, inkRight = left, inkTop = bottom, inkBottom = top;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (pixels[(y * width + x) * 4 + 3] < 16) continue;
        inkLeft = Math.min(inkLeft, x); inkRight = Math.max(inkRight, x + 1);
        inkTop = Math.min(inkTop, y); inkBottom = Math.max(inkBottom, y + 1);
      }
    }
    return { ...group.line, poly: inkRight > inkLeft && inkBottom > inkTop
      ? [[inkLeft, inkTop], [inkRight, inkTop], [inkRight, inkBottom], [inkLeft, inkBottom]]
      : [[group.left, group.top], [group.right, group.top], [group.right, group.bottom], [group.left, group.bottom]] };
  });
}

const comparableText = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function restoreTextFromAlternative(lines: OcrLine[], alternative?: string): OcrLine[] {
  if (!alternative || alternative.length > 12000 || !lines.length) return lines;
  const reference = alternative.normalize("NFKC");
  const fragments = lines.map((line) => comparableText(line.text));
  if (fragments.some((text) => !text)) return lines;
  const recognized = fragments.join("");
  // Only restore punctuation when every letter and digit agrees. Ordinary
  // photo descriptions and conflicting alternatives must never replace OCR.
  if (recognized.length < 10 || recognized !== comparableText(reference)) return lines;
  const characters = Array.from(reference);
  const positions = characters.flatMap((character, index) => /[\p{L}\p{N}]/u.test(character) ? [index] : []);
  let consumed = 0, start = 0;
  return lines.map((line, index) => {
    consumed += Array.from(comparableText(line.text)).length;
    let end = positions[consumed - 1] + 1;
    const next = positions[consumed] ?? characters.length;
    while (end < next) {
      const character = characters[end];
      const openingQuote = /[\p{Ps}\p{Pi}]/u.test(character)
        || ((character === '"' || character === "'")
          && characters.slice(0, end).filter((previous) => previous === character).length % 2 === 0);
      if (openingQuote) break;
      end++;
    }
    if (index === lines.length - 1) end = characters.length;
    const text = characters.slice(start, end).join("").trim();
    start = end;
    return { ...line, text };
  });
}

export function refineOcrTextStrips(lines: OcrLine[], bitmap: ImageBitmap): OcrLine[] {
  if (!lines.length || bitmap.width < bitmap.height * 4) return lines;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return lines;
  context.drawImage(bitmap, 0, 0);
  return refineTextStripLines(lines, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}
