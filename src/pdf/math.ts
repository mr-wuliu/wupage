import { t } from "../shared/i18n";
import type { PdfTextItemLike } from "./model";
import { detectPdfMathStructure, type PdfPageRectangle } from "./math-structure";

export interface PdfFormula {
  placeholder: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baselineY: number;
  fontSize: number;
  display: boolean;
}

export type PdfTextMeasure = (item: PdfTextItemLike, text: string) => number | {
  width: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
};

const MATH_FONT = /(?:CM(?:MI|SY|EX)|TeX_CM_|PI_chars|jsMath-|MS[AB]M|LM(?:Math|MI|SY|EX)|Math|Symbol|MT(?:MI|SY|EX)|STIX.*(?:Math|Symbols))/iu;
const MATH_SYMBOL = /[∑∏∫√∂∇∞∈∉∪∩≤≥≠≈±×÷∝∀∃=<>]|^[α-ωΑ-Ω]$/u;
const MATH_WORD = /^(?:min|max|lim|sup|inf|arg|argmin|argmax|prox|sin|cos|tan|log|ln|exp|det|tr|diag|rank|dom|dist|softmax|concat|relu)$/iu;
const EXTENSION_FONT = /(?:CMEX|Maths_Extension|LMEX|MTEX)/iu;

// Use font metadata and positioned runs, rather than asking a translator to
// reconstruct a formula from PDF.js's flattened text (which loses scripts).
export function protectPdfMath(items: ReadonlyArray<PdfTextItemLike>, measure?: PdfTextMeasure, rules: readonly PdfPageRectangle[] = []): {
  items: PdfTextItemLike[];
  formulas: PdfFormula[];
} {
  const structure = detectPdfMathStructure(items, rules);
  const isMathToken = (item: PdfTextItemLike): boolean => !structure.proseFragments.has(item) && (structure.math.has(item) || isMathFontItem(item));
  const isExtension = (item: PdfTextItemLike): boolean => structure.extensions.has(item) || EXTENSION_FONT.test(item.fontName ?? "");
  const tokens = items.flatMap((item) => structure.math.has(item) || structure.unreadable.has(item) ? [item] : splitProseBoundary(item, measure));
  const citations = findSuperscriptCitations(tokens);
  const functionNames = new Set(tokens.filter((item, index) => {
    let nextIndex = index + 1;
    while (nextIndex < tokens.length && !tokens[nextIndex].str.trim()) nextIndex += 1;
    const next = tokens[nextIndex];
    return /^[A-Za-z][A-Za-z0-9]+$/u.test(item.str.trim()) && next && next.tableCell === item.tableCell
      && /^\s*\(/u.test(next.str) && (!isProse(next.str) || isMathToken(next))
      && hasMathArguments(tokens, nextIndex, item.str.trim(), isMathToken)
      && !/^\s*\(\s*[A-Za-z]\s*=\s*[\d.,]+\s*\)\s*$/u.test(next.str)
      && Math.abs(Number(item.transform[5]) - Number(next.transform[5])) < itemSize(item) * 0.5
      && Math.abs(Number(next.transform[4]) - Number(item.transform[4]) - (item.width ?? 0)) < itemSize(item);
  }));
  const isMathItem = (item: PdfTextItemLike): boolean => isMathToken(item) || functionNames.has(item) || citations.has(item);
  const prosePrefixes = new Set(tokens.filter((item, index) => {
    const next = tokens[index + 1];
    if (!next || !/^[A-Z]$/u.test(item.str) || !/^[A-Z]{2,}$/u.test(next.str)
      || isMathItem(item) || isMathItem(next) || item.fontName !== next.fontName) return false;
    const size = itemSize(item), gap = Number(next.transform[4]) - Number(item.transform[4]) - (item.width ?? 0);
    // Small caps often encode MODEL as a full-size M followed by smaller ODEL.
    // Keep its initial out of an immediately preceding formula crop.
    return Math.abs(Number(next.transform[5]) - Number(item.transform[5])) < size * 0.15
      && itemSize(next) >= size * 0.65 && itemSize(next) <= size * 1.05
      && gap >= -size * 0.1 && gap <= size * 0.15;
  }));
  const output: PdfTextItemLike[] = [];
  const formulas: PdfFormula[] = [];
  let pending: PdfTextItemLike[] = [];
  let activeCell: PdfPageRectangle | undefined;
  const flush = (next?: PdfTextItemLike): void => {
    let visible = pending.filter((item) => item.str.trim());
    const anchored = visible.some((item) => isMathItem(item) || MATH_SYMBOL.test(item.str));
    if (!anchored || !visible.length) {
      output.push(...pending);
    } else {
      const size = Math.max(...visible.map(itemSize));
      const baseline = visible.reduce((best, item) => itemSize(item) >= itemSize(best) && !isExtension(item) ? item : best, visible[0]);
      const cell = baseline.tableCell;
      let baselineY = Number(baseline.transform[5]);
      const previous = [...output].reverse().find((item) => item.str.trim());
      const citation = visible.every((item) => citations.has(item));
      const inline = citation || !visible.some(item => structure.display.has(item)) && [previous, next].some((item) => item && item.tableCell === cell && isProse(item.str)
        && !isMathItem(item) && !/⟪WUPAGE\d+⟫/u.test(item.str)
        && Math.abs(Number(item.transform[5]) - baselineY) <= (citation ? itemSize(item) * 0.7 : size * 0.65));
      // Sentence punctuation belongs to the prose. Baking it into an inline
      // image hides it from the translator and produces duplicated commas/full
      // stops when the translated sentence supplies its own punctuation.
      let suffix: PdfTextItemLike[] = [];
      if (inline) {
        const last = visible.at(-1)!;
        const expression = visible.map((item) => item.str).join("");
        const parentheses = !isMathToken(last) ? /^[()]\s*$/u.exec(last.str) : null;
        const balance = (expression.match(/\(/gu)?.length ?? 0) - (expression.match(/\)/gu)?.length ?? 0);
        const proseParenthesis = parentheses && ((/^\(+\s*$/u.test(parentheses[0]) && balance > 0)
          || (/^\)+\s*$/u.test(parentheses[0]) && balance < 0)) ? parentheses : null;
        const punctuation = isExtension(last)
          ? null : /[,.;:，。；：]+\s*$/u.exec(last.str) ?? proseParenthesis;
        if (punctuation) {
          const index = pending.indexOf(last);
          suffix = [sliceTextItem(last, punctuation.index, last.str.length, measure), ...pending.slice(index + 1)];
          pending = [...pending.slice(0, index), sliceTextItem(last, 0, punctuation.index, measure)];
          visible = pending.filter((item) => item.str.trim());
          if (!visible.length) {
            output.push(...suffix);
            pending = [];
            return;
          }
        }
      }
      const padding = size * (inline ? 0.08 : 0.35);
      const left = Math.max(Math.min(...visible.map((item) => Number(item.transform[4]))) - padding, cell ? cell.x + 0.5 : -Infinity);
      const right = Math.min(
        Math.max(...visible.map((item) => Number(item.transform[4]) + (item.width ?? 0))) + padding,
        suffix.length ? Number(suffix[0].transform[4]) : Infinity,
        cell ? cell.x + cell.width - 0.5 : Infinity
      );
      // Font-wide metrics include every possible glyph. CMSY's descent, for
      // example, is almost a whole em even for a minus sign. Using it for an
      // inline crop captures the next prose line and inflates all line boxes.
      const glyphBounds = visible.map((item) => {
        const metrics = inline ? measure?.(item, item.str) : undefined;
        const measured = metrics && typeof metrics !== "number"
          && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent);
        return {
          top: Number(item.transform[5]) + (measured ? metrics.actualBoundingBoxAscent : fontMetric(item.fontAscent, 0.9) * itemSize(item)),
          bottom: measured ? Number(item.transform[5]) - metrics.actualBoundingBoxDescent
            : Number(item.transform[5]) + (!inline && isExtension(item)
              ? Math.min(-1.4, fontMetric(item.fontDescent, 0)) : fontMetric(item.fontDescent, -0.24)) * itemSize(item)
        };
      });
      let bottom = Math.min(...glyphBounds.map((bounds) => bounds.bottom)) - padding;
      // Extensible delimiters descend below the font's ordinary text metrics.
      // Allow their lower curves, but stop before the following prose line.
      if (!inline && next && isProse(next.str) && !isMathItem(next)) {
        const nextTop = Number(next.transform[5]) + fontMetric(next.fontAscent, 0.9) * itemSize(next);
        const lowestBaseline = Math.min(...visible.map((item) => Number(item.transform[5])));
        if (nextTop < lowestBaseline) bottom = Math.max(bottom, nextTop + size * 0.08);
      }
      if (cell) bottom = Math.max(bottom, cell.y + 0.5);
      const top = Math.min(Math.max(...glyphBounds.map((bounds) => bounds.top)) + padding, cell ? cell.y + cell.height - 0.5 : Infinity);
      const prose = citation ? citations.get(visible[0]) : undefined;
      if (prose) baselineY = Number(prose.transform[5]);
      const fontSize = prose ? itemSize(prose) : size;
      const formula: PdfFormula = {
        placeholder: `⟪WUPAGE${formulas.length}⟫`,
        text: visible.map((item) => item.str).join(""),
        x: left, y: bottom, width: right - left, height: top - bottom,
        baselineY, fontSize, display: !inline
      };
      formulas.push(formula);
      output.push({
        str: formula.placeholder,
        transform: [1, 0, 0, fontSize, left, baselineY],
        width: formula.width,
        height: fontSize,
        hasEOL: !inline,
        fontFamily: (inline && (previous?.fontFamily || next?.fontFamily)) || baseline.fontFamily,
        preserveOriginal: !inline,
        ...(cell ? { tableCell: cell } : {})
      });
      output.push(...suffix);
    }
    pending = [];
  };
  for (const [index, token] of tokens.entries()) {
    if (token.str.trim() && token.tableCell !== activeCell) {
      flush();
      activeCell = token.tableCell;
    }
    if (/^[•●▪◦·‣⁃]$/u.test(token.str.trim())
      && (token.str.trim() !== "·" || isMiddleDotListMarker(tokens, index, isMathItem))) {
      flush(token);
      const prose = tokens.slice(index + 1).find((item) => item.str.trim());
      // A bullet is structural text, even when encoded in a math font. Keep
      // it visible to paragraph grouping and to the translation service.
      output.push({ ...token, fontFamily: prose?.fontFamily ?? token.fontFamily, fontWeight: prose?.fontWeight ?? token.fontWeight });
      continue;
    }
    if (token.preserveOriginal || structure.unreadable.has(token) && !structure.math.has(token)) {
      flush();
      output.push(token.preserveOriginal ? token : { ...token, preserveOriginal: true });
      continue;
    }
    if ((isProse(token.str) || prosePrefixes.has(token)) && !isMathItem(token)) {
      flush(token);
      output.push(token);
      continue;
    }
    const previous = [...pending].reverse().find((item) => item.str.trim());
    if (previous && token.str.trim()) {
      const size = Math.max(itemSize(previous), itemSize(token));
      const verticalJump = Math.abs(Number(previous.transform[5]) - Number(token.transform[5]));
      const firstX = Math.min(...pending.filter((item) => item.str.trim()).map((item) => Number(item.transform[4])));
      const nextX = Number(token.transform[4]);
      // A wrapped inline formula resumes at the left of the next prose line.
      // Its two fragments cannot share a rectangular crop: that rectangle
      // would also contain the surrounding prose on both lines. Small backward
      // moves inside fractions/scripts must stay in the same formula.
      const wrapped = verticalJump > size * 0.7
        && nextX + size * 2 < Number(previous.transform[4])
        && nextX <= firstX + size * 0.5;
      const lastX = Math.max(...pending.map((item) => Number(item.transform[4]) + (item.width ?? 0)));
      // A tall closing delimiter can be drawn last with its baseline at the
      // top of the equation. Its apparent jump must not split it off and leave
      // a tiny crop containing only the upper half of the bracket.
      const attachedDelimiter = isExtension(token)
        && nextX >= firstX - size && nextX <= lastX + size;
      const separated = verticalJump < size * 0.5 && nextX - lastX > size * 2.5
        && !(isMathToken(previous) && isMathToken(token));
      if ((verticalJump > size * 2.8 || wrapped || separated) && !attachedDelimiter) flush(token);
    }
    pending.push(token);
  }
  flush();
  return { items: output, formulas };
}

