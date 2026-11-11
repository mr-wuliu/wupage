import { t } from "./i18n";
import { uiIconUrl } from "./ui-icons";
import { DEFAULT_POPUP_MENU, normalizePopupMenu, type PopupMenuLayout } from "./popup-menu";

export type AppearanceMode = "system" | "light" | "dark";
export type AppearanceTone = "light" | "dark";
interface InterfaceColors {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  border: string;
  success: string;
  danger: string;
}
export interface AppearanceColors extends InterfaceColors {
  "floating-background": string;
  "floating-foreground": string;
  "floating-hover": string;
  "translation-light": string;
  "translation-dark": string;
  "paragraph-highlight": string;
  "selection-trigger": string;
  "selection-background": string;
  "selection-foreground": string;
  "selection-accent": string;
  "image-button-background": string;
  "image-button-foreground": string;
}
export interface ColorScheme {
  id: string;
  name: string;
  tone: AppearanceTone;
  colors: AppearanceColors;
  opacities?: Partial<Record<keyof AppearanceColors, number>>;
}
export interface AppearanceSettings {
  popupMenu: PopupMenuLayout;
  mode: AppearanceMode;
  floatingOpacity: number;
  paragraphHighlightEnabled: boolean;
  lightSchemeId: string;
  darkSchemeId: string;
  customSchemes: ColorScheme[];
}

export const COLOR_GROUPS = [
  { id: "interface", get label() { return t("interface"); }, get description() { return t("settingsPopupFloatingMenuAndDebugPanel"); } },
  { id: "floating", get label() { return t("floatingButton"); }, get description() { return t("backgroundTextAndHoverColorsForTheFloating"); } },
  { id: "translation", get label() { return t("translationAndParagraphs"); }, get description() { return t("twoColorTranslationsAdaptToThePageBackground"); } },
  { id: "selection", get label() { return t("selectionTranslation"); }, get description() { return t("selectionShortcutAndDictionaryCard"); } },
  { id: "image", get label() { return t("imageTranslationShortcut"); }, get description() { return t("theTranslationButtonBesideAnImageOverlaidText"); } }
] as const;

export const COLOR_FIELDS: ReadonlyArray<{ key: keyof AppearanceColors; label: string; group: typeof COLOR_GROUPS[number]["id"] }> = [
  { key: "background", get label() { return t("pageBackground"); }, group: "interface" }, { key: "surface", get label() { return t("panelBackground"); }, group: "interface" },
  { key: "foreground", get label() { return t("primaryText"); }, group: "interface" }, { key: "muted", get label() { return t("secondaryText"); }, group: "interface" },
  { key: "accent", get label() { return t("accent"); }, group: "interface" }, { key: "border", get label() { return t("border"); }, group: "interface" },
  { key: "success", get label() { return t("successMessage"); }, group: "interface" }, { key: "danger", get label() { return t("errorMessage"); }, group: "interface" },
  { key: "floating-background", get label() { return t("background"); }, group: "floating" }, { key: "floating-foreground", get label() { return t("text"); }, group: "floating" },
  { key: "floating-hover", get label() { return t("hoverBackground"); }, group: "floating" },
  { key: "translation-light", get label() { return t("translationOnLightPages"); }, group: "translation" },
  { key: "translation-dark", get label() { return t("translationOnDarkPages"); }, group: "translation" },
  { key: "paragraph-highlight", get label() { return t("paragraphHighlightColor"); }, group: "translation" },
  { key: "selection-trigger", get label() { return t("selectionShortcut"); }, group: "selection" },
  { key: "selection-background", get label() { return t("cardBackground"); }, group: "selection" },
  { key: "selection-foreground", get label() { return t("cardText"); }, group: "selection" },
  { key: "selection-accent", get label() { return t("cardAccent"); }, group: "selection" },
  { key: "image-button-background", get label() { return t("buttonBackground"); }, group: "image" },
  { key: "image-button-foreground", get label() { return t("buttonText"); }, group: "image" }
];

