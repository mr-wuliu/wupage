import type { PdfPageRectangle } from "./math-structure";
import type { PdfTextItemLike } from "./model";

interface CellRun {
  index: number;
  item: PdfTextItemLike;
  x: number;
  y: number;
  width: number;
  size: number;
}

const COMPARISON = /[<>=≤≥≠∈∉]\s*[([]?\s*[+−-]?\d/u;
const NUMERIC = /^[+−-]?\d+(?:[.,]\d+)*[%‰]?$/u;
const UNIT = /^(?:°[CF]|[fpnumkMGTµμ]?(?:[AVWFSJΩs]|Hz|Pa|m|g)|dB)(?:\/(?:°[CF]|[AVWmΩs]))?$/u;

export function prepareRuledTableItems(
  items: readonly PdfTextItemLike[], cells: readonly PdfPageRectangle[]
): readonly PdfTextItemLike[] {
  if (!cells.length) return items;
  const owners = items.map(item => {
    const x = Number(item.transform[4]), y = Number(item.transform[5]);
    return !item.preserveOriginal ? cells.find(cell => y > cell.y && y < cell.y + cell.height
      && x >= cell.x - 0.4 && x + (item.width ?? 0) <= cell.x + cell.width + 0.4) : undefined;
  });
  const groups = new Map<PdfPageRectangle, { start: number; items: PdfTextItemLike[] }>();
  owners.forEach((cell, index) => {
    if (!cell) return;
    const group = groups.get(cell);
    if (group) group.items.push(items[index]);
    else groups.set(cell, { start: index, items: [items[index]] });
  });
  return items.flatMap((item, index) => {
    const cell = owners[index];
    if (!cell) return [item];
    const group = groups.get(cell)!;
    if (group.start !== index) return [];
    const firstText = group.items.find(entry => entry.str.trim());
    const preserve = isTechnicalCell(group.items);
    return group.items.map(entry => ({ ...entry, tableCell: cell,
      ...(preserve ? { preserveOriginal: true, ...(entry === firstText ? { sourceBounds: cell } : {}) } : {}) }));
  });
}

function isTechnicalCell(items: readonly PdfTextItemLike[]): boolean {
  const text = items.map(item => item.str.trim()).filter(Boolean).join(" ");
  if (!text) return false;
  const tokens = text.split(/\s+/u);
  if (tokens.every(token => {
    const quantity = /^[±+−–-]?\d+(?:[.,]\d+)*(.*)$/u.exec(token);
    return UNIT.test(token) || /^[–—-]$/u.test(token)
      || Boolean(quantity && (/^[%‰]?$/u.test(quantity[1]) || UNIT.test(quantity[1])));
  })) return true;
  const words = text.match(/°?\p{L}+/gu) ?? [];
  if (/[<>=≤≥+±]/u.test(text) && words.every(word => /^[\p{Lu}\p{Script=Greek}]{1,5}$/u.test(word) || /^\p{L}$/u.test(word)
    || UNIT.test(word) || /^(?:or|and|to)$/iu.test(word))) return true;
  // A symbol with a positioned subscript or superscript is also a fixed value.
  const runs = items.filter(item => item.str.trim());
  return runs.length > 1 && /^[\p{L}\d\s]+$/u.test(text) && text.replace(/\s/gu, "").length <= 8
    && runs.some(item => (item.height ?? 0) > 0 && (item.height ?? 0) < (runs[0].height ?? 0) * 0.85
      && Math.abs(Number(item.transform[5]) - Number(runs[0].transform[5])) > (runs[0].height ?? 0) * 0.1);
}

// Preserve compact conditions in a column of adjacent painted cells. Work
// before inline math grouping so a wrap or a numeric neighbour cannot become
// part of a formula crop. Keep headings and descriptive cells translatable.
export function preservePdfTableRules(
  items: readonly PdfTextItemLike[], cells: readonly PdfPageRectangle[]
): readonly PdfTextItemLike[] {
  if (cells.length < 3) return items;
  const runs: CellRun[] = items.flatMap((item, index) => {
    const x = Number(item.transform[4]), y = Number(item.transform[5]);
    const width = item.width ?? 0, size = item.height || Math.hypot(Number(item.transform[2]), Number(item.transform[3]));
    return item.str.trim() && !item.preserveOriginal && [x, y, width, size].every(Number.isFinite) && width > 0 && size > 0
      ? [{ index, item, x, y, width, size }] : [];
  });
  const populatedCells = cells.flatMap(cell => {
    const members = runs.filter(run => run.x >= cell.x - 0.15 && run.x + run.width <= cell.x + cell.width + 0.15
      && run.y > cell.y && run.y < cell.y + cell.height);
    if (!members.length || cell.height > Math.max(...members.map(run => run.size)) * 4) return [];
    return [{ cell, members, text: members.map(run => run.item.str.trim()).join(" ") }];
  });
  const candidates = populatedCells.filter(({ text }) => COMPARISON.test(text) && /\p{L}/u.test(text));
  const columns: (typeof candidates)[] = [];
  for (const candidate of candidates) {
    const column = columns.find(([first]) => Math.abs(first.cell.x - candidate.cell.x) < 0.5
      && Math.abs(first.cell.width - candidate.cell.width) < 0.5);
    if (column) column.push(candidate); else columns.push([candidate]);
  }
  const chains: (typeof candidates)[] = [];
  for (const column of columns) {
    let chain: typeof candidates = [];
    for (const candidate of column.sort((a, b) => a.cell.y - b.cell.y)) {
      const previous = chain.at(-1)?.cell;
      if (previous && Math.abs(previous.y + previous.height - candidate.cell.y) >= 0.5) {
        if (chain.length >= 3) chains.push(chain);
        chain = [];
      }
      chain.push(candidate);
    }
    if (chain.length >= 3) chains.push(chain);
  }

  const replacements = new Map<number, PdfTextItemLike | null>();
  const ruleCells = chains.flat();
  const countCells = ruleCells.flatMap(({ cell }) => populatedCells.filter(other => NUMERIC.test(other.text)
    && Math.abs(other.cell.x - cell.x - cell.width) < 0.5
    && Math.abs(other.cell.y - cell.y) < 0.5 && Math.abs(other.cell.height - cell.height) < 0.5));
  for (const { cell, members } of [...ruleCells, ...countCells]) {
    if (members.some(run => replacements.has(run.index))) continue;

    const rows: CellRun[][] = [];
    for (const run of [...members].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find(entries => Math.abs(entries[0].y - run.y) <= Math.min(entries[0].size, run.size) * 0.35);
      if (row) row.push(run); else rows.push([run]);
    }
    for (const row of rows) {
      const [first] = row.sort((a, b) => a.x - b.x);
      const start = Math.min(...row.map(run => run.index));
      const size = Math.max(...row.map(run => run.size));
      const right = Math.max(...row.map(run => run.x + run.width));
      for (const run of row) replacements.set(run.index, null);
      replacements.set(start, { ...first.item, str: row.map(run => run.item.str.trim()).join(" "),
        width: right - first.x, height: size, hasEOL: true, preserveOriginal: true,
        // Copy the painted cell once. Retain the original text-line positions
        // for the searchable export, including wrapped condition lines.
        ...(row === rows[0] ? { sourceBounds: cell } : {}) });
    }
  }
  return items.flatMap((item, index) => replacements.has(index) ? replacements.get(index) ?? [] : item);
}
