import { protectPdfMath, type PdfFormula, type PdfTextMeasure } from "./math";
import type { PdfMathRule } from "./math-structure";

export interface PdfTextItemLike {
  str: string;
  transform: ArrayLike<number>;
  width?: number;
  height?: number;
  hasEOL?: boolean;
  fontFamily?: string;
  fontWeight?: number;
  fontName?: string;
  fontFace?: string;
  fontAscent?: number;
  fontDescent?: number;
  preserveOriginal?: boolean;
  tocPart?: "title" | "leader";
  role?: "reference" | "identifier" | "figure-label";
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
  boldPrefix?: string;
  preserveOriginal?: boolean;
  formulas?: PdfFormula[];
  tocPart?: "title" | "leader";
  role?: "reference" | "identifier" | "figure-label";
}

interface TextLine {
  text: string;
  x: number;
  y: number;
  right: number;
  height: number;
  fontFamily: string;
  fontWeight: number;
  boldPrefix?: string;
  preserveOriginal?: boolean;
  tocPart?: "title" | "leader";
  families: Map<string, number>;
  weights: Map<number, number>;
}

export function normalizePdfTextItems(
  items: ReadonlyArray<PdfTextItemLike>,
  viewport: { height: number; transform?: ArrayLike<number> }
): PdfTextItemLike[] {
  const v = viewport.transform;
  if (!v) return [...items];
  // Store text in the displayed page's Cartesian coordinates. PDF rotation,
  // nonzero crop origins and UserUnit must affect glyphs and crops equally.
  return items.map((item) => {
    const [a, b, c, d, x, y] = Array.from(item.transform);
    return {
      ...item,
      transform: [
        v[0] * a + v[2] * b, -(v[1] * a + v[3] * b),
        v[0] * c + v[2] * d, -(v[1] * c + v[3] * d),
        v[0] * x + v[2] * y + v[4], viewport.height - (v[1] * x + v[3] * y + v[5])
      ],
      width: (item.width ?? 0) * Math.hypot(v[0], v[1]),
      height: (item.height || Math.hypot(c, d)) * Math.hypot(v[0], v[1])
    };
  });
}

export function extractTextBlocks(
  items: ReadonlyArray<PdfTextItemLike>,
  pageNumber: number,
  measure?: PdfTextMeasure,
  rules: readonly PdfMathRule[] = []
): PdfTextBlock[] {
  const protectedMath = protectPdfMath(splitTocTextItems(repairSplitWords(items).map(preserveRotatedText), measure), measure, rules);
  const lines = collectLines(protectedMath.items);
  return collectParagraphs(lines)
    .map((block, index) => {
      const formulas = protectedMath.formulas.filter((formula) => block.text.includes(formula.placeholder));
      if (formulas.length === 1 && (block.preserveOriginal || block.text.trim() === formulas[0].placeholder)) {
        const formula = formulas[0];
        block.preserveOriginal = true;
        const height = formula.height / 1.14;
        block.lines = [{ text: formula.text, x: formula.x, baselineY: formula.y + height * 0.24, width: formula.width, height }];
        block.text = formula.text;
      }
      return {
        ...block,
        id: `page-${pageNumber}-text-${index + 1}`,
        translatable: !block.preserveOriginal && isTranslatableText(block.text.replace(/⟪WUPAGE\d+⟫/gu, "")),
        ...(formulas.some((formula) => !formula.display) ? { formulas: formulas.filter((formula) => !formula.display) } : {})
      };
    });
}