export const BUILT_IN_SCHEMES: readonly ColorScheme[] = [
  { id: "wupage-light", get name() { return t("mistyTeal"); }, tone: "light", colors: createColors({
    background: "#f7f8f5", surface: "#ffffff", foreground: "#172026", muted: "#647379",
    accent: "#116466", border: "#d7dedb", success: "#25734c", danger: "#b42318"
  }, { "translation-light": "#0f766e", "translation-dark": "#5eead4", "floating-hover": "#0f5557" }) },
  { id: "paper", get name() { return t("warmPaper"); }, tone: "light", colors: createColors({
    background: "#f5f1e8", surface: "#fffdf7", foreground: "#332d25", muted: "#786c5b",
    accent: "#936235", border: "#ddd3c2", success: "#50733d", danger: "#b13f35"
  }, { "translation-dark": "#edc69d", "floating-hover": "#79502a" }) },
  { id: "wupage-dark", get name() { return t("nightTeal"); }, tone: "dark", colors: createColors({
    background: "#151e20", surface: "#202c2e", foreground: "#e7efec", muted: "#a5b8b5",
    accent: "#83d2c5", border: "#3c5050", success: "#8ad4a4", danger: "#ffaaa2"
  }, { "translation-light": "#0f766e", "translation-dark": "#5eead4", "floating-hover": "#a1e4d8" }) },
  { id: "midnight", get name() { return t("midnightBlue"); }, tone: "dark", colors: createColors({
    background: "#151b2b", surface: "#202a40", foreground: "#e6ecfa", muted: "#a4b2d0",
    accent: "#9cbcff", border: "#394866", success: "#8bd5b0", danger: "#ffaaa9"
  }, { "translation-light": "#2563eb", "translation-dark": "#9cbcff", "floating-hover": "#b7ceff" }) },
  { id: "sakura", get name() { return t("cherryBlossom"); }, tone: "light", colors: createColors({
    background: "#fff6f9", surface: "#ffffff", foreground: "#38212d", muted: "#806271",
    accent: "#b33970", border: "#ead4df", success: "#2c734d", danger: "#b4233c"
  }, { "translation-dark": "#f5aacb", "floating-hover": "#92295a" }) },
  { id: "rose-night", get name() { return t("midnightRose"); }, tone: "dark", colors: createColors({
    background: "#241820", surface: "#33232d", foreground: "#f8e7ef", muted: "#c5a9b9",
    accent: "#f0a2c5", border: "#604453", success: "#a0d6ad", danger: "#ffaaa9"
  }, { "translation-light": "#b33970", "translation-dark": "#f0a2c5", "floating-hover": "#f7bfd8" }) },
  { id: "sky-blue", get name() { return t("skyBlue"); }, tone: "light", colors: createColors({
    background: "#f3f8ff", surface: "#ffffff", foreground: "#1c2d45", muted: "#5d708d",
    accent: "#245db5", border: "#d0deef", success: "#267149", danger: "#b42332"
  }, { "translation-dark": "#93c5fd", "floating-hover": "#1b488f" }) },
  { id: "deep-sea", get name() { return t("deepSea"); }, tone: "dark", colors: createColors({
    background: "#101e2b", surface: "#1c2e40", foreground: "#e4f0fa", muted: "#a3b9cc",
    accent: "#82caff", border: "#38536b", success: "#8ed9b4", danger: "#ffb0ab"
  }, { "translation-light": "#245db5", "translation-dark": "#82caff", "floating-hover": "#a6daff" }) },
  { id: "monochrome-light", get name() { return t("chalkWhite"); }, tone: "light", colors: createColors({
    background: "#f5f5f5", surface: "#ffffff", foreground: "#171717", muted: "#666666",
    accent: "#303030", border: "#d6d6d6", success: "#4d4d4d", danger: "#171717"
  }, { "translation-light": "#333333", "translation-dark": "#e0e0e0", "floating-hover": "#4a4a4a" }) },
  { id: "monochrome-dark", get name() { return t("inkBlack"); }, tone: "dark", colors: createColors({
    background: "#121212", surface: "#202020", foreground: "#f1f1f1", muted: "#b3b3b3",
    accent: "#e0e0e0", border: "#484848", success: "#d0d0d0", danger: "#ffffff"
  }, { "translation-light": "#333333", "translation-dark": "#e0e0e0", "floating-hover": "#ffffff" }) }
];

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  popupMenu: DEFAULT_POPUP_MENU,
  mode: "system", floatingOpacity: 100, paragraphHighlightEnabled: true,
  lightSchemeId: "wupage-light", darkSchemeId: "wupage-dark", customSchemes: []
};

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const input = record(value);
  const customSchemes: ColorScheme[] = [];
  for (const candidate of Array.isArray(input.customSchemes) ? input.customSchemes.slice(0, 32) : []) {
    const scheme = record(candidate);
    if (typeof scheme.id !== "string" || !/^custom-[a-z0-9-]{1,80}$/.test(scheme.id)
      || customSchemes.some(entry => entry.id === scheme.id)
      || (scheme.tone !== "light" && scheme.tone !== "dark")) continue;
    const fallback = BUILT_IN_SCHEMES.find(entry => entry.tone === scheme.tone)!;
    const savedColors = record(scheme.colors);
    const base = { ...fallback.colors };
    for (const { key } of COLOR_FIELDS.filter(field => field.group === "interface")) {
      if (isHexColor(savedColors[key])) base[key] = savedColors[key].toLowerCase();
    }
    // Older custom schemes inherited their widget colors from the interface palette.
    const colors = createColors(base);
    for (const { key } of COLOR_FIELDS) {
      if (isHexColor(savedColors[key])) colors[key] = savedColors[key].toLowerCase();
    }
    const savedOpacities = record(scheme.opacities);
    const opacities: ColorScheme["opacities"] = {};
    for (const { key } of COLOR_FIELDS) {
      const value = savedOpacities[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const opacity = Math.max(0, Math.min(100, Math.round(value)));
      if (opacity < 100) opacities[key] = opacity;
    }
    customSchemes.push({ id: scheme.id, tone: scheme.tone, colors,
      ...(Object.keys(opacities).length ? { opacities } : {}),
      name: typeof scheme.name === "string" && scheme.name.trim() ? scheme.name.trim().slice(0, 60) : t("customColors") });
  }
  const all = [...BUILT_IN_SCHEMES, ...customSchemes];
  return {
    popupMenu: normalizePopupMenu(input.popupMenu),
    mode: input.mode === "light" || input.mode === "dark" ? input.mode : "system",
    paragraphHighlightEnabled: input.paragraphHighlightEnabled !== false,
    floatingOpacity: typeof input.floatingOpacity === "number" && Number.isFinite(input.floatingOpacity)
      ? Math.max(0, Math.min(100, Math.round(input.floatingOpacity))) : DEFAULT_APPEARANCE.floatingOpacity,
    lightSchemeId: all.find(entry => entry.id === input.lightSchemeId && entry.tone === "light")?.id ?? DEFAULT_APPEARANCE.lightSchemeId,
    darkSchemeId: all.find(entry => entry.id === input.darkSchemeId && entry.tone === "dark")?.id ?? DEFAULT_APPEARANCE.darkSchemeId,
    customSchemes
  };
}