function findSuperscriptCitations(tokens: readonly PdfTextItemLike[]): Map<PdfTextItemLike, PdfTextItemLike> {
  const citations = new Map<PdfTextItemLike, PdfTextItemLike>();
  const visible = tokens.filter(item => item.str.trim());
  // Publishers use several Unicode dashes for ranges and may emit each digit
  // and separator in its own run, with synthetic spaces between those runs.
  const fragment = (item: PdfTextItemLike): boolean => /^[\d\s,;‐‑‒–—−-]+$/u.test(item.str.trim()) && !item.preserveOriginal;
  for (let index = 0; index < visible.length; index++) {
    const first = visible[index];
    if (!fragment(first)) continue;
    let end = index;
    while (end + 1 < visible.length) {
      const a = visible[end], b = visible[end + 1];
      const gap = Number(b.transform[4]) - Number(a.transform[4]) - (a.width ?? 0);
      if (!fragment(b) || a.tableCell !== b.tableCell || Math.abs(itemSize(a) / itemSize(b) - 1) > 0.15
        || Math.abs(Number(a.transform[5]) - Number(b.transform[5])) > itemSize(a) * 0.25
        || gap < -itemSize(a) * 0.1 || gap > itemSize(a) * 0.75) break;
      end++;
    }
    const group = visible.slice(index, end + 1);
    const text = group.map(item => item.str).join("");
    if (/^\d+(?:\s*[,;‐‑‒–—−-]\s*\d+)*$/u.test(text.trim())) {
      const last = visible[end];
      const prose = [visible[index - 1], visible[end + 1]].find(near => near && near.tableCell === first.tableCell && isProse(near.str)
        && itemSize(first) < itemSize(near) * 0.85
        && Number(first.transform[5]) > Number(near.transform[5]) + itemSize(near) * 0.12
        && Number(first.transform[5]) - Number(near.transform[5]) < itemSize(near) * 0.7
        && Math.min(Math.abs(Number(first.transform[4]) - Number(near.transform[4]) - (near.width ?? 0)),
          Math.abs(Number(near.transform[4]) - Number(last.transform[4]) - (last.width ?? 0))) < itemSize(near) * 1.5);
      if (prose) for (const item of group) citations.set(item, prose);
    }
    index = end;
  }
  return citations;
}

