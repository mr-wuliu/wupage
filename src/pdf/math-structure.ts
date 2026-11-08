import type { PdfTextItemLike } from "./model";

export interface PdfMathRule { x: number; y: number; width: number; height: number }
export interface PdfMathEvidence {
  math: Set<PdfTextItemLike>;
  extensions: Set<PdfTextItemLike>;
  unreadable: Set<PdfTextItemLike>;
  proseFragments: Set<PdfTextItemLike>;
  display: Set<PdfTextItemLike>;
}

const OPERATOR = /[=<>≤≥≠≈±−×÷∑∏∫√∂∇∞∈∉∪∩∝∀∃]/u;
const OPERATOR_WORD = /^(?:min|max|lim|sup|inf|arg|argmin|argmax|prox|sin|cos|tan|log|ln|exp|det|tr|diag|rank|dom|dist|softmax|concat|relu)$/iu;
// Function words are prose boundaries even when a publisher splits a sentence
// into single-word text runs. They are not evidence about a font's encoding.
const CONNECTIVE = /^(?:a|an|and|any|are|as|at|be|but|by|can|did|for|from|has|if|in|is|it|let|may|not|of|on|or|our|per|so|the|then|to|was|we|when|where|with)$/iu;
const BAD_UNICODE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd\ue000-\uf8ff]/u;

interface Run {
  item: PdfTextItemLike;
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
  opaque: boolean;
  compressed: boolean;
  prose: boolean;
}
interface FontEvidence { runs: Run[]; opaque: number; operators: number; scripts: number; prose: number; characters: number }

// PDF.js 6 constructPath supplies the painting operation and path bounds.
// Retain only thin, painted horizontal paths; text geometry still has to prove
// a fraction, so an underline or a table border alone is never math evidence.
export function readPdfMathRules(
  operators: { fnArray: readonly number[]; argsArray: readonly (readonly unknown[])[] } | undefined,
  ops: Readonly<Record<string, number>>,
  viewport: { height: number; transform?: ArrayLike<number> },
  optionalContent?: { isVisible(group: unknown): boolean }
): PdfMathRule[] {
  if (!operators) return [];
  const multiply = (a: number[], b: ArrayLike<number>): number[] => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  let state = { matrix: [1, 0, 0, 1, 0, 0], lineWidth: 1, fill: 1, stroke: 1 };
  const saved: typeof state[] = [], groups = [true], rules: PdfMathRule[] = [];
  operators.fnArray.forEach((op, index) => {
    const args = operators.argsArray[index] ?? [];
    if (op === ops.save || op === ops.paintFormXObjectBegin) {
      saved.push({ ...state });
      if (op === ops.paintFormXObjectBegin && args[0]) state = { ...state, matrix: multiply(state.matrix, args[0] as ArrayLike<number>) };
    } else if (op === ops.restore || op === ops.paintFormXObjectEnd) state = saved.pop() ?? state;
    else if (op === ops.transform) state.matrix = multiply(state.matrix, args as number[]);
    else if (op === ops.setLineWidth) state.lineWidth = Number(args[0]);
    else if (op === ops.setGState) {
      for (const [key, value] of (args[0] ?? []) as Array<[string, unknown]>) {
        if (key === "ca") state.fill = Number(value);
        if (key === "CA") state.stroke = Number(value);
        if (key === "LW") state.lineWidth = Number(value);
      }
    } else if (op === ops.beginMarkedContent || op === ops.beginMarkedContentProps) {
      groups.push(groups.at(-1)! && !(op === ops.beginMarkedContentProps && args[0] === "OC" && optionalContent && !optionalContent.isVisible(args[1])));
    } else if (op === ops.endMarkedContent) {
      if (groups.length > 1) groups.pop();
    } else if (op === ops.constructPath && groups.at(-1)) {
      const paint = Number(args[0]);
      const stroke = [ops.stroke, ops.closeStroke].includes(paint);
      if (!(stroke ? state.stroke > 0 : [ops.fill, ops.eoFill].includes(paint) && state.fill > 0)) return;
      const box = args[2] as ArrayLike<number> | undefined;
      if (!box || box.length !== 4 || !Array.from(box).every(Number.isFinite)) return;
      const matrix = viewport.transform ? multiply(Array.from(viewport.transform), state.matrix) : state.matrix;
      const points = [box[0], box[2]].flatMap(x => [box[1], box[3]].map(y => ({
        x: matrix[0] * x + matrix[2] * y + matrix[4],
        y: viewport.transform ? viewport.height - (matrix[1] * x + matrix[3] * y + matrix[5]) : matrix[1] * x + matrix[3] * y + matrix[5]
      })));
      const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
      const width = Math.max(...points.map(p => p.x)) - x;
      const height = Math.max(...points.map(p => p.y)) - y + (stroke ? state.lineWidth * Math.hypot(matrix[2], matrix[3]) : 0);
      if ([x, y, width, height].every(Number.isFinite) && width >= 3 && height >= 0 && height <= 2 && height < width * 0.15) {
        rules.push({ x, y, width, height });
      }
    }
  });
  return rules;
}