// Dot leaders are layout, not prose. Keep their original glyphs and page
// locators, and send each title to the translator as a separate entry.
function splitTocTextItems(items: ReadonlyArray<PdfTextItemLike>, measure?: PdfTextMeasure): PdfTextItemLike[] {
  const output: PdfTextItemLike[] = [];
  const locator = /^(?:\d+(?:[-–]\d+)?|[ivxlcdm]+|[A-Z][-–]\d+)$/iu;
  for (const item of items) {
    const leader = /(?:\.\s*){4,}|[…⋯]{2,}/u.exec(item.str);
    if (item.preserveOriginal || !leader || (item.str.slice(leader.index + leader[0].length).trim()
      && !locator.test(item.str.slice(leader.index + leader[0].length).trim()))) {
      let previous: PdfTextItemLike | undefined;
      for (let index = output.length - 1; index >= 0; index--) {
        if (output[index].str.trim()) { previous = output[index]; break; }
      }
      const followsLeader = previous?.tocPart === "leader"
        && Math.abs(Number(previous.transform[5]) - Number(item.transform[5])) < (item.height || 10) * 0.5;
      output.push(followsLeader && locator.test(item.str.trim()) ? { ...item, preserveOriginal: true } : item);
      continue;
    }
    const title = item.str.slice(0, leader.index).trimEnd();
    if (!title) {
      // Some PDFs emit the title and the dotted run in separate text items.
      for (let index = output.length - 1; index >= 0; index--) {
        const previous = output[index];
        if (Math.abs(Number(previous.transform[5]) - Number(item.transform[5])) > (item.height || 10) * 0.5) break;
        if (!previous.preserveOriginal) output[index] = { ...previous, tocPart: "title" };
      }
    }
    const measuredWidth = (text: string): number => {
      const metrics = measure?.(item, text);
      return typeof metrics === "number" ? metrics : metrics?.width ?? text.length;
    };
    const width = item.width ?? 0;
    const horizontalScale = Math.hypot(Number(item.transform[0]), Number(item.transform[1]))
      / (item.height || Math.hypot(Number(item.transform[2]), Number(item.transform[3])) || 1);
    // PDF.js may synthesize spaces between leader dots. Scaling a prefix by
    // the measured width of that expanded string cuts into the title. Measure
    // the title directly; anchor any trailing locator to the item's right edge.
    const advance = (text: string): number => measure
      ? measuredWidth(text) * horizontalScale
      : width * text.length / Math.max(1, item.str.length);
    const leaderEnd = leader.index + leader[0].length;
    const titleRight = Math.min(width, advance(item.str.slice(0, leader.index)));
    const leaderRight = Math.max(titleRight, width - advance(item.str.slice(leaderEnd)));
    const slice = (start: number, end: number, left: number, right: number): PdfTextItemLike => {
      const transform = Array.from(item.transform);
      transform[4] += left;
      return { ...item, str: item.str.slice(start, end), transform, width: right - left, hasEOL: end === item.str.length && item.hasEOL };
    };
    if (title) output.push({ ...slice(0, title.length, 0, titleRight), tocPart: "title" });
    output.push({ ...slice(title.length, leaderEnd, titleRight, leaderRight), tocPart: "leader", preserveOriginal: true });
    if (leaderEnd < item.str.length) {
      output.push({ ...slice(leaderEnd, item.str.length, leaderRight, width), preserveOriginal: true });
    }
  }
  return output;
}

// Reflowing an angled chart label as horizontal text damages the figure. Keep
// its original pixels, using the four transformed corners for its bounds.
function preserveRotatedText(item: PdfTextItemLike): PdfTextItemLike {
  const a = Number(item.transform[0]);
  const b = Number(item.transform[1]);
  const length = Math.hypot(a, b);
  if (!length || (a > 0 && Math.abs(b / length) < 0.01)) return item;
  const cosine = a / length;
  const sine = b / length;
  const size = item.height || Math.hypot(Number(item.transform[2]), Number(item.transform[3])) || 10;
  const width = item.width || 0;
  const x = Number(item.transform[4]);
  const y = Number(item.transform[5]);
  const corners = [0, width].flatMap((advance) => [-0.24 * size, 0.9 * size].map((rise) => ({
    x: x + advance * cosine - rise * sine,
    y: y + advance * sine + rise * cosine
  })));
  const padding = size * 0.15;
  const left = Math.min(...corners.map((point) => point.x)) - padding;
  const bottom = Math.min(...corners.map((point) => point.y)) - padding;
  const height = (Math.max(...corners.map((point) => point.y)) + padding - bottom) / 1.14;
  return {
    ...item,
    transform: [1, 0, 0, height, left, bottom + height * 0.24],
    width: Math.max(...corners.map((point) => point.x)) + padding - left,
    height,
    preserveOriginal: true
  };
}