export function getColorScheme(settings: AppearanceSettings, tone: AppearanceTone): ColorScheme {
  return [...BUILT_IN_SCHEMES, ...settings.customSchemes]
    .find(scheme => scheme.id === (tone === "light" ? settings.lightSchemeId : settings.darkSchemeId) && scheme.tone === tone)
    ?? BUILT_IN_SCHEMES.find(scheme => scheme.tone === tone)!;
}

/** Choose a readable label color for any user-selected accent. */
export function accentForeground(color: string): string {
  const values = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  return luminance > .179 ? "#000000" : "#ffffff";
}

export function schemeColor(scheme: ColorScheme, key: keyof AppearanceColors): string {
  const color = scheme.colors[key];
  const opacity = scheme.opacities?.[key] ?? 100;
  if (opacity === 100) return color;
  const channels = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  return `rgba(${channels.join(", ")}, ${opacity / 100})`;
}

export function applyColorScheme(target: HTMLElement, scheme: ColorScheme): void {
  for (const { key } of COLOR_FIELDS) target.style.setProperty(`--wp-${key}`, schemeColor(scheme, key));
  target.style.setProperty("--wp-on-accent", accentForeground(scheme.colors.accent));
  target.style.setProperty("--wp-on-danger", accentForeground(scheme.colors.danger));
  target.style.setProperty("--wp-color-scheme", scheme.tone);
  target.style.setProperty("--wp-select-arrow", uiIconUrl("arrow-down-03", schemeColor(scheme, "muted")));
  target.style.setProperty("--wp-selection-select-arrow", uiIconUrl("arrow-down-03", schemeColor(scheme, "selection-foreground")));
  target.style.setProperty("--wp-disclosure-icon", uiIconUrl("arrow-down-03"));
  target.style.setProperty("--wp-soft", "color-mix(in srgb, var(--wp-accent) 6%, var(--wp-surface))");
  target.style.setProperty("--wp-selected", "color-mix(in srgb, var(--wp-accent) 12%, var(--wp-surface))");
  target.style.setProperty("--wp-accent-hover", "color-mix(in srgb, var(--wp-accent) 85%, var(--wp-foreground))");
  target.style.setProperty("--wp-danger-soft", "color-mix(in srgb, var(--wp-danger) 8%, var(--wp-surface))");
  target.dataset.wupageTheme = scheme.tone;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function createColors(base: InterfaceColors, overrides: Partial<AppearanceColors> = {}): AppearanceColors {
  return { ...base,
    "floating-background": base.accent, "floating-foreground": accentForeground(base.accent), "floating-hover": base.accent,
    "translation-light": base.accent, "translation-dark": base.accent, "paragraph-highlight": base.accent,
    "selection-trigger": base.accent, "selection-background": base.surface, "selection-foreground": base.foreground,
    "selection-accent": base.accent, "image-button-background": base.accent, "image-button-foreground": accentForeground(base.accent),
    ...overrides
  };
}
