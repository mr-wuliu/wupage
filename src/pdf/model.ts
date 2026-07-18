export interface PdfTextItemLike {
  str: string;
  transform: ArrayLike<number>;
  width?: number;
  height?: number;
  hasEOL?: boolean;
  fontFamily?: string;
  fontWeight?: number;
}

export interface PdfTextLine {
  text: string;
  x: number;
  baselineY: number;
  width: number;
  height: number;
}

export interface PdfTextBlock {
  id: string;
  text: string;
  translatable: boolean;
  lines: PdfTextLine[];
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
}

interface TextLine {
  text: string;
  x: number;
  y: number;
  right: number;
  height: number;
  fontFamily: string;
  fontWeight: number;
}

export function extractTextBlocks(
  items: ReadonlyArray<PdfTextItemLike>,
  pageNumber: number
): PdfTextBlock[] {
  const lines = collectLines(items);
  return collectParagraphs(lines)
    .map((block, index) => ({
      ...block,
      id: `page-${pageNumber}-text-${index + 1}`,
      translatable: isTranslatableText(block.text)
    }));
}

function collectLines(items: ReadonlyArray<PdfTextItemLike>): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine | undefined;
  let previousX = Number.NEGATIVE_INFINITY;
  let previousEndedLine = false;

  for (const item of items) {
    const text = normalizeText(item.str);
    if (!text) {
      previousEndedLine ||= Boolean(item.hasEOL);
      continue;
    }

    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    const width = Math.max(0, Number(item.width) || 0);
    const height = Math.max(1, Number(item.height) || Math.abs(Number(item.transform[3])) || 10);
    const separatedOnSameLine = current
      ? isSameVisualLine(current, y, height) && hasLargeHorizontalGap(current, x)
      : false;
    const movedToAnotherLine = current
      ? Math.abs(current.y - y) > Math.max(2.5, Math.min(current.height, height) * 0.55)
        || x + 2 < previousX
        || previousEndedLine
        || separatedOnSameLine
      : false;

    if (!current || movedToAnotherLine) {
      current = {
        text,
        x,
        y,
        right: x + width,
        height,
        fontFamily: item.fontFamily || "Arial, sans-serif",
        fontWeight: item.fontWeight ?? 400
      };
      lines.push(current);
    } else {
      current.text = joinText(current.text, text);
      current.x = Math.min(current.x, x);
      current.right = Math.max(current.right, x + width);
      current.height = Math.max(current.height, height);
      current.fontWeight = Math.max(current.fontWeight, item.fontWeight ?? 400);
    }

    previousX = x + width;
    previousEndedLine = Boolean(item.hasEOL);
  }

  return lines;
}

function isSameVisualLine(line: TextLine, y: number, height: number): boolean {
  return Math.abs(line.y - y) <= Math.max(2.5, Math.min(line.height, height) * 0.55);
}

function hasLargeHorizontalGap(line: TextLine, nextX: number): boolean {
  const gap = nextX - line.right;
  if (gap <= 0) return false;
  const glyphCount = Math.max(1, Array.from(line.text.replace(/\s/gu, "")).length);
  const averageGlyphWidth = Math.max(1, (line.right - line.x) / glyphCount);
  const maximumWordGap = Math.max(6, line.height * 0.55, averageGlyphWidth * 1.75);
  return gap > maximumWordGap;
}

function collectParagraphs(lines: TextLine[]): Omit<PdfTextBlock, "id" | "translatable">[] {
  const blocks: Omit<PdfTextBlock, "id" | "translatable">[] = [];
  let current: TextLine[] = [];

  const commit = (): void => {
    if (!current.length) return;
    const normalizedLines = current.map((line) => ({
      text: normalizeText(line.text),
      x: line.x,
      baselineY: line.y,
      width: Math.max(1, line.right - line.x),
      height: line.height
    }));
    blocks.push({
      text: normalizedLines.map((line) => line.text).join(" "),
      lines: normalizedLines,
      fontFamily: current[0].fontFamily,
      fontWeight: Math.max(...current.map((line) => line.fontWeight)),
      fontSize: Math.max(...current.map((line) => line.height))
    });
    current = [];
  };

  for (const line of lines) {
    const previous = current.at(-1);
    if (previous && !canJoinParagraph(previous, line)) commit();
    current.push(line);
  }
  commit();
  return blocks;
}

function canJoinParagraph(previous: TextLine, next: TextLine): boolean {
  const verticalGap = Math.abs(previous.y - next.y);
  const averageHeight = (previous.height + next.height) / 2;
  const sameColumn = Math.abs(previous.x - next.x) <= Math.max(18, averageHeight * 1.7);
  const sameSize = Math.max(previous.height, next.height) / Math.max(1, Math.min(previous.height, next.height)) < 1.35;
  const sameStyle = previous.fontFamily === next.fontFamily
    && Math.abs(previous.fontWeight - next.fontWeight) < 300;
  const previousEndsSentence = /[.!?。！？:：]$/u.test(previous.text.trim());
  const nextStartsList = /^[•●▪◦·‣⁃\-*]\s*/u.test(next.text.trim());
  return verticalGap <= averageHeight * 1.75
    && sameColumn
    && sameSize
    && sameStyle
    && !previousEndsSentence
    && !nextStartsList;
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/u.test(left) || /^\s/u.test(right)) return `${left}${right}`;
  if (/[-‐‑‒–]$/u.test(left)) return `${left}${right}`;
  if (/^[,.;:!?%)}\]，。；：！？、》】）]/u.test(right)) return `${left}${right}`;
  if (/[({\[《【（]$/u.test(left)) return `${left}${right}`;
  if (isCjk(left.at(-1)) && isCjk(right.at(0))) return `${left}${right}`;
  return `${left} ${right}`;
}

function isCjk(value: string | undefined): boolean {
  return Boolean(value && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isTranslatableText(value: string): boolean {
  return value.length > 0 && /\p{L}/u.test(value);
}