// Font names are identities only. Learn their roles from the current page's
// encoding, operators and script geometry; unknown/renamed fonts work equally.
export function detectPdfMathStructure(items: readonly PdfTextItemLike[], rules: readonly PdfMathRule[] = []): PdfMathEvidence {
  const math = new Set<PdfTextItemLike>(), extensions = new Set<PdfTextItemLike>(), unreadable = new Set<PdfTextItemLike>();
  const proseFragments = new Set<PdfTextItemLike>();
  const display = new Set<PdfTextItemLike>();
  const runs: Run[] = [];
  const fonts = new Map<string, FontEvidence>();
  for (const item of items) {
    const text = item.str.trim();
    if (!text || item.preserveOriginal || item.tocPart) continue;
    const x = Number(item.transform[4]), y = Number(item.transform[5]);
    const size = Math.max(1, item.height || Math.hypot(Number(item.transform[2]), Number(item.transform[3])) || 10);
    const width = Number(item.width ?? 0);
    if (![x, y, size, width].every(Number.isFinite) || width <= 0) continue;
    const letters = [...text.normalize("NFC").replace(/\s/gu, "")].length;
    // An extension glyph may decode into scores of Latin letters. A generous
    // threshold avoids treating ordinary ligatures or condensed prose as math.
    const compressed = letters >= 16 && /^[A-Za-z]+$/u.test(text) && width < letters * size * 0.12;
    const opaque = compressed || BAD_UNICODE.test(text);
    const prose = !compressed && !OPERATOR_WORD.test(text) && (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
      || /\p{L}{4,}/u.test(text) || (text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 2 || CONNECTIVE.test(text));
    const run: Run = { item, text, x, y, size, width, font: item.fontFace ?? item.fontName ?? "", opaque, compressed, prose };
    runs.push(run);
    if (!fonts.has(run.font)) fonts.set(run.font, { runs: [], opaque: 0, operators: 0, scripts: 0, prose: 0, characters: 0 });
    const font = fonts.get(run.font)!;
    font.runs.push(run); font.opaque += Number(opaque); font.operators += Number(!prose && OPERATOR.test(text));
    font.prose += prose ? letters : 0; font.characters += letters;
    if (opaque) unreadable.add(item);
    if (!prose && (opaque || OPERATOR.test(text))) math.add(item);
  }
  if (!runs.length) return { math, extensions, unreadable, proseFragments, display };

  // Bound neighbour searches by page geometry rather than content-stream order.
  // PDF producers can emit a fraction's denominator or closing delimiter last.
  const sizes = runs.map(run => run.size).sort((a, b) => a - b);
  const cell = Math.max(4, sizes[Math.floor(sizes.length / 2)] * 3);
  const grid = new Map<number, Run[]>();
  for (const run of runs) {
    const key = Math.floor(run.y / cell);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(run);
  }
  for (const row of grid.values()) row.sort((a, b) => a.x - b.x);
  const ends = new Map([...grid].map(([y, row]) => [y, [...row].sort((a, b) => a.x + a.width - b.x - b.width)]));
  const neighbours = (run: Run): Run[] => {
    const found = new Set<Run>();
    const left = run.x - run.size * 3, right = run.x + run.width + run.size * 3;
    const bottom = Math.floor((run.y - run.size * 3) / cell), top = Math.floor((run.y + run.size * 3) / cell);
    // Iterate occupied rows, not coordinates: malformed advances must not make
    // us loop over millions of empty cells.
    for (const [y, row] of grid) {
      if (y < bottom || y > top) continue;
      for (const byEnd of [false, true]) {
        const ordered = byEnd ? ends.get(y)! : row;
        const position = (other: Run): number => other.x + (byEnd ? other.width : 0);
        let low = 0, high = ordered.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (position(ordered[mid]) < left) low = mid + 1; else high = mid;
        }
        for (let index = low; index < ordered.length && position(ordered[index]) <= right; index++) if (ordered[index] !== run) found.add(ordered[index]);
      }
    }
    return [...found];
  };
  const scriptBases = new Set<Run>();
  const scriptRuns = new Set<Run>();
  const scriptedIdentifiers = new Map<string, number[]>();
  for (const run of runs) {
    if (!/^[A-Za-z]{1,3}$/u.test(run.text)) continue;
    const adjacent = neighbours(run).filter(near => near.prose && Math.abs(near.y - run.y) < run.size * 0.12
      && Math.abs(near.size - run.size) < run.size * 0.12);
    const touches = (gap: number): boolean => gap >= -run.size * 0.12 && gap <= run.size * 0.12;
    if (adjacent.some(near => /[A-Za-z]$/u.test(near.text) && touches(run.x - near.x - near.width))
      && adjacent.some(near => /^[A-Za-z]/u.test(near.text) && touches(near.x - run.x - run.width))) {
      run.prose = true;
      proseFragments.add(run.item);
    }
  }
  for (const run of runs) {
    // A Unicode fraction can be a misdecoded operator, but also a real amount
    // in prose ("½ cup"). Require an adjacent variable before using it as a seed.
    if (!run.prose && /\p{No}/u.test(run.text) && neighbours(run).some(near => !near.prose
      && /^[A-Za-zΑ-Ωα-ω]{1,2}$/u.test(near.text) && Math.abs(near.y - run.y) < run.size * 0.8
      && Math.max(run.x - near.x - near.width, near.x - run.x - run.width) < run.size)) math.add(run.item);
  }
  for (const run of runs) {
    if (!/^[A-Z]$/u.test(run.text)) continue;
    if (neighbours(run).some(next => next.font === run.font && /^[A-Z]{2,}$/u.test(next.text)
      && Math.abs(next.y - run.y) < run.size * 0.15 && next.size >= run.size * 0.65 && next.size <= run.size * 1.05
      && next.x - run.x - run.width >= -run.size * 0.1 && next.x - run.x - run.width <= run.size * 0.15)) run.prose = true;
  }
  for (const run of runs) {
    if (proseFragments.has(run.item) || (run.prose && !/^[a-z]{2,3}$/u.test(run.text)) || run.text.length > 4 || run.width > run.size * 2.5) continue;
    for (const other of neighbours(run)) {
      if (other.prose || other.text.length > 4 || other.width > other.size * 2.5 || run.size >= other.size * 0.85) continue;
      const rise = Math.abs(run.y - other.y), gap = run.x - other.x - other.width;
      if (rise < other.size * 0.12 || rise > other.size * 0.8 || gap < -other.size * 0.3 || gap > other.size * 0.55) continue;
      // A single short label above a number is also common in charts. Require
      // the base and script to touch horizontally and have a variable letter.
      if (!/[A-Za-zΑ-Ωα-ω]/u.test(run.text + other.text)) continue;
      scriptBases.add(other); scriptRuns.add(run);
      math.add(run.item); math.add(other.item);
      if (other.font && /^[A-Za-zΑ-Ωα-ω]+$/u.test(other.text) && /^[A-Za-zΑ-Ωα-ω\d]+$/u.test(run.text)) {
        const key = `${other.font}\0${other.text}${run.text}`;
        if (!scriptedIdentifiers.has(key)) scriptedIdentifiers.set(key, []);
        scriptedIdentifiers.get(key)!.push((Math.max(other.x + other.width, run.x + run.width) - other.x) / other.size);
      }
    }
  }
  for (const run of new Set([...scriptBases, ...scriptRuns])) {
    const font = fonts.get(run.font)!;
    font.scripts++;
    if (run.prose) {
      font.prose -= [...run.text.replace(/\s/gu, "")].length;
      run.prose = false;
    }
  }
  // PDF.js can emit the same subscripted identifier as separate positioned
  // runs in an equation and a single flattened run in prose. Reuse only names
  // proven by script geometry, in the same font and with matching advance.
  for (const run of runs) {
    const widths = scriptedIdentifiers.get(`${run.font}\0${run.text}`);
    if (widths?.some(width => Math.abs(run.width / run.size - width) <= Math.max(0.1, width * 0.1))) math.add(run.item);
  }
  const mathematicalFonts = new Set<string>();
  for (const [name, font] of fonts) {
    if (!name || font.prose > font.characters * 0.15) continue;
    if (font.opaque || font.operators >= 2 || font.scripts >= 3) mathematicalFonts.add(name);
    // Missing metrics alone are not evidence of math. Combined with broken
    // encoding they identify extensible glyphs, independent of their name.
    if (font.runs.some(run => run.compressed) || font.opaque >= 2 && font.runs.every(run => !run.item.fontAscent && !run.item.fontDescent)) {
      for (const run of font.runs) if (!run.prose) extensions.add(run.item);
    }
  }
  for (const run of runs) if (!run.prose && mathematicalFonts.has(run.font)) math.add(run.item);

  // A painted rule between closely stacked fragments is fraction evidence.
  // Worded fractions also occur inline: require reduced type, both stacked
  // text rows and an adjacent math anchor to distinguish these from captions.
  for (const rule of rules) {
    if (![rule.x, rule.y, rule.width, rule.height].every(Number.isFinite) || rule.width <= 0 || rule.height < 0) continue;
    const nearby = neighbours({ item: {} as PdfTextItemLike, text: "", x: rule.x, y: rule.y, width: rule.width,
      size: cell / 3, font: "", opaque: false, compressed: false, prose: false });
    const enclosed = nearby.filter(run => (!run.prose || run.size <= cell / 3 * 0.75)
      && run.x >= rule.x - run.size * 0.35
      && run.x + run.width <= rule.x + rule.width + run.size * 0.35 && rule.width <= run.size * (run.prose ? 36 : 12)
      && rule.height <= run.size * 0.16);
    const above = enclosed.filter(run => run.y - rule.y >= run.size * 0.1 && run.y - rule.y <= run.size * 1.05);
    const below = enclosed.filter(run => rule.y - run.y >= run.size * 0.5 && rule.y - run.y <= run.size * 1.25);
    if (!above.length || !below.length) continue;
    if ([...above, ...below].some(run => run.prose)) {
      if (![above, below].every(row => row.some(run => run.prose) && row.reduce((sum, run) => sum + run.width, 0) >= rule.width * 0.65)) continue;
      if (!nearby.some(run => math.has(run.item) && Math.abs(run.y - rule.y) < run.size
        && ((run.x + run.width <= rule.x && rule.x - run.x - run.width < run.size)
          || (run.x >= rule.x + rule.width && run.x - rule.x - rule.width < run.size)))) continue;
    }
    const left = Math.min(...above.map(run => run.x), ...below.map(run => run.x));
    const right = Math.max(...above.map(run => run.x + run.width), ...below.map(run => run.x + run.width));
    if (right - left < rule.width * 0.55) continue;
    for (const run of [...above, ...below]) math.add(run.item);
  }

  // Extend only through compact expression fragments, never through prose or
  // across a column gutter. Repeated passes handle punctuation and script runs.
  for (let pass = 0; pass < 3; pass++) {
    const added: Run[] = [];
    for (const run of runs) {
      if (math.has(run.item) || run.prose || run.width > run.size * 5 || run.text.length > 12) continue;
      const font = fonts.get(run.font)!;
      // Short word tails ("vec-" / "tor") and split ligatures can sit right
      // beside an inline formula. Proximity alone cannot turn a prose font's
      // alphabetic run into math; scripts/operators provide stronger evidence.
      if (/^[A-Za-z]{2,}$/u.test(run.text) && !OPERATOR_WORD.test(run.text) && font.prose > font.characters * 0.15) continue;
      if (!neighbours(run).some(near => {
        if (!math.has(near.item)) return false;
        const size = Math.max(run.size, near.size);
        const gap = Math.max(run.x - near.x - near.width, near.x - run.x - run.width);
        return Math.abs(run.y - near.y) < size * 0.8 && gap >= -size * 0.5 && gap < size * 0.8;
      })) continue;
      added.push(run);
    }
    if (!added.length) break;
    for (const run of added) math.add(run.item);
  }
  for (const [name, font] of fonts) {
    if (!name || font.prose || !font.runs.length) continue;
    // This final step recovers distant encoded delimiters/equation numbers.
    // A font containing word-like labels must not spread a local equation's
    // evidence into an unrelated table or column.
    if (font.runs.some(run => /[A-Za-z]{2,}/u.test(run.text))) continue;
    const supported = font.runs.filter(run => math.has(run.item));
    if (supported.length < 1 || supported.length < font.runs.length * 0.3) continue;
    for (const run of font.runs) if (!run.prose) math.add(run.item);
  }
  protectCaseExpressions(runs, math, extensions, display, cell / 3);
  return { math, extensions, unreadable, proseFragments, display };
}

