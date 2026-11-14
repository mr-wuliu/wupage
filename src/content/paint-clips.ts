export interface PaintRect { top: number; right: number; bottom: number; left: number; width: number; height: number }
type Point = { x: number; y: number };

const box = (top: number, right: number, bottom: number, left: number): PaintRect =>
  ({ top, right, bottom, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
const intersect = (a: PaintRect, b: PaintRect): PaintRect | null => {
  const result = box(Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom), Math.max(a.left, b.left));
  return result.width > 0 && result.height > 0 ? result : null;
};

/** Computed basic shapes, in the same viewport coordinates as text ranges. */
export function basicShapeClip(element: Element, style: CSSStyleDeclaration): (rect: PaintRect) => PaintRect | null {
  const source = style.clipPath;
  if (!source || source === "none" || style.display === "contents") return rect => rect;
  const match = /^(inset|circle|ellipse|polygon)\((.*)\)(?:\s+border-box)?$/u.exec(source);
  if (!match) return rect => rect; // Unknown geometry must not discard readable text.
  const bounds = element.getBoundingClientRect();
  const metrics = element as HTMLElement;
  const sx = metrics.offsetWidth ? bounds.width / metrics.offsetWidth : 1, sy = metrics.offsetHeight ? bounds.height / metrics.offsetHeight : 1;
  const length = (value: string, size: number, scale = 1): number | undefined => {
    if (/^-?[\d.]+(?:px|%)?$/u.test(value)) return Number.parseFloat(value) * (value.endsWith("%") ? size / 100 : scale);
    if (!/^calc\([^()]+\)$/u.test(value)) return;
    const terms = value.slice(5, -1).replace(/\s/gu, "").match(/[+-]?[\d.]+(?:px|%)/gu);
    if (!terms || terms.join("") !== value.slice(5, -1).replace(/\s/gu, "")) return;
    return terms.reduce((sum, term) => sum + Number.parseFloat(term) * (term.endsWith("%") ? size / 100 : scale), 0);
  };
  const tokens = (text: string) => text.match(/calc\([^)]*\)|[^\s]+/gu) ?? [];
  if (match[1] === "inset") {
    const values = tokens(match[2].split(/\s+round\s+/u)[0]);
    if (!values.length || values.length > 4) return rect => rect;
    const a = values[0]!, b = values[1] ?? a, c = values[2] ?? a, d = values[3] ?? b;
    const offsets = [length(a, bounds.height, sy), length(b, bounds.width, sx), length(c, bounds.height, sy), length(d, bounds.width, sx)];
    if (offsets.some(value => value === undefined)) return rect => rect;
    const clip = box(bounds.top + offsets[0]!, bounds.right - offsets[1]!, bounds.bottom - offsets[2]!, bounds.left + offsets[3]!);
    return rect => intersect(rect, clip);
  }
  if (match[1] === "polygon") {
    const pairs = match[2].replace(/^(?:evenodd|nonzero)\s*,\s*/u, "").split(",").map(part => tokens(part.trim()));
    const points: Point[] = [];
    for (const pair of pairs) {
      if (pair.length !== 2) return rect => rect;
      const x = length(pair[0], bounds.width, sx), y = length(pair[1], bounds.height, sy);
      if (x === undefined || y === undefined) return rect => rect;
      points.push({ x: bounds.left + x, y: bounds.top + y });
    }
    return rect => {
      let output = points;
      for (const [axis, edge, sign] of [["x", rect.left, 1], ["x", rect.right, -1], ["y", rect.top, 1], ["y", rect.bottom, -1]] as const) {
        const input = output; output = [];
        for (let index = 0; index < input.length; index++) {
          const from = input[index], to = input[(index + 1) % input.length];
          const a = (from[axis] - edge) * sign >= 0, b = (to[axis] - edge) * sign >= 0;
          if (a) output.push(from);
          if (a !== b) {
            const ratio = (edge - from[axis]) / (to[axis] - from[axis]);
            output.push({ x: from.x + ratio * (to.x - from.x), y: from.y + ratio * (to.y - from.y) });
          }
        }
      }
      // Signed areas can cancel for a valid self-intersecting polygon. Only
      // discard a geometrically empty result, never infer emptiness from winding.
      if (!output.length) return null;
      const first = output[0], second = output.find(point => point.x !== first.x || point.y !== first.y);
      if (!second || output.every(point => Math.abs((second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x)) < 0.01)) return null;
      const result = box(Math.min(...output.map(p => p.y)), Math.max(...output.map(p => p.x)), Math.max(...output.map(p => p.y)), Math.min(...output.map(p => p.x)));
      return result.width > 0 && result.height > 0 ? result : null;
    };
  }
  const at = /^(.*?)\bat\s+(.+)$/u.exec(match[2]);
  const radius = at ? at[1].trim() : match[2], center = tokens(at?.[2] ?? "50% 50%");
  const coordinate = (value: string, size: number, scale: number) => ({ left: 0, top: 0, center: size / 2, right: size, bottom: size }[value] ?? length(value, size, scale));
  const cx = coordinate(center[0] ?? "50%", bounds.width, sx), cy = coordinate(center[1] ?? "50%", bounds.height, sy);
  if (cx === undefined || cy === undefined) return rect => rect;
  const radii = tokens(radius), circle = match[1] === "circle";
  const resolveRadius = (value: string, near: number, far: number, size: number, scale = 1) =>
    value === "closest-side" ? near : value === "farthest-side" ? far : length(value, size, scale);
  const localRadius = circle ? resolveRadius(radii[0] ?? "closest-side", Math.min(cx / sx, cy / sy, (bounds.width - cx) / sx, (bounds.height - cy) / sy),
    Math.max(cx / sx, cy / sy, (bounds.width - cx) / sx, (bounds.height - cy) / sy), Math.hypot(bounds.width / sx, bounds.height / sy) / Math.SQRT2) : undefined;
  const rx = circle ? localRadius === undefined ? undefined : localRadius * sx
    : resolveRadius(radii[0] ?? "closest-side", Math.min(cx, bounds.width - cx), Math.max(cx, bounds.width - cx), bounds.width, sx);
  const ry = circle ? localRadius === undefined ? undefined : localRadius * sy
    : resolveRadius(radii[1] ?? "closest-side", Math.min(cy, bounds.height - cy), Math.max(cy, bounds.height - cy), bounds.height, sy);
  if (rx === undefined || ry === undefined) return rect => rect;
  const x = bounds.left + cx, y = bounds.top + cy;
  return rect => {
    if (rx <= 0 || ry <= 0) return null;
    const nearestX = Math.max(rect.left, Math.min(x, rect.right)), nearestY = Math.max(rect.top, Math.min(y, rect.bottom));
    if (((nearestX - x) / rx) ** 2 + ((nearestY - y) / ry) ** 2 >= 1) return null;
    return intersect(rect, box(y - ry, x + rx, y + ry, x - rx));
  };
}
