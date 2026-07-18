export type RgbColor = [number, number, number];

export interface ForegroundColorSample {
  color: RgbColor;
  background: RgbColor;
}

export function estimateForegroundColor(
  samples: ReadonlyArray<ForegroundColorSample>
): RgbColor | undefined {
  const candidates = samples
    .map(({ color, background }) => ({
      color,
      contrast: colorDistance(color, background)
    }))
    .filter((sample) => sample.contrast >= 36)
    .sort((left, right) => right.contrast - left.contrast);
  if (!candidates.length) return undefined;

  // Canvas anti-aliasing blends glyph edges with the page background. Averaging
  // all non-background pixels therefore turns black into gray and saturated
  // colors into pale variants. The highest-contrast pixels are the glyph core
  // and most closely represent the color encoded by the PDF.
  const coreCount = Math.max(1, Math.ceil(candidates.length * 0.1));
  const core = candidates.slice(0, coreCount);
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  for (const sample of core) {
    const weight = sample.contrast * sample.contrast;
    red += sample.color[0] * weight;
    green += sample.color[1] * weight;
    blue += sample.color[2] * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return undefined;
  return [
    Math.round(red / totalWeight),
    Math.round(green / totalWeight),
    Math.round(blue / totalWeight)
  ];
}

export function toCssRgb(color: RgbColor): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function colorDistance(left: RgbColor, right: RgbColor): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}
