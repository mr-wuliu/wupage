import { t } from "../shared/i18n";
import { preparePdfTranslation, type PdfDocumentPage } from "./document";
import type { PdfTextBlock } from "./model";
import { normalizeProtectedText } from "../shared/protected-text";

export interface PdfParagraphInput<Region = number> {
  text: string;
  restore: (translation: string) => Map<Region, string>;
}

export interface PdfParagraphRegion { pageNumber: number; index: number }
export interface PdfDocumentParagraphInput extends PdfParagraphInput<PdfParagraphRegion> {
  regions: PdfParagraphRegion[];
}
export interface PdfPageParagraphPlan {
  inputs: Map<number, PdfDocumentParagraphInput>;
  incoming: PdfParagraphRegion[];
}
type FlowPage = Pick<PdfDocumentPage, "blocks" | "width" | "height">;

export function preparePdfDocumentTranslations(pages: readonly FlowPage[], abbreviations: ReadonlyMap<string, string>): PdfPageParagraphPlan[] {
  const regions = pages.flatMap((page, pageIndex) => page.blocks.map((block, index) => ({
    key: { pageNumber: pageIndex + 1, index }, block
  })));
  let offset = 0;
  const next = new Map<number, number>();
  pages.forEach((page, pageIndex) => {
    for (const [from, to] of columnContinuations(page)) next.set(offset + from, offset + to);
    offset += page.blocks.length;
    if (pageIndex + 1 < pages.length) {
      const from = pageEdge(page, true), to = pageEdge(pages[pageIndex + 1], false);
      if (from !== undefined && to !== undefined && continuesAcrossPages(page, from, pages[pageIndex + 1], to)) {
        next.set(offset - page.blocks.length + from, offset + to);
      }
    }
  });
  const parents = new Map<number, number>();
  for (const child of next.values()) parents.set(child, (parents.get(child) ?? 0) + 1);
  for (const [parent, child] of next) if (parents.get(child)! > 1) next.delete(parent);
  const children = new Set(next.values());
  const plans = pages.map((): PdfPageParagraphPlan => ({ inputs: new Map(), incoming: [] }));
  const roots = regions.flatMap((region, index) => region.block.translatable && !children.has(index) ? [index] : []);
  for (const index of roots) {
    const group = [regions[index]];
    let cursor = index, length = regions[index].block.text.length;
    while (next.has(cursor)) {
      cursor = next.get(cursor)!;
      if (length + regions[cursor].block.text.length > 12000) { roots.push(cursor); break; }
      group.push(regions[cursor]);
      length += regions[cursor].block.text.length;
    }
    const owner = group[0].key;
    const input = prepareRegionParagraph(group, abbreviations);
    plans[owner.pageNumber - 1].inputs.set(owner.index, { ...input, regions: group.map(region => region.key) });
    for (const pageNumber of new Set(group.map(region => region.key.pageNumber))) {
      if (pageNumber !== owner.pageNumber) plans[pageNumber - 1].incoming.push(owner);
    }
  }
  return plans;
}

// Keep physical text regions for rendering/editing, but translate a paragraph
// continuing at the top of the next column as one passage.
export function preparePdfPageTranslations(
  page: Pick<PdfDocumentPage, "blocks" | "height">, abbreviations: ReadonlyMap<string, string>
): Map<number, PdfParagraphInput> {
  const next = columnContinuations(page);
  const children = new Set(next.values());
  const inputs = new Map<number, PdfParagraphInput>();
  page.blocks.forEach((block, index) => {
    if (!block.translatable || children.has(index)) return;
    const indexes = [index];
    while (next.has(indexes.at(-1)!)) indexes.push(next.get(indexes.at(-1)!)!);
    if (indexes.length === 1) {
      const input = preparePdfTranslation(block, abbreviations);
      inputs.set(index, { text: input.text, restore: (translation) => new Map([[index, input.restore(translation)]]) });
    } else inputs.set(index, prepareRegionParagraph(indexes.map(key => ({ key, block: page.blocks[key] })), abbreviations));
  });
  return inputs;
}

const CAPTION = /^(?:fig(?:ure)?\.?\s*\d+\s*[.:]|table\s+(?:\d+|[IVX]+)\s*[.:]|[图圖表]\s*\d+\s*[:：.])/iu;
function flowText(block: PdfTextBlock, height: number): boolean {
  const region = bounds(block);
  return block.translatable && !block.preserveOriginal && !block.role && !block.tocPart
    && !CAPTION.test(block.text.trim()) && region.bottom >= height * 0.045 && region.top <= height * 0.94;
}

