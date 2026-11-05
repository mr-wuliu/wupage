import { validatePdfMathTranslation } from "./math";
import type { PdfTextBlock } from "./model";
import { normalizeProtectedText } from "../shared/protected-text";

export interface PdfDocumentPage {
  blocks: PdfTextBlock[];
  width: number;
  height: number;
  sourceText: string;
}

export interface PdfDocumentContext {
  context: string;
  abbreviations: Map<string, string>;
}

const REFERENCE_HEADING = /^(?:(?:\d+|[IVX]+)[.)]?\s+)?(?:references|bibliography|literature cited|参考文献|參考文獻)$/iu;
const NEXT_SECTION = /^(?:(?:\d+|[A-Z])[.)]?\s+)?(?:appendix(?:\s+[A-Z\d]+)?|acknowledg(?:e)?ments?|funding|contributors|author contributions|declaration of interests|competing interests|supplementary (?:material|information)|附录|附錄|致谢|致謝)$/iu;
const NUMBERED_REFERENCE = /^(?:\[\d{1,3}\]|\d{1,3}[.)]?)\s+[\p{L}]/u;
const AUTHOR_REFERENCE = /^[\p{Lu}][\p{L}'’\-]+,?\s+(?:[A-Z][.,]?\s*){1,4}(?:[,;]|\(?\d{4}|[\p{Lu}][\p{L}'’\-]+)/u;

export function preparePdfDocument(pages: PdfDocumentPage[], name: string): PdfDocumentContext {
  preserveReferences(pages);
  const headers = new Map<string, number>();
  for (const page of pages) for (const text of new Set(page.blocks.filter((block) => isMarginBlock(block, page.height)).map((block) => block.text))) {
    headers.set(text, (headers.get(text) ?? 0) + 1);
  }
  const source = pages.map((page) => page.sourceText).join("\n");
  const abbreviations = new Map<string, string>();
  for (const match of source.matchAll(/\b([A-Z][A-Z\d-]{1,11})\s*[=＝]\s*([\p{L}][^.;\n=]{3,100})/gu)) {
    const expansion = match[2].trim();
    if (expansion.split(/\s+/u).length >= 2) abbreviations.set(match[1], expansion);
  }
  // Parenthesised abbreviations are common in abstracts. Limit the expansion
  // to the acronym's initial letters rather than collecting a whole sentence.
  for (const match of source.matchAll(/([A-Za-z][A-Za-z -]{5,90})\s*\(([A-Z]{2,8})\)/gu)) {
    const words = match[1].trim().split(/\s+/u);
    const tail = words.slice(-match[2].length).join(" ");
    if (tail.split(/[ -]+/u).map((word) => word[0]).join("").toUpperCase() === match[2]) {
      if (!abbreviations.has(match[2])) abbreviations.set(match[2], tail);
    }
  }
  for (const page of pages) {
    const panels = page.blocks.filter((block) => block.fontWeight >= 600 && block.text.length < 100
      && /^[A-Z]\s+\p{L}/u.test(block.text) && block.lines.length <= 2);
    const panelLetters = new Set(panels.map((block) => block.text[0]));
    for (const block of page.blocks) {
      if (!block.translatable || block.role === "reference") continue;
      if ((isMarginBlock(block, page.height) && (headers.get(block.text) ?? 0) >= Math.max(2, Math.ceil(pages.length / 2)))
        || abbreviations.has(block.text.trim()) || /^(?:https?:\/\/|www\.)\S+$/iu.test(block.text.trim())
        || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(block.text.trim())) {
        block.translatable = false;
        block.preserveOriginal = true;
        block.role = "identifier";
      } else if (panelLetters.size >= 2 && panels.includes(block)) block.role = "figure-label";
    }
  }
  const firstPage = pages[0];
  const title = firstPage?.blocks.filter((block) => block.translatable && block.text.length > 20)
    .sort((a, b) => b.fontSize - a.fontSize)[0];
  const abstractIndex = firstPage?.blocks.findIndex(block => /^(?:abstract\b|摘要)/iu.test(block.text.trim())) ?? -1;
  const overviewBlocks = abstractIndex >= 0 ? firstPage!.blocks.slice(abstractIndex, abstractIndex + 3)
    : firstPage?.blocks.filter(block => block.translatable && block.lines.length >= 3).slice(0, 4) ?? [];
  const abstract = overviewBlocks.filter(block => block.translatable).map(sourceBlockText).join(" ").slice(0, 2200);
  const glossary = [...abbreviations].slice(0, 60).map(([term, expansion]) => `${term} = ${expansion}`).join("\n");
  return { abbreviations, context: [
    `Academic document: ${(title ? sourceBlockText(title) : name).slice(0, 300)}`,
    abstract && `Document overview (source material): ${abstract}`,
    glossary && `Abbreviations defined by this document (preserve identifiers and use these meanings):\n${glossary}`,
    "Translate prose only. Preserve statistical values, identifiers, citation markers and figure panel letters. Use consistent technical terminology."
  ].filter(Boolean).join("\n") };
}

function sourceBlockText(block: PdfTextBlock): string {
  return block.text.replace(/⟪WUPAGE\d+⟫/gu, (marker) => block.formulas?.find((formula) => formula.placeholder === marker)?.text ?? "");
}