function fontMetric(value: number | undefined, fallback: number): number {
  // Some publisher font subsets report zero ascent/descent despite containing
  // visible glyphs. Do not crop their letters or scripts down to the baseline.
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? value : fallback;
}

function hasMathArguments(tokens: ReadonlyArray<PdfTextItemLike>, index: number, name: string, isMathToken: (item: PdfTextItemLike) => boolean): boolean {
  const opening = tokens[index];
  let argument = opening.str.replace(/^\s*\(\s*/u, "");
  let token = opening;
  if (!argument.trim()) {
    token = tokens.slice(index + 1).find(item => item.str.trim()) ?? opening;
    argument = token === opening ? "" : token.str;
  }
  // A plain opening parenthesis before an explanation is not function syntax:
  // "annotations (fine-grained labels ...)" must remain translatable prose.
  return Boolean(argument.trim() && (!isProse(argument) || isMathToken(token))
    && (isMathToken(token) || MATH_SYMBOL.test(argument) || /[A-Za-zΑ-Ωα-ω]/u.test(argument) || MATH_WORD.test(name)));
}

function isMiddleDotListMarker(
  tokens: ReadonlyArray<PdfTextItemLike>, index: number, isMathItem: (item: PdfTextItemLike) => boolean
): boolean {
  const token = tokens[index];
  let previous: PdfTextItemLike | undefined, next: PdfTextItemLike | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].str.trim()) { previous = tokens[cursor]; break; }
  }
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].str.trim()) { next = tokens[cursor]; break; }
  }
  // A multiplication dot continues a math run, including at a wrapped line's
  // start. Only a line-leading dot followed by prose is a list marker.
  return Boolean(next && !isMathItem(next) && isProse(next.str)
    && Math.abs(Number(next.transform[5]) - Number(token.transform[5])) < itemSize(token) * 0.7
    && (!previous || Math.abs(Number(previous.transform[5]) - Number(token.transform[5]))
      > Math.max(itemSize(previous), itemSize(token)) * 0.7));
}