// Find the last/first prose column, then include short fragments and headings
// within that column. Captions may precede the next page's continuation.
function pageEdge(page: FlowPage, end: boolean): number | undefined {
  const flow = page.blocks.flatMap((block, index) => flowText(block, page.height) ? [{ block, index, region: bounds(block) }] : []);
  let lanes = flow.filter(({ block, region }) => block.fontWeight < 600 && block.lines.length >= 2 && block.text.length >= 40
    && region.right - region.left >= page.width * 0.18);
  const sizes = new Map<number, number>();
  for (const { block } of lanes) sizes.set(block.fontSize, (sizes.get(block.fontSize) ?? 0) + block.lines.length);
  const size = [...sizes].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  if (size) lanes = lanes.filter(({ block }) => Math.abs(block.fontSize / size - 1) <= 0.15);
  lanes = lanes.map(entry => {
    const center = (entry.region.left + entry.region.right) / 2;
    const peers = lanes.filter(peer => peer.region.left <= center && peer.region.right >= center
      && (entry.region.right - entry.region.left > page.width * 0.7 || peer.region.right - peer.region.left <= page.width * 0.7))
      .sort((a, b) => (b.region.right - b.region.left) - (a.region.right - a.region.left));
    const column = peers[0]?.region ?? entry.region;
    return { ...entry, region: { ...entry.region, left: column.left, right: column.right } };
  });
  lanes.sort((a, b) => (end ? b.region.left - a.region.left : a.region.left - b.region.left)
    || (end ? a.region.bottom - b.region.bottom : b.region.top - a.region.top));
  const lane = lanes[0];
  if (!lane) return undefined;
  const tolerance = lane.block.fontSize * 2;
  const entries = flow.filter(({ block, region }) => block.fontSize >= lane.block.fontSize * 0.9
    && (region.left >= lane.region.left - tolerance && region.right <= lane.region.right + tolerance
      || Math.min(region.right, lane.region.right) - Math.max(region.left, lane.region.left)
        > Math.min(region.right - region.left, lane.region.right - lane.region.left) * 0.3));
  entries.sort((a, b) => end ? a.region.bottom - b.region.bottom : b.region.top - a.region.top);
  const edge = entries[0];
  if (!edge || edge.block.fontWeight >= 600 || edge.block.text.length < 8
    || edge.block.lines.length <= 2 && /^(?:[A-Z]|[IVX]+|\d+(?:\.\d+)*)[.)]\s/u.test(edge.block.text)) return undefined;
  if (edge.block.lines.length <= 2 && entries.some(other => other.index !== edge.index && other.block.lines.length <= 2
    && Math.abs(other.region.top - edge.region.top) < lane.block.fontSize * 0.6
    && (other.region.right < edge.region.left - lane.block.fontSize * 0.5
      || other.region.left > edge.region.right + lane.block.fontSize * 0.5))) return undefined;
  return edge.index;
}

