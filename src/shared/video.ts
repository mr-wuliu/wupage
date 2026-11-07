export interface VideoSubtitleLayout {
  x: number;
  bottom: number;
  width: number;
  fontSize: number;
}

export interface VideoTranslationSettings {
  enabled: boolean;
  showOriginal: boolean;
  fontSize: 18 | 22 | 26;
  background: "soft" | "none";
  preferredSource: string;
  enabledSites: string[];
  siteLayouts?: Array<VideoSubtitleLayout & { id: string }>;
  originalPosition?: "above" | "below";
  displayMode?: "chinese" | "western";
  sourceStyle?: VideoSubtitleStyle;
  translationStyle?: VideoSubtitleStyle;
}

export interface VideoSubtitleStyle {
  fontSize?: number;
  fontFamily: "sans-serif" | "serif" | "monospace";
  fontWeight: 400 | 600 | 700;
}

function normalizeSubtitleStyle(value: unknown): VideoSubtitleStyle {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    ...(typeof data.fontSize === "number" && Number.isFinite(data.fontSize)
      ? { fontSize: Math.max(14, Math.min(48, Math.round(data.fontSize))) } : {}),
    fontFamily: data.fontFamily === "serif" || data.fontFamily === "monospace" ? data.fontFamily : "sans-serif",
    fontWeight: data.fontWeight === 400 || data.fontWeight === 700 ? data.fontWeight : 600
  };
}

export const DEFAULT_VIDEO_LAYOUT: Readonly<VideoSubtitleLayout> = { x: 50, bottom: 10, width: 90, fontSize: 22 };

export function normalizeVideoLayout(value: unknown): VideoSubtitleLayout {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const read = (key: keyof VideoSubtitleLayout, min: number, max: number) => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value))) : DEFAULT_VIDEO_LAYOUT[key];
  };
  return { x: read("x", 2, 98), bottom: read("bottom", 2, 98), width: read("width", 20, 96), fontSize: read("fontSize", 14, 48) };
}

/** Playback breaks close size ties without allowing a small autoplay ad to win. */
export function videoPriority(area: number, playing: boolean): number { return area * (playing ? 1.5 : 1); }

export function normalizeVideoTranslation(value: unknown): VideoTranslationSettings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: data.enabled !== false,
    showOriginal: data.showOriginal !== false,
    fontSize: data.fontSize === 18 || data.fontSize === 26 ? data.fontSize : 22,
    background: data.background === "none" ? "none" : "soft",
    preferredSource: typeof data.preferredSource === "string" && /^[\w-]{1,32}$/u.test(data.preferredSource) ? data.preferredSource : "auto",
    enabledSites: Array.isArray(data.enabledSites) ? [...new Set(data.enabledSites.filter((site): site is string => typeof site === "string" && /^[\w.-]{1,200}$/u.test(site)))].slice(0, 100) : [],
    ...(data.siteLayouts !== undefined ? { siteLayouts: normalizeSiteLayouts(data.siteLayouts) } : {}),
    ...(data.originalPosition !== undefined ? { originalPosition: data.originalPosition === "below" ? "below" : "above" } : {}),
    ...(data.displayMode !== undefined ? { displayMode: data.displayMode === "western" ? "western" : "chinese" } : {}),
    ...(data.sourceStyle !== undefined ? { sourceStyle: normalizeSubtitleStyle(data.sourceStyle) } : {}),
    ...(data.translationStyle !== undefined ? { translationStyle: normalizeSubtitleStyle(data.translationStyle) } : {})
  };
}

function normalizeSiteLayouts(value: unknown): NonNullable<VideoTranslationSettings["siteLayouts"]> {
  if (!Array.isArray(value)) return [];
  const layouts = new Map<string, VideoSubtitleLayout & { id: string }>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[\w.:[\]-]{1,200}$/u.test(entry.id)) continue;
    layouts.set(entry.id, { id: entry.id, ...normalizeVideoLayout(entry) });
    if (layouts.size >= 100) break;
  }
  return [...layouts.values()];
}

export function sameVideoLanguage(a: string, b: string): boolean {
  const family = (value: string) => {
    const normalized = value.toLowerCase().replaceAll("_", "-");
    if (/^zh(?:-(?:tw|hk|mo|hant))/.test(normalized)) return "zh-Hant";
    if (/^zh(?:-|$)/.test(normalized)) return "zh-Hans";
    return normalized.split("-")[0];
  };
  return a !== "auto" && b !== "auto" && family(a) === family(b);
}
