import { t } from "../shared/i18n";
import type { ImageTextRegion } from "../shared/types";

export interface ImageRegionResult {
  regions: ImageTextRegion[];
  skippedRegions: number;
  issues: string[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

export function parseImageRegionResult(content: string, dimensions?: { width: number; height: number }): ImageRegionResult {
  let parsed: unknown;
  try {
    const trimmed = content.trim();
    parsed = JSON.parse(trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed);
  } catch { throw new Error(t("imageRecognitionReturnedIncompleteJson")); }
  const root = record(parsed);
  const items = Array.isArray(parsed) ? parsed : root?.regions;
  if (!Array.isArray(items) || items.length > 300) throw new Error(t("missingRegionsArrayOrMoreThan300Text"));
  const result: ImageRegionResult = { regions: [], skippedRegions: 0, issues: [] };
  for (const [index, value] of items.entries()) {
    try {
      const item = record(value);
      if (!item) throw new Error(t("textRegionMustBeAnObject"));
      const text = item.text ?? item.originalText ?? item.original_text;
      const translation = item.translation ?? item.translatedText ?? item.translated_text;
      if (typeof text !== "string" || !text.trim()) throw new Error(t("missingSourceTextField"));
      if (typeof translation !== "string" || !translation.trim()) throw new Error(t("emptyTranslationField"));
      if (translation.length > 12000) throw new Error(t("translationTooLong"));
      const box = normalizeBox(item, root, dimensions);
      const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
      result.regions.push({
        box, text: text.trim(), translation: translation.trim(),
        foreground: color(item.foreground, "#111111"), background: color(item.background, "#ffffff"),
        align: item.align === "center" || item.align === "right" ? item.align : "left", bold: item.bold === true
      });
    } catch (error) {
      result.skippedRegions += 1;
      if (result.issues.length < 5) result.issues.push(t("textRegion", index + 1, error instanceof Error ? error.message : t("invalidFormat")));
    }
  }
  return result;
}

function normalizeBox(item: RecordValue, root: RecordValue | undefined, dimensions?: { width: number; height: number }): ImageTextRegion["box"] {
  const raw = item.box ?? item.bbox ?? item;
  const object = record(raw);
  let format = item.boxFormat ?? item.box_format ?? root?.boxFormat ?? root?.box_format ?? "xywh";
  let coordinates: unknown = raw;
  if (object) {
    if ("width" in object && "height" in object) { coordinates = [object.x ?? object.left, object.y ?? object.top, object.width, object.height]; format = "xywh"; }
    else if ("x1" in object && "x2" in object) { coordinates = [object.x1, object.y1, object.x2, object.y2]; format = "xyxy"; }
    else if ("right" in object && "bottom" in object) { coordinates = [object.left, object.top, object.right, object.bottom]; format = "xyxy"; }
  }
  if (!Array.isArray(coordinates) || coordinates.length !== 4) throw new Error(t("theBoxMustContainFourCoordinates"));
  const numbers = coordinates.map((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return Number(value);
    return NaN;
  });
  if (!numbers.every(Number.isFinite)) throw new Error(t("coordinatesContainANonnumericValue"));
  let [x, y, width, height] = numbers;
  if (format === "xyxy") { width -= x; height -= y; }
  else if (format !== "xywh") throw new Error(t("unknownBoxformatUseXywh"));
  const units = item.coordinateSystem ?? item.coordinate_system ?? root?.coordinateSystem ?? root?.coordinate_system ?? "normalized_1000";
  let scaleX = 1, scaleY = 1;
  if (units === "pixels" || units === "pixel") {
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new Error(t("pixelCoordinatesRequireImageDimensions"));
    scaleX = 1000 / dimensions.width; scaleY = 1000 / dimensions.height;
  } else if (units === "normalized_1") { scaleX = scaleY = 1000; }
  else if (units === "percent") { scaleX = scaleY = 10; }
  else if (units !== "normalized_1000") throw new Error(t("unknownCoordinatesystemUseNormalized1000"));
  x *= scaleX; width *= scaleX; y *= scaleY; height *= scaleY;
  if (width <= 0 || height <= 0) throw new Error(t("boxWidthAndHeightMustBePositiveUse"));
  // Permit small edge rounding only. Never guess whether unlabelled arrays
  // are pixel coordinates or opposite corners: a wrong mask can erase art.
  const tolerance = 5;
  if (x < -tolerance || y < -tolerance || x + width > 1000 + tolerance || y + height > 1000 + tolerance) {
    throw new Error(t("boxOutOfBoundsBoxCoordinatesystemBoxformat", numbers.join(","), String(units), String(format)));
  }
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(1000, x + width), bottom = Math.min(1000, y + height);
  if (right <= left || bottom <= top) throw new Error(t("textBoxLiesOutsideTheImage"));
  return [left, top, right - left, bottom - top];
}

// Cache entries are complete canonical results, so reject partial cache data.
export function parseImageRegions(content: string): ImageTextRegion[] {
  const result = parseImageRegionResult(content);
  if (result.skippedRegions) throw new Error(result.issues.join("；"));
  return result.regions;
}