function collectLines(items: ReadonlyArray<PdfTextItemLike>): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine | undefined;
  let previousX = Number.NEGATIVE_INFINITY;
  let previousEndedLine = false;
  let explicitSpace = false;

  for (const item of items) {
    const text = normalizeText(item.str);
    if (!text) {
      previousEndedLine ||= Boolean(item.hasEOL);
      explicitSpace ||= /\s/u.test(item.str);
      continue;
    }

    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    const width = Math.max(0, Number(item.width) || 0);
    const height = Math.max(1, Number(item.height) || Math.abs(Number(item.transform[3])) || 10);
    // A hanging list number and its text can be emitted as separate runs
    // with a wider gap than a word space. Keep their shared baseline intact.
    const hangingListNumber = current && /^(?:\[\d{1,3}\]|\d{1,3}[.)])$/u.test(current.text)
      && /^\p{L}/u.test(text) && Math.abs(current.y - y) <= Math.min(current.height, height) * 0.25
      && x >= current.right - 1 && x - current.right <= height * 2.4;
    const separatedOnSameLine = current
      ? !hangingListNumber && isSameVisualLine(current, y, height) && hasLargeHorizontalGap(current, x, height)
      : false;
    const movedToAnotherLine = current
      ? current.preserveOriginal || item.preserveOriginal
        || current.tocPart !== item.tocPart
        || Math.abs(current.y - y) > Math.max(2.5, Math.min(current.height, height) * 0.55)
        || x + (/^⟪WUPAGE\d+⟫$/u.test(text) ? Math.max(2, height * 0.5) : 2) < previousX
        || (previousEndedLine && !hangingListNumber)
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
        fontWeight: item.fontWeight ?? 400,
        families: new Map([[item.fontFamily || "Arial, sans-serif", text.length]]),
        weights: new Map([[item.fontWeight ?? 400, text.length]]),
        ...((item.fontWeight ?? 400) >= 600 ? { boldPrefix: text } : {}),
        ...(item.preserveOriginal ? { preserveOriginal: true } : {}),
        ...(item.tocPart ? { tocPart: item.tocPart } : {})
      };
      lines.push(current);
    } else {
      const extendBoldPrefix = current.boldPrefix === current.text && (item.fontWeight ?? 400) >= 600;
      const touches = x - previousX <= height * 0.12 && !explicitSpace && /\p{L}$/u.test(current.text) && /^\p{L}/u.test(text);
      current.text = touches ? current.text + text : joinText(current.text, text);
      if (extendBoldPrefix) current.boldPrefix = current.text;
      current.x = Math.min(current.x, x);
      current.right = Math.max(current.right, x + width);
      current.height = Math.max(current.height, height);
      const family = item.fontFamily || "Arial, sans-serif";
      const weight = item.fontWeight ?? 400;
      current.families.set(family, (current.families.get(family) ?? 0) + text.length);
      current.weights.set(weight, (current.weights.get(weight) ?? 0) + text.length);
      current.fontFamily = [...current.families].sort((a, b) => b[1] - a[1])[0][0];
      current.fontWeight = [...current.weights].sort((a, b) => b[1] - a[1])[0][0];
    }

    previousX = x + width;
    previousEndedLine = Boolean(item.hasEOL);
    explicitSpace = false;
  }

  return lines;
}

function isSameVisualLine(line: TextLine, y: number, height: number): boolean {
  return Math.abs(line.y - y) <= Math.max(2.5, Math.min(line.height, height) * 0.55);
}

function hasLargeHorizontalGap(line: TextLine, nextX: number, height: number): boolean {
  const gap = nextX - line.right;
  if (gap <= 0) return false;
  const glyphCount = Math.max(1, Array.from(line.text.replace(/\s/gu, "")).length);
  const averageGlyphWidth = Math.max(1, (line.right - line.x) / glyphCount);
  // Justified prose can have spaces almost an em wide. A change in size still
  // marks a separate field; multi-column tables retain their wider gutters.
  const matchingSize = Math.max(line.height, height) / Math.min(line.height, height) < 1.15;
  const maximumWordGap = Math.max(6, line.height * (matchingSize ? 1.05 : 0.55), averageGlyphWidth * 1.75);
  return gap > maximumWordGap;
}

function collectParagraphs(lines: TextLine[]): Omit<PdfTextBlock, "id" | "translatable">[] {
  const blocks: Omit<PdfTextBlock, "id" | "translatable">[] = [];
  let current: TextLine[] = [];

  const commit = (): void => {
    if (!current.length) return;
    const weights = new Map<number, number>();
    for (const line of current) for (const [weight, count] of line.weights) weights.set(weight, (weights.get(weight) ?? 0) + count);
    const fontWeight = [...weights].sort((left, right) => right[1] - left[1])[0][0];
    const normalizedLines = current.map((line) => ({
      text: normalizeText(line.text),
      x: line.x,
      baselineY: line.y,
      width: Math.max(1, line.right - line.x),
      height: line.height
    }));
    blocks.push({
      text: joinParagraphLines(normalizedLines),
      lines: normalizedLines,
      fontFamily: current[0].fontFamily,
      fontWeight,
      fontSize: Math.max(...current.map((line) => line.height)),
      ...(fontWeight < 600 && current[0].boldPrefix ? { boldPrefix: current[0].boldPrefix } : {}),
      ...(current.some((line) => line.preserveOriginal) ? { preserveOriginal: true } : {}),
      ...(current[0].tocPart ? { tocPart: current[0].tocPart } : {})
    });
    current = [];
  };

  for (const line of lines) {
    const previous = current.at(-1);
    if (previous && !canJoinParagraph(previous, line, current)) commit();
    current.push(line);
  }
  commit();
  return blocks;
}

