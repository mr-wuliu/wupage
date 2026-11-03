interface OperatorList {
  fnArray: ReadonlyArray<number>;
  argsArray: ReadonlyArray<ReadonlyArray<unknown>>;
}

export interface PdfFontVisibility {
  isType3Font?: boolean;
  charProcOperatorList?: Readonly<Record<string, { fnArray: ReadonlyArray<number> }>>;
}

interface Bounds { left: number; bottom: number; right: number; top: number }
type Matrix = number[];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function transformedBounds(box: ArrayLike<number>, matrix: Matrix): Bounds {
  const points = [box[0], box[2]].flatMap((x) => [box[1], box[3]].map((y) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5]
  })));
  return { left: Math.min(...points.map((p) => p.x)), right: Math.max(...points.map((p) => p.x)),
    bottom: Math.min(...points.map((p) => p.y)), top: Math.max(...points.map((p) => p.y)) };
}

function intersectsItem(item: object, clip: Bounds | undefined): boolean {
  if (!clip || !("transform" in item) || !("width" in item)) return true;
  const matrix = Array.from(item.transform as ArrayLike<number>);
  const size = Math.hypot(matrix[2], matrix[3]);
  const advance = Math.hypot(matrix[0], matrix[1]) || 1;
  const bounds = transformedBounds([0, -0.25, Number(item.width) / advance, 0.9],
    [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]]);
  return size > 0 && Math.min(bounds.right, clip.right) > Math.max(bounds.left, clip.left)
    && Math.min(bounds.top, clip.top) > Math.max(bounds.bottom, clip.bottom);
}

// getTextContent includes clipped figure titles, hidden layers and invisible OCR
// text. Match its text against the ordered glyph stream, whose visibility is
// described by PDF drawing operations. Keep unmatched text conservatively.
export function filterVisiblePdfText<T extends object>(
  items: ReadonlyArray<T>,
  operators: OperatorList | undefined,
  ops: Readonly<Record<string, number>>,
  optionalContent?: { isVisible(group: unknown): boolean },
  fonts?: ReadonlyMap<string, PdfFontVisibility>
): T[] {
  // Some figures carry text in Type 3 fonts whose glyph programs only declare
  // metrics. They draw nothing, even when the text rendering mode is visible.
  // Unknown operations remain visible; a missing Unicode map alone says
  // nothing about whether the original glyph paints.
  const nonPaintingOps = new Set([ops.setCharWidth, ops.setCharWidthAndBounds, ops.transform, ops.save, ops.restore]
    .filter((operation): operation is number => operation !== undefined));
  const emptyFonts = new Set([...(fonts ?? [])].flatMap(([name, font]) => {
    const programs = Object.values(font.charProcOperatorList ?? {});
    return font.isType3Font && programs.length && programs.every(program => program.fnArray.every(op => nonPaintingOps.has(op)))
      ? [name] : [];
  }));
  items = items.filter(item => !("fontName" in item && emptyFonts.has(String(item.fontName))));
  if (!operators) return [...items];
  const groups = [true];
  let state: { mode: number; fill: number; stroke: number; matrix: Matrix; clip?: Bounds; font?: string } = {
    mode: 0, fill: 1, stroke: 1, matrix: [1, 0, 0, 1, 0, 0]
  };
  const saved: typeof state[] = [];
  let stream = "";
  const visibility: boolean[] = [];
  const clips: Array<Bounds | undefined> = [];
  let hasHiddenText = false;
  let hasClippedText = false;
  operators.fnArray.forEach((operation, index) => {
    const args = operators.argsArray[index] ?? [];
    if (operation === ops.save) saved.push({ ...state });
    else if (operation === ops.restore) state = saved.pop() ?? state;
    else if (operation === ops.transform) state.matrix = multiply(state.matrix, args as number[]);
    else if (operation === ops.paintFormXObjectBegin) {
      saved.push({ ...state });
      if (args[0]) state.matrix = multiply(state.matrix, Array.from(args[0] as ArrayLike<number>));
      if (args[1]) {
        const box = transformedBounds(args[1] as ArrayLike<number>, state.matrix);
        state.clip = state.clip ? { left: Math.max(state.clip.left, box.left), bottom: Math.max(state.clip.bottom, box.bottom),
          right: Math.min(state.clip.right, box.right), top: Math.min(state.clip.top, box.top) } : box;
      }
    } else if (operation === ops.paintFormXObjectEnd) state = saved.pop() ?? state;
    else if (operation === ops.setFont) state.font = String(args[0]);
    else if (operation === ops.setTextRenderingMode) state.mode = Number(args[0]);
    else if (operation === ops.setGState) {
      for (const [key, value] of (args[0] ?? []) as Array<[string, unknown]>) {
        if (key === "ca") state.fill = Number(value);
        if (key === "CA") state.stroke = Number(value);
      }
    } else if (operation === ops.beginMarkedContent || operation === ops.beginMarkedContentProps) {
      const visible = operation === ops.beginMarkedContentProps && args[0] === "OC" && optionalContent
        ? optionalContent.isVisible(args[1]) : true;
      groups.push(groups.at(-1)! && visible);
    } else if (operation === ops.endMarkedContent) {
      if (groups.length > 1) groups.pop();
    } else if ([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText].includes(operation)) {
      if (state.font && emptyFonts.has(state.font)) return;
      const glyphs = args.at(-1);
      if (!Array.isArray(glyphs)) return;
      const text = normalize(glyphs.map((glyph: unknown) => typeof glyph === "object" && glyph !== null && "unicode" in glyph
        ? String(glyph.unicode) : "").join(""));
      const mode = state.mode % 4;
      const visible = groups.at(-1)! && ((mode === 0 || mode === 2) && state.fill > 0
        || (mode === 1 || mode === 2) && state.stroke > 0);
      stream += text;
      for (let character = 0; character < text.length; character++) {
        visibility.push(visible);
        clips.push(state.clip);
      }
      hasHiddenText ||= !visible && Boolean(text);
      hasClippedText ||= Boolean(state.clip && text);
    }
  });
  if (!hasHiddenText && !hasClippedText) return [...items];
  let cursor = 0;
  return items.filter((item) => {
    const text = normalize("str" in item && typeof item.str === "string" ? item.str : "");
    if (!text) return true;
    const offset = stream.indexOf(text, cursor);
    if (offset < 0) return true;
    cursor = offset + text.length;
    for (let index = offset; index < cursor; index++) {
      if (visibility[index] && intersectsItem(item, clips[index])) return true;
    }
    return false;
  });
}

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\s\u200b\u00ad]/gu, "");
}