export function pdfPageTranslationContext(document: PdfDocumentContext, blocks: PdfTextBlock[], adjacent: PdfTextBlock[] = []): string {
  const passage = blocks.filter((block) => block.translatable && block.text.length >= 60).map(sourceBlockText).join("\n").slice(0, 6000);
  const neighbours = adjacent.filter(block => block.translatable && block.text.length >= 20).map(sourceBlockText).join("\n").slice(0, 2400);
  return [document.context, passage && `Source passages on this page (reference only, including neighbouring sentence fragments):\n${passage}`,
    neighbours && `Adjacent page passages (context only; translate only the requested texts):\n${neighbours}`].filter(Boolean).join("\n");
}

function isMarginBlock(block: PdfTextBlock, height: number): boolean {
  const y = block.lines[0]?.baselineY;
  return block.text.length < 300 && (y < height * 0.06 || y > height * 0.9);
}

function preserveReferences(pages: PdfDocumentPage[]): void {
  let active = false;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const heading = page.blocks.find((block) => !block.tocPart && REFERENCE_HEADING.test(block.text.trim()));
    const referenceCount = [...page.blocks, ...(pages[pageIndex + 1]?.blocks ?? [])]
      .filter((block) => NUMBERED_REFERENCE.test(block.text.trim()) || AUTHOR_REFERENCE.test(block.text.trim())).length;
    if (!active && (!heading || referenceCount < 1)) continue;
    const nextSections = page.blocks.filter((block) => NEXT_SECTION.test(block.text.trim())
      && (!heading || afterHeading(block, heading, page)));
    for (const block of page.blocks) {
      if (block === heading || block.tocPart || nextSections.includes(block)) continue;
      const line = block.lines[0];
      if (!line || line.baselineY < page.height * 0.045 || line.baselineY > page.height * 0.94) continue;
      if (!active && heading && !afterHeading(block, heading, page)) continue;
      if (nextSections.some((section) => afterHeading(block, section, page))) continue;
      block.translatable = false;
      block.preserveOriginal = true;
      block.role = "reference";
    }
    active = nextSections.length === 0;
  }
}

function afterHeading(block: PdfTextBlock, heading: PdfTextBlock, page: PdfDocumentPage): boolean {
  const line = block.lines[0];
  if (!line || !heading.lines.length) return false;
  const tolerance = Math.max(18, block.fontSize * 2);
  const left = Math.min(...block.lines.map((entry) => entry.x));
  const right = Math.max(...block.lines.map((entry) => entry.x + entry.width));
  const headingLeft = Math.min(...heading.lines.map((entry) => entry.x));
  const headingRight = Math.max(...heading.lines.map((entry) => entry.x + entry.width));
  const center = (headingLeft + headingRight) / 2;
  const columns = page.blocks.filter((entry) => entry.lines.length >= 2 && entry.text.length >= 60
    && entry.fontSize <= heading.fontSize * 1.35).map((entry) => ({
    left: Math.min(...entry.lines.map(line => line.x)),
    right: Math.max(...entry.lines.map(line => line.x + line.width))
  })).filter((entry) => entry.left <= center && entry.right >= center && entry.right - entry.left < page.width * 0.7)
    .sort((a, b) => (b.right - b.left) - (a.right - a.left));
  const column = columns[0] ?? { left: headingLeft, right: headingRight };
  // A centered heading is still in the same column as the wider paragraphs
  // below it. Comparing only their left edges mislabels those as references.
  return left > column.right + block.fontSize * 0.4 || (right >= column.left - tolerance && left <= column.right
    && line.baselineY < heading.lines[0].baselineY - block.fontSize * 0.3);
}

export function preparePdfTranslation(block: PdfTextBlock, abbreviations: ReadonlyMap<string, string>): {
  text: string;
  restore: (translation: string) => string;
} {
  const literals: Array<{ placeholder: string; text: string }> = [];
  let serial = Math.max(-1, ...(block.text.match(/⟪WUPAGE\d+⟫/gu) ?? []).map((marker) => Number(/\d+/u.exec(marker)![0]))) + 1;
  const protect = (text: string): string => {
    const placeholder = `⟪WUPAGE${serial++}⟫`;
    literals.push({ placeholder, text });
    return placeholder;
  };
  const source = block.boldPrefix && block.text.startsWith(block.boldPrefix)
    ? `⟪WUPAGEOPEN0⟫${block.boldPrefix}⟪WUPAGECLOSE0⟫${block.text.slice(block.boldPrefix.length)}` : block.text;
  let text = source.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu).map((part) => {
    if (/^⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫$/u.test(part)) return part;
    return part.replace(/\[\d+(?:\s*[,;–−-]\s*\d+)*\]|https?:\/\/[^\s]+|\b[A-Z][A-Z\d-]{1,11}\b|(?<![\p{L}\p{N}])\d+(?:[·.,]\d+)*(?:\s*[–−-]\s*\d+(?:[·.,]\d+)*)?(?:%|‰)?(?!\p{L})/gu,
      (value) => /^\[\d/u.test(value) || /^https?:/u.test(value) || abbreviations.has(value)
        || (/^\d/u.test(value) && (abbreviations.size > 0 || /[·.,%‰–−-]/u.test(value))) ? protect(value) : value);
  }).join("");
  if (block.role === "figure-label") text = text.replace(/^([A-Z])(?=\s)/u, protect);
  return { text, restore: (translation) => {
    if (block.boldPrefix) {
      const normalized = normalizeProtectedText(text, translation);
      if (normalized === undefined) throw new Error("翻译服务未完整保留文字格式，请重试或切换翻译服务。");
      translation = normalized;
    }
    validatePdfMathTranslation(translation, [...(block.formulas ?? []), ...literals]);
    for (const literal of literals) translation = translation.replace(literal.placeholder, literal.text);
    return translation;
  } };
}