function isMathFontItem(item: PdfTextItemLike): boolean {
  const shortIdentifier = /^[A-Za-zΑ-Ωα-ω]{1,2}$/u.test(item.str.trim())
    && !/^(?:an|as|at|be|by|do|he|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we)$/iu.test(item.str.trim());
  return MATH_FONT.test(item.fontName ?? "")
    || (/Italic|(?:^|[-+])It$|\.I(?:\+[0-9a-f]+)?$/iu.test(item.fontName ?? "") && (shortIdentifier || /^[A-Z]{2}$/u.test(item.str.trim())));
}

function isProse(text: string): boolean {
  return (text.match(/\p{L}+/gu) ?? []).some((word) => !MATH_WORD.test(word)
    && (word.length >= 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)));
}

function itemSize(item: PdfTextItemLike): number {
  return Math.max(1, item.height || Math.abs(Number(item.transform[3])) || 10);
}

function splitProseBoundary(item: PdfTextItemLike, measure?: PdfTextMeasure): PdfTextItemLike[] {
  if (item.preserveOriginal || item.tocPart) return [item];
  if (!isProse(item.str) || isMathFontItem(item)) return [item];
  const words = [...item.str.matchAll(/\p{L}+/gu)].filter((match) => isProse(match[0]));
  const first = words[0].index!;
  const last = words.at(-1)!;
  const end = last.index! + last[0].length;
  const cuts = [0];
  const mathBoundary = (value: string): boolean => /[\d=<>()[\]{}ˆ˜¯^˘˙¨ˇ]/u.test(value)
    || (Boolean(value.trim()) && value.trim().split(/\s+/u).every((word) => MATH_WORD.test(word)));
  if (first > 0 && mathBoundary(item.str.slice(0, first))) cuts.push(first);
  if (end < item.str.length && mathBoundary(item.str.slice(end))) cuts.push(end);
  cuts.push(item.str.length);
  if (cuts.length === 2) return [item];
  return cuts.slice(0, -1).map((start, index) => sliceTextItem(item, start, cuts[index + 1], measure));
}