function continuesAcrossPages(first: FlowPage, from: number, second: FlowPage, to: number): boolean {
  const a = first.blocks[from], b = second.blocks[to];
  if (bounds(a).bottom > first.height * 0.3 || /[.!?。！？:：]$/u.test(a.text.trim())
    || !/^(?:[\p{Ll}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}(\[]|⟪WUPAGE\d+⟫)/u.test(b.text.trim())
    || a.fontFamily !== b.fontFamily || Math.abs(b.fontSize / a.fontSize - 1) > 0.15) return false;
  // Compare the surrounding column widths rather than a short last/first line.
  const columnWidth = (page: FlowPage, block: PdfTextBlock): number => {
    const region = bounds(block), center = (region.left + region.right) / 2;
    const widths = page.blocks.filter(entry => flowText(entry, page.height) && entry.lines.length >= 2
      && entry.fontFamily === block.fontFamily && Math.abs(entry.fontSize / block.fontSize - 1) <= 0.15)
      .map(bounds).filter(entry => entry.left <= center && entry.right >= center && entry.right - entry.left < page.width * 0.9)
      .map(entry => entry.right - entry.left);
    return Math.max(region.right - region.left, ...widths) / page.width;
  };
  return Math.abs(columnWidth(second, b) / columnWidth(first, a) - 1) <= 0.25;
}

function bounds(block: PdfTextBlock) {
  return {
    left: Math.min(...block.lines.map(line => line.x)),
    right: Math.max(...block.lines.map(line => line.x + line.width)),
    top: Math.max(...block.lines.map(line => line.baselineY)),
    bottom: Math.min(...block.lines.map(line => line.baselineY))
  };
}

function columnContinuations(page: Pick<PdfDocumentPage, "blocks" | "height">): Map<number, number> {
  const regions = page.blocks.map(bounds);
  const body = (block: PdfTextBlock) => block.translatable && !block.preserveOriginal && !block.role && !block.tocPart
    && block.fontWeight < 600 && block.lines.length >= 2 && block.text.length >= 40;
  const next = new Map<number, number>();
  for (const [index, block] of page.blocks.entries()) {
    const a = regions[index];
    if (!body(block) || a.bottom > page.height * 0.2 || /[.!?。！？:：]$/u.test(block.text.trim())) continue;
    const tolerance = block.fontSize * 2;
    const inColumn = (region: typeof a, column: typeof a) => region.left >= column.left - tolerance
      && region.right <= column.right + tolerance;
    // A footer is outside the reading flow. Other text below this region means
    // it is not the end of the column (for example, a caption or a table).
    if (regions.some((region, other) => other !== index && inColumn(region, a)
      && region.bottom < a.bottom - block.fontSize && region.bottom > page.height * 0.045)) continue;
    const candidates = page.blocks.flatMap((candidate, other) => {
      const b = regions[other];
      if (!body(candidate) || b.left < a.right + block.fontSize * 0.5 || b.top < page.height * 0.72
        || candidate.fontFamily !== block.fontFamily || Math.abs(candidate.fontSize / block.fontSize - 1) > 0.15
        || Math.abs((b.right - b.left) / (a.right - a.left) - 1) > 0.2
        || !/^(?:[\p{Ll}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}(\[]|⟪WUPAGE\d+⟫)/u.test(candidate.text.trim())) return [];
      if (regions.some((region, before) => before !== other && inColumn(region, b)
        && region.top > b.top + block.fontSize && region.top < page.height * 0.94)) return [];
      // Never skip an intervening column to reach a later matching fragment.
      if (regions.some(region => region.left > a.right + block.fontSize * 0.5
        && region.right < b.left - block.fontSize * 0.5 && region.right - region.left > block.fontSize * 3)) return [];
      return [other];
    }).sort((left, right) => regions[left].left - regions[right].left || regions[right].top - regions[left].top);
    if (candidates.length) next.set(index, candidates[0]);
  }
  const parents = new Map<number, number>();
  for (const child of next.values()) parents.set(child, (parents.get(child) ?? 0) + 1);
  for (const [parent, child] of next) if (parents.get(child)! > 1) next.delete(parent);
  return next;
}

function prepareRegionParagraph<Region>(regions: Array<{ key: Region; block: PdfTextBlock }>, abbreviations: ReadonlyMap<string, string>): PdfParagraphInput<Region> {
  if (regions.length === 1) {
    const input = preparePdfTranslation(regions[0].block, abbreviations);
    return { text: input.text, restore: translation => new Map([[regions[0].key, input.restore(translation)]]) };
  }
  let serial = 0;
  const parts = regions.map(({ key, block }, index) => {
    const input = preparePdfTranslation(block, abbreviations);
    const next = regions[index + 1]?.block;
    const hyphen = /([a-z]{2,})[-‐\u00ad]$/iu.exec(input.text);
    const joinWord = Boolean(next && /^[a-z]/u.test(next.text) && hyphen
      && !/^(?:real|time|post|pre|non|cross|two|three|self|well|so)$/iu.test(hyphen[1]));
    const ids = new Map<string, number>(), reverse = new Map<string, string>();
    // Each physical region originally owns its literal/format IDs. Namespace
    // them before combining, so a citation cannot replace another region's math.
    const text = (joinWord ? input.text.slice(0, -1) : input.text).replace(/⟪WUPAGE(OPEN|CLOSE)?(\d+)⟫/gu, (token, kind: string | undefined, id: string) => {
      const key = `${kind ? "format" : "atom"}${id}`;
      if (!ids.has(key)) ids.set(key, serial++);
      const mapped = `⟪WUPAGE${kind ?? ""}${ids.get(key)}⟫`;
      reverse.set(mapped, token);
      return mapped;
    });
    const boundary = serial++;
    return { key, input, reverse, boundary, joinWord, text: `⟪WUPAGEOPEN${boundary}⟫${text}⟪WUPAGECLOSE${boundary}⟫` };
  });
  const text = parts.map((part, index) => (index && !parts[index - 1].joinWord ? " " : "") + part.text).join("");
  return { text, restore: (translation) => {
    const normalized = normalizeProtectedText(text, translation);
    if (normalized === undefined) throw new Error(t("theServiceDidNotPreserveParagraphsSpanningColumns"));
    // Validate every region before returning any values, avoiding half-written
    // paragraphs when a provider loses a boundary or a protected formula.
    return new Map(parts.map(part => {
      const open = `⟪WUPAGEOPEN${part.boundary}⟫`, close = `⟪WUPAGECLOSE${part.boundary}⟫`;
      const fragment = normalized.slice(normalized.indexOf(open) + open.length, normalized.indexOf(close))
        .replace(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu, token => part.reverse.get(token) ?? token).trim();
      return [part.key, part.input.restore(fragment)];
    }));
  } };
}
