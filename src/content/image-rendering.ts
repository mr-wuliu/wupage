import type { ImageTextRegion } from "../shared/types";

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

export function renderImageTranslation(canvas: HTMLCanvasElement, source: CanvasImageSource, regions: ImageTextRegion[]): void {
  const context = canvas.getContext("2d", { willReadFrequently: regions.some((region) => region.sampleColors) });
  if (!context) throw new Error("浏览器无法绘制图片译文。");
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
    context.fillStyle = palettes[index].background;
    context.fillRect(x, y, width, height);
    context.fillStyle = palettes[index].foreground;
    context.textBaseline = "top";
    context.textAlign = region.align;
    let low = 0.5;
    let high = Math.min(160, height / 1.15);
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
}

function sampleRegionColors(context: CanvasRenderingContext2D, region: ImageTextRegion, imageWidth: number, imageHeight: number): Pick<ImageTextRegion, "foreground" | "background"> {
  const [x, y, w, h] = region.box;
  const left = Math.max(0, Math.floor(x * imageWidth / 1000));
  const top = Math.max(0, Math.floor(y * imageHeight / 1000));
  const width = Math.min(imageWidth - left, Math.max(1, Math.ceil(w * imageWidth / 1000)));
  const height = Math.min(imageHeight - top, Math.max(1, Math.ceil(h * imageHeight / 1000)));
  const { data } = context.getImageData(left, top, width, height);
  const counts = new Map<string, { count: number; rgb: number[] }>();
  for (let offset = 0; offset < data.length; offset += 4) {
    const rgb = [data[offset], data[offset + 1], data[offset + 2]];
    const key = rgb.map((value) => Math.round(value / 16)).join(",");
    const entry = counts.get(key);
    if (entry) entry.count += 1; else counts.set(key, { count: 1, rgb });
  }
  const colors = [...counts.values()].sort((a, b) => b.count - a.count);
  const background = colors[0]?.rgb ?? [255, 255, 255];
  const distance = (rgb: number[]) => rgb.reduce((sum, value, index) => sum + (value - background[index]) ** 2, 0);
  const foreground = colors.filter((entry) => entry.count >= Math.max(2, width * height * 0.005))
    .sort((a, b) => distance(b.rgb) - distance(a.rgb))[0]?.rgb ?? [17, 17, 17];
  const hex = (rgb: number[]) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return { foreground: hex(foreground), background: hex(background) };
}
