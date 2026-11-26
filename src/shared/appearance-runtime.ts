import { SETTINGS_KEY } from "./defaults";
import { getColorScheme, normalizeAppearance, setColorSchemeProperties, type ColorScheme } from "./appearance";
import type { ExtensionSettings } from "./types";

export function setupAppearance(value: unknown, { extensionPage = true, live = true, onChange }: {
  extensionPage?: boolean; live?: boolean; onChange?: (scheme: ColorScheme) => void;
} = {}): {
  update: (value: unknown) => void;
  dispose: () => void;
} {
  let appearance = normalizeAppearance(value);
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const root = document.documentElement;
  // Pages can replace the entire inline style on <html> when updating their layout or theme.
  // Keep content tokens in a separate rule without writing to the site's inline styles.
  const sheet = extensionPage ? undefined : new CSSStyleSheet();
  sheet?.insertRule(":root {}");
  const style = sheet ? (sheet.cssRules[0] as CSSStyleRule).style : root.style;
  function paint(): void {
    const tone = appearance.mode === "system" ? media?.matches ? "dark" : "light" : appearance.mode;
    const scheme = getColorScheme(appearance, tone);
    setColorSchemeProperties(style, scheme);
    style.setProperty("--wp-floating-opacity", String(appearance.floatingOpacity / 100));
    style.setProperty("--wp-floating-size", `${appearance.floatingSize}px`);
    if (extensionPage) {
      root.dataset.wupageTheme = tone;
      style.colorScheme = tone;
    }
    onChange?.(scheme);
  }
  function update(value: unknown): void {
    const next = normalizeAppearance(value);
    if (JSON.stringify(next) === JSON.stringify(appearance)) return;
    appearance = next; paint();
  }
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      update((changes[SETTINGS_KEY].newValue as Partial<ExtensionSettings> | undefined)?.appearance);
    }
  };
  const storage = typeof chrome !== "undefined" ? chrome.storage?.onChanged : undefined;
  media?.addEventListener("change", paint);
  if (live) storage?.addListener(changed);
  function dispose(): void {
    media?.removeEventListener("change", paint);
    if (live) storage?.removeListener?.(changed);
    window.removeEventListener("pagehide", onHide);
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(candidate => candidate !== sheet);
  }
  function onHide(event: PageTransitionEvent): void { if (!event.persisted) dispose(); }
  window.addEventListener("pagehide", onHide);
  paint();
  if (sheet) document.adoptedStyleSheets = [...(document.adoptedStyleSheets ?? []), sheet];
  return { update, dispose };
}
