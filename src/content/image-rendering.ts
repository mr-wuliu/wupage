import { t } from "../shared/i18n";
import type { ImageTextRegion } from "../shared/types";

export function getImageRasterSize(
  width: number, height: number, displayedWidth: number, displayedHeight: number, pixelRatio: number
): { width: number; height: number } {
  // SVGs with only a viewBox can report a 300px intrinsic width while being
  // displayed much larger. Match device pixels, retaining the source aspect
  // ratio and the existing OCR memory limits.
  const scale = Math.min(
    Math.max(1, displayedWidth * pixelRatio / width, displayedHeight * pixelRatio / height),
    4096 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height))
  );
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function wrapImageText(context: Pick<CanvasRenderingContext2D, "measureText">, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    // Preserve whole words when possible; CJK and overlong words can wrap at
    // grapheme boundaries without breaking emoji or combining characters.
    const tokens = paragraph.match(/\s+|[\p{L}\p{N}_'-]+|[^\s]/gu) ?? [];
    for (const token of tokens) {
      if (context.measureText(line + token).width <= width) { line += token; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token.trimStart()), (part) => part.segment);
      for (const character of graphemes) {
        if (line && context.measureText(line + character).width > width) { lines.push(line); line = ""; }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Returns whether the overlay needs to replace the source pixels. Transparent
// erasures would otherwise reveal the original lettering beneath the canvas.
export function renderImageTranslation(canvas: HTMLCanvasElement, source: CanvasImageSource, regions: ImageTextRegion[]): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: regions.some((region) => region.sampleColors) });
  if (!context) throw new Error(t("theBrowserCannotRenderTheImageTranslation"));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Sample before drawing any overlays so adjacent regions do not sample a translation.
  const palettes = regions.map((region) => region.sampleColors ? sampleRegionColors(context, region, canvas.width, canvas.height) : region);
  for (const [index, region] of regions.entries()) {
    const [nx, ny, nw, nh] = region.box;
    const x = nx * canvas.width / 1000;
    const y = ny * canvas.height / 1000;
    const width = nw * canvas.width / 1000;
    const height = nh * canvas.height / 1000;
    const padding = Math.min(2, width * 0.03, height * 0.05);
    context.save();
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    context.clearRect(x, y, width, height);
    if (palettes[index].background !== "transparent") {
      context.fillStyle = palettes[index].background;
      context.fillRect(x, y, width, height);
    }
    context.fillStyle = palettes[index].foreground;
    context.textBaseline = "top";
    context.textAlign = region.align;
    let low = 0.5;
    let high = height / 1.15;
    let fontSize = low;
    let lines: string[] = [];
    const availableWidth = Math.max(1, width - padding * 2);
    const availableHeight = Math.max(1, height - padding * 2);
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const candidate = (low + high) / 2;
      context.font = `${region.bold ? "600" : "400"} ${candidate}px system-ui, sans-serif`;
      const candidateLines = wrapImageText(context, region.translation, availableWidth);
      if (candidateLines.length * candidate * 1.2 <= availableHeight
        && candidateLines.every((line) => context.measureText(line).width <= availableWidth)) {
        fontSize = candidate; lines = candidateLines; low = candidate;
      } else high = candidate;
    }
    context.font = `${region.bold ? "600" : "400"} ${fontSize}px system-ui, sans-serif`;
    if (!lines.length) lines = wrapImageText(context, region.translation, availableWidth);
    const left = region.align === "center" ? x + width / 2 : region.align === "right" ? x + width - padding : x + padding;
    const top = y + padding + Math.max(0, (availableHeight - lines.length * fontSize * 1.2) / 2);
    lines.forEach((line, index) => context.fillText(line, left, top + index * fontSize * 1.2));
    context.restore();
  }
  return palettes.some((palette) => palette.background === "transparent" || palette.background.startsWith("rgba("));
}

function sampleRegionColors(context: CanvasRenderingContext2D, region: ImageTextRegion, imageWidth: number, imageHeight: number): Pick<ImageTextRegion, "foreground" | "background"> {
  const [x, y, w, h] = region.box;
  const left = Math.max(0, Math.floor(x * imageWidth / 1000));
  const top = Math.max(0, Math.floor(y * imageHeight / 1000));
  const width = Math.min(imageWidth - left, Math.max(1, Math.ceil(w * imageWidth / 1000)));
  const height = Math.min(imageHeight - top, Math.max(1, Math.ceil(h * imageHeight / 1000)));
  const { data } = context.getImageData(left, top, width, height);
  const counts = new Map<string, { count: number; channels: number[] }>();
  let transparent = 0;
  let transparentEdges = 0;
  let edges = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const pixel = offset / 4;
    const edge = pixel < width || pixel >= width * (height - 1) || pixel % width === 0 || pixel % width === width - 1;
    if (edge) edges++;
    // RGB channels of transparent pixels are not a visible background color.
    if (data[offset + 3] < 16) {
      transparent++;
      if (edge) transparentEdges++;
      continue;
    }
    const channels = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
    const key = channels.map((value) => Math.round(value / 16)).join(",");
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
      channels.forEach((value, index) => entry.channels[index] += value);
    } else counts.set(key, { count: 1, channels });
  }
  const colors = [...counts.values()].map((entry) => ({
    count: entry.count,
    channels: entry.channels.map((value) => Math.round(value / entry.count))
  })).sort((a, b) => b.count - a.count);
  const clearBackground = transparent >= width * height * 0.5
    || (transparent >= width * height * 0.1 && transparentEdges >= edges * 0.5);
  const background = colors[0]?.channels ?? [255, 255, 255, 255];
  const distance = (channels: number[]) => channels.slice(0, 3)
    .reduce((sum, value, index) => sum + (value - background[index]) ** 2, 0);
  const foreground = colors.filter((entry) => entry.count >= Math.max(2, width * height * 0.005))
    .sort((a, b) => clearBackground
      ? b.count * b.channels[3] - a.count * a.channels[3]
      : distance(b.channels) - distance(a.channels))[0]?.channels;
  const cssColor = (channels: number[]) => channels[3] === 255
    ? `#${channels.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`
    : `rgba(${channels.slice(0, 3).join(", ")}, ${channels[3] / 255})`;
  return {
    foreground: foreground ? cssColor(foreground) : region.foreground,
    background: clearBackground ? "transparent" : cssColor(background)
  };
}