function sliceTextItem(item: PdfTextItemLike, start: number, end: number, measure?: PdfTextMeasure): PdfTextItemLike {
  const measuredWidth = (text: string): number | undefined => {
    const metrics = measure?.(item, text);
    return typeof metrics === "number" ? metrics : metrics?.width;
  };
  const fullWidth = measuredWidth(item.str) || item.str.length;
  const left = (measuredWidth(item.str.slice(0, start)) ?? start) / fullWidth * (item.width ?? 0);
  const right = (measuredWidth(item.str.slice(0, end)) ?? end) / fullWidth * (item.width ?? 0);
  const transform = Array.from(item.transform);
  transform[4] = Number(transform[4]) + left;
  return { ...item, str: item.str.slice(start, end), transform, width: right - left, hasEOL: end === item.str.length && item.hasEOL };
}

export function validatePdfMathTranslation(text: string, formulas: ReadonlyArray<Pick<PdfFormula, "placeholder">> = []): void {
  const expected = formulas.map((formula) => formula.placeholder).sort();
  const actual = (text.match(/⟪WUPAGE\d+⟫/gu) ?? []).sort();
  if (expected.length !== actual.length || expected.some((token, index) => token !== actual[index])) {
    throw new Error(t("theServiceDidNotPreserveTheMathExpressions"));
  }
}