// A cases expression is a two-dimensional object: its condition words and
// function names belong to the same display as its variables. Recognize the
// enclosing delimiter, aligned expression/condition columns and a relation on
// the left; no publisher encoding or function/condition word list is needed.
function protectCaseExpressions(
  runs: readonly Run[], math: Set<PdfTextItemLike>, extensions: Set<PdfTextItemLike>, display: Set<PdfTextItemLike>, unit: number
): void {
  const candidates = runs.filter(run => !run.prose && run.text.length <= 3 && run.width <= unit * 1.3
    && (/^[{⎧⎨⎩]$/u.test(run.text) || (!/\p{L}/u.test(run.text) && !run.item.fontAscent && !run.item.fontDescent) || extensions.has(run.item)));
  const handled = new Set<Run>();
  for (const delimiter of candidates) {
    if (handled.has(delimiter)) continue;
    const pieces = candidates.filter(run => run.font === delimiter.font && Math.abs(run.x - delimiter.x) < unit * 0.15
      && Math.abs(run.width - delimiter.width) < unit * 0.15 && run.y <= delimiter.y && run.y >= delimiter.y - unit * 5);
    const top = delimiter.y, bottom = Math.min(...pieces.map(run => run.y));
    const stacked = pieces.length >= 3 && top - bottom > unit * 1.4;
    const floor = stacked ? bottom - unit * 1.5 : top - unit * 3.2;
    const right = delimiter.x + delimiter.width;
    const area = runs.filter(run => run.x >= right - unit * 0.15 && run.x < right + unit * 26
      && run.y < top - unit * 0.3 && run.y >= floor);
    let rows: Array<{ y: number; runs: Run[] }> = [];
    for (const run of area.filter(run => run.size >= unit * 0.85 && run.size <= unit * 1.2).sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find(row => Math.abs(row.y - run.y) < unit * 0.25);
      if (row) row.runs.push(run); else rows.push({ y: run.y, runs: [run] });
    }
    // A centered equation number can sit between two branch baselines.
    rows = rows.filter(row => row.runs.some(run => run.x - right <= unit * 1.5));
    if (rows.length < 2 || rows.length > 6) continue;
    for (const row of rows) row.runs.sort((a, b) => a.x - b.x);
    // Do not absorb a following sentence, a wide table, or text in a nearby
    // column. Case values begin just inside the delimiter and repeat that x.
    if (rows.some((row, index) => row.runs[0].x - right > unit * 1.5
      || Math.abs(row.runs[0].x - rows[0].runs[0].x) > unit * 0.5
      || row.runs.some(run => (run.text.match(/\p{L}{2,}/gu)?.length ?? 0) > 2 || /\p{L}{16,}/u.test(run.text))
      || index > 0 && (rows[index - 1].y - row.y < unit * 0.9 || rows[index - 1].y - row.y > unit * 2.2))) continue;
    const conditions = rows.map(row => row.runs.filter(run => run.prose && run.x > row.runs[0].x + unit * 2));
    const conditionX = conditions[0][0]?.x;
    if (conditionX === undefined || !conditions.every(row => row.some(run => Math.abs(run.x - conditionX) < unit * 0.5))) continue;
    if (rows.filter(row => row.runs.some(run => math.has(run.item))).length < 2) continue;
    const lastY = rows.at(-1)!.y, firstY = rows[0].y;
    const left = runs.filter(run => run.x >= delimiter.x - unit * 4 && run.x + run.width <= delimiter.x + unit * 0.15
      && run.y >= lastY - unit * 0.35 && run.y <= firstY + unit * 0.35);
    if (!left.some(run => math.has(run.item) && !/\p{L}/u.test(run.text) && (OPERATOR.test(run.text) || /\p{No}/u.test(run.text)))
      || !left.some(run => math.has(run.item) && /\p{L}/u.test(run.text))) continue;
    const lastX = Math.max(...rows.flatMap(row => row.runs.map(run => run.x + run.width)));
    const contents = area.filter(run => run.y >= lastY - unit * 0.4 && run.y <= firstY + unit * 0.25 && run.x <= lastX);
    for (const run of [...left, ...contents, ...(stacked ? pieces : [delimiter])]) {
      math.add(run.item);
      display.add(run.item);
    }
    for (const run of stacked ? pieces : [delimiter]) { extensions.add(run.item); handled.add(run); }
  }
}
