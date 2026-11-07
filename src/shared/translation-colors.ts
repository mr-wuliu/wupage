export interface TranslationColors { light: string; dark: string }

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function mapTranslationTextColor(
  sourceCssColor: string,
  backgroundCssColor: string,
  colors?: TranslationColors
): string | null {
  const source = parseCssColor(sourceCssColor);
  const background = parseCssColor(backgroundCssColor);
  if (!source || !background) return null;

  const opaqueBackground = compositeColor(background, { r: 255, g: 255, b: 255, a: 1 });
  const opaqueSource = compositeColor(source, opaqueBackground);
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const darkBackground = contrastRatio(white, opaqueBackground) > contrastRatio(black, opaqueBackground);
  const contrastColor = darkBackground ? white : black;
  const ensureContrast = (color: RgbaColor): RgbaColor => contrastRatio(color, opaqueBackground) >= 4.6
    ? color : mixUntilContrast(color, contrastColor, opaqueBackground, 4.6);
  const configured = colors ? parseCssColor(darkBackground ? colors.dark : colors.light) : null;
  const accent = configured ?? (darkBackground
    ? { r: 94, g: 234, b: 212, a: 1 }
    : { r: 15, g: 118, b: 110, a: 1 });
  // Adjust the hue for readability, then preserve the user's explicit opacity.
  let mapped = ensureContrast(configured ? { ...configured, a: 1 } : mixColors(opaqueSource, accent, 0.65));

  if (configured && colorDistance(mapped, opaqueSource) < 48) {
    // Retain the chosen hue while keeping translation distinguishable from the source.
    const darker = ensureContrast(mixColors(mapped, black, .28));
    const lighter = ensureContrast(mixColors(mapped, white, .28));
    mapped = colorDistance(darker, opaqueSource) > colorDistance(lighter, opaqueSource) ? darker : lighter;
  }

  if (!configured && colorDistance(mapped, opaqueSource) < 48) {
    // Teal source text needs a different accent, not another near-identical teal.
    const alternate = darkBackground
      ? { r: 147, g: 197, b: 253, a: 1 }
      : { r: 37, g: 99, b: 235, a: 1 };
    mapped = ensureContrast(mixColors(opaqueSource, alternate, 0.8));
  }
  const channels = `${Math.round(mapped.r)}, ${Math.round(mapped.g)}, ${Math.round(mapped.b)}`;
  return configured && configured.a < 1 ? `rgba(${channels}, ${configured.a})` : `rgb(${channels})`;
}

export function getEffectiveBackgroundColor(source: Element): string {
  const layers: RgbaColor[] = [];
  let current: Element | null = source;
  while (current) {
    const color = parseCssColor(window.getComputedStyle(current).backgroundColor);
    if (color && color.a > 0) layers.push(color);
    current = current.parentElement;
  }
  let result: RgbaColor = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of layers.reverse()) result = compositeColor(layer, result);
  return `rgb(${Math.round(result.r)}, ${Math.round(result.g)}, ${Math.round(result.b)})`;
}

let cssColorContext: CanvasRenderingContext2D | null | undefined;
const resolvedCssColors = new Map<string, RgbaColor>();

function parseCssColor(value: string): RgbaColor | null {
  if (!value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return {
    r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16), a: 1
  };
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return resolveCssColor(value);
  const alphaValue = match[4] === undefined ? 1 : Number.parseFloat(match[4]);
  const alpha = match[4]?.includes("%") ? alphaValue / 100 : alphaValue;
  return {
    r: clampColorChannel(Number(match[1])),
    g: clampColorChannel(Number(match[2])),
    b: clampColorChannel(Number(match[3])),
    a: Math.max(0, Math.min(1, alpha))
  };
}

function resolveCssColor(value: string): RgbaColor | null {
  const cached = resolvedCssColors.get(value);
  if (cached) return cached;
  if (typeof CSS === "undefined" || !CSS.supports("color", value)
    || typeof CanvasRenderingContext2D === "undefined") return null;
  try {
    if (cssColorContext === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      cssColorContext = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!cssColorContext) return null;
    // Computed styles preserve oklch(), lab() and color(display-p3 ...).
    // Let the browser convert them into sRGB instead of falling back to the source.
    cssColorContext.clearRect(0, 0, 1, 1);
    cssColorContext.fillStyle = value;
    cssColorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = cssColorContext.getImageData(0, 0, 1, 1).data;
    const color = { r, g, b, a: alpha / 255 };
    if (resolvedCssColors.size >= 256) resolvedCssColors.clear();
    resolvedCssColors.set(value, color);
    return color;
  } catch {
    return null;
  }
}

function compositeColor(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha
  };
}

function mixColors(from: RgbaColor, to: RgbaColor, amount: number): RgbaColor {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1
  };
}

function mixUntilContrast(
  color: RgbaColor,
  contrastColor: RgbaColor,
  background: RgbaColor,
  targetRatio: number
): RgbaColor {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (low + high) / 2;
    const candidate = mixColors(color, contrastColor, amount);
    if (contrastRatio(candidate, background) >= targetRatio) high = amount;
    else low = amount;
  }
  return mixColors(color, contrastColor, high);
}

function contrastRatio(left: RgbaColor, right: RgbaColor): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: RgbaColor): number {
  const linearize = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function colorDistance(left: RgbaColor, right: RgbaColor): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0));
}