function canJoinParagraph(previous: TextLine, next: TextLine, paragraph: TextLine[]): boolean {
  if (previous.preserveOriginal || next.preserveOriginal || previous.tocPart || next.tocPart) return false;
  const verticalGap = Math.abs(previous.y - next.y);
  const averageHeight = (previous.height + next.height) / 2;
  const sameColumn = Math.abs(previous.x - next.x) <= Math.max(18, averageHeight * 1.7);
  const sameSize = Math.max(previous.height, next.height) / Math.max(1, Math.min(previous.height, next.height)) < 1.35;
  // A run-in bold heading and its regular continuation form one paragraph.
  // Fully bold standalone headings still have no shared regular style.
  const sameStyle = previous.fontFamily === next.fontFamily
    && [...previous.weights.keys()].some(weight => [...next.weights.keys()].some(other => Math.abs(weight - other) < 300));
  const previousEndsSentence = /[.!?。！？:：]$/u.test(previous.text.trim());
  const nextStartsList = /^[•●▪◦·‣⁃\-*]\s*/u.test(next.text.trim());
  const paragraphWidth = Math.max(...paragraph.map((line) => line.right)) - Math.min(...paragraph.map((line) => line.x));
  const indentedParagraph = previousEndsSentence && next.x > Math.min(...paragraph.map((line) => line.x)) + averageHeight * 0.5;
  const shortLastLine = previousEndsSentence && previous.right - previous.x < paragraphWidth * 0.88;
  // An acronym in a chart key is one label, not the first line of the next
  // label. Their colour markers are independent graphical objects.
  const identifierLabel = /^[A-Z][A-Z0-9-]{1,10}$/u.test(previous.text.trim());
  const referenceEntry = /^\[?\d{1,3}[\].)]?\s+[\p{L}]/u.test(next.text.trim());
  return verticalGap <= averageHeight * 1.75
    && sameColumn
    && sameSize
    && sameStyle
    && !indentedParagraph && !shortLastLine && !identifierLabel
    && !nextStartsList && !referenceEntry;
}

function joinParagraphLines(lines: PdfTextLine[]): string {
  return lines.reduce((text, line) => {
    if (!text) return line.text;
    // A discretionary line-end hyphen separates pieces of one word. Keep
    // genuine compounds (real-time, post-operative) using a conservative list.
    if (/[a-z]{2,}\s*[-‐]\s*$/iu.test(text) && /^[a-z]/u.test(line.text)) {
      const prefix = /([a-z]+)\s*[-‐]\s*$/iu.exec(text)?.[1] ?? "";
      return text.replace(/\s*[-‐]\s*$/u, /^(?:real|time|post|pre|non|cross|two|three|self|well|so)$/iu.test(prefix) ? "-" : "") + line.text;
    }
    return `${text} ${line.text}`;
  }, "");
}

function repairSplitWords(items: ReadonlyArray<PdfTextItemLike>): PdfTextItemLike[] {
  const words = new Set(items.flatMap((item) => item.str.toLowerCase().match(/[a-z]{5,}/gu) ?? []));
  const commonWord = /^(?:a|an|as|at|be|by|do|for|he|if|in|is|it|of|on|or|so|the|to|we)$/u;
  return items.map((item) => ({ ...item, str: item.str
    .replace(/\b([a-z]{2,})\s+[-‐]\s*([a-z]{2,})\b/gu,
      (_match, left: string, right: string) => words.has(left + right) || /^(?:re|un|ex|com|con|trans|inter)$/u.test(left)
        ? left + right : `${left}-${right}`)
    .replace(/\b([a-z]{2,})\s+(?=([a-z]{2,})\b)/gu,
      (match, left: string, right: string) => !commonWord.test(left) && words.has(left + right) ? left : match) }));
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
  return value.length > 0 && /\p{L}/u.test(value) && !/^[A-Za-z]$/u.test(value.trim());
}
