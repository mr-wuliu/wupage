import { t } from "../shared/i18n";
export function selectOcrBackground(pixels: Uint8ClampedArray): "white" | "black" | undefined {
  let transparent = false;
  let luminance = 0;
  let weight = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha < 255) transparent = true;
    if (alpha < 16) continue;
    luminance += (pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722) * alpha;
    weight += alpha;
  }
  if (!transparent) return undefined;
  return weight && luminance / weight >= 160 ? "black" : "white";
}

export function prepareOcrInput(bitmap: ImageBitmap): HTMLCanvasElement {
  // The OCR backend converts RGBA directly to BGR, discarding alpha. Prepare
  // an opaque recognition copy so transparent black/white text stays visible.
  // PaddleOCR closes ImageBitmap inputs, so always give it a canvas copy.
  // Keep our bitmap alive, with its original alpha, for postprocessing.
  const sample = document.createElement("canvas");
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  sample.width = Math.max(1, Math.round(bitmap.width * scale));
  sample.height = Math.max(1, Math.round(bitmap.height * scale));
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) throw new Error(t("theBrowserCannotReadTheOcrImage"));
  sampleContext.drawImage(bitmap, 0, 0, sample.width, sample.height);
  const background = selectOcrBackground(sampleContext.getImageData(0, 0, sample.width, sample.height).data);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("theBrowserCannotPrepareTheOcrImage"));
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0);
  return canvas;
}
