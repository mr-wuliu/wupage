import type { PdfPageRectangle } from "./math-structure";

export interface PdfGridEdge {
  axis: "horizontal" | "vertical";
  position: number;
  from: number;
  to: number;
}

const EDGE_TOLERANCE = 0.6;

function collectAxis(edges: readonly PdfGridEdge[], axis: PdfGridEdge["axis"]) {
  const groups: Array<{ position: number; spans: Array<{ from: number; to: number }> }> = [];
  for (const edge of edges.filter(edge => edge.axis === axis).sort((a, b) => a.position - b.position)) {
    const last = groups.at(-1);
    if (last && edge.position - last.position <= EDGE_TOLERANCE) last.spans.push(edge);
    else groups.push({ position: edge.position, spans: [edge] });
  }
  for (const group of groups) {
    const joined: typeof group.spans = [];
    for (const span of group.spans.sort((a, b) => a.from - b.from)) {
      const last = joined.at(-1);
      if (last && span.from <= last.to + EDGE_TOLERANCE) last.to = Math.max(last.to, span.to);
      else joined.push({ from: span.from, to: span.to });
    }
    group.spans = joined;
  }
  return groups;
}

// Build the closed faces of the printed grid. A missing divider joins the
// tiles on either side, so spanning headers and row labels retain their size.
export function findRuledTableCells(edges: readonly PdfGridEdge[], fills: readonly PdfPageRectangle[] = []): PdfPageRectangle[] {
  const vertical = collectAxis(edges, "vertical"), horizontal = collectAxis(edges, "horizontal");
  if (vertical.length < 3 || horizontal.length < 3 || vertical.length * horizontal.length > 12_000) return [];
  const withOutside = (axis: typeof vertical) => [
    { position: axis[0].position - 1, spans: [] }, ...axis,
    { position: axis.at(-1)!.position + 1, spans: [] }
  ];
  const xs = withOutside(vertical), ys = withOutside(horizontal);
  const columns = xs.length - 1, rows = ys.length - 1;
  const covers = (line: (typeof vertical)[number], start: number, end: number): boolean =>
    line.spans.some(span => span.from <= start + EDGE_TOLERANCE && span.to >= end - EDGE_TOLERANCE);
  const visited = new Uint8Array(columns * rows);
  const faces: PdfPageRectangle[] = [];
  for (let start = 0; start < visited.length; start++) {
    if (visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let left = columns, right = -1, bottom = rows, top = -1;
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i] % columns, y = Math.floor(queue[i] / columns);
      left = Math.min(left, x); right = Math.max(right, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
      const visit = (next: number): void => {
        if (!visited[next]) { visited[next] = 1; queue.push(next); }
      };
      if (x > 0 && !covers(xs[x], ys[y].position, ys[y + 1].position)) visit(queue[i] - 1);
      if (x + 1 < columns && !covers(xs[x + 1], ys[y].position, ys[y + 1].position)) visit(queue[i] + 1);
      if (y > 0 && !covers(ys[y], xs[x].position, xs[x + 1].position)) visit(queue[i] - columns);
      if (y + 1 < rows && !covers(ys[y + 1], xs[x].position, xs[x + 1].position)) visit(queue[i] + columns);
    }
    if (left === 0 || bottom === 0 || right === columns - 1 || top === rows - 1
      || queue.length !== (right - left + 1) * (top - bottom + 1)) continue;
    const x = xs[left].position, y = ys[bottom].position;
    const width = xs[right + 1].position - x, height = ys[top + 1].position - y;
    if (width >= 8 && height >= 5) faces.push({ x, y, width, height });
  }
  // Ignore standalone diagram frames. A table has both row and column joins.
  const meets = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  const adjacent = (a: PdfPageRectangle, b: PdfPageRectangle): [boolean, boolean] => [
    (meets(a.x + a.width, b.x) || meets(b.x + b.width, a.x))
      && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y),
    (meets(a.y + a.height, b.y) || meets(b.y + b.height, a.y))
      && Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
  ];
  const remaining = new Set(faces);
  const tables: PdfPageRectangle[] = [];
  for (const face of faces) {
    if (!remaining.delete(face)) continue;
    const group = [face];
    let rowJoin = false, columnJoin = false;
    for (let i = 0; i < group.length; i++) for (const other of remaining) {
      const [across, down] = adjacent(group[i], other);
      if (!across && !down) continue;
      rowJoin ||= down; columnJoin ||= across;
      remaining.delete(other); group.push(other);
    }
    if (group.length >= 4 && rowJoin && columnJoin) tables.push(...group);
  }
  return tables.flatMap(cell => {
    // A shaded header may paint separate labels within a shared outer border.
    // Accept the subdivisions only when they cover the entire row of that cell.
    const parts = fills.filter(part => Math.abs(part.y - cell.y) < EDGE_TOLERANCE
      && Math.abs(part.y + part.height - cell.y - cell.height) < EDGE_TOLERANCE
      && part.x >= cell.x - EDGE_TOLERANCE && part.x + part.width <= cell.x + cell.width + EDGE_TOLERANCE
      && part.width < cell.width - 1).sort((a, b) => a.x - b.x);
    if (parts.length < 2 || Math.abs(parts[0].x - cell.x) > EDGE_TOLERANCE
      || Math.abs(parts.at(-1)!.x + parts.at(-1)!.width - cell.x - cell.width) > EDGE_TOLERANCE
      || parts.slice(1).some((part, index) => Math.abs(part.x - parts[index].x - parts[index].width) > EDGE_TOLERANCE)) return [cell];
    return parts;
  });
}
