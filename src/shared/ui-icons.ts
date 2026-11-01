import icons from "./game-icons/icons.json";
import { setHtmlContent } from "./html";

// Nieobie/game-icon-pack, CC0 1.0. Vendored from b1a5fec8b68c99e7b46484db707610ab2414ad4c.
// Source SVG geometry is unchanged; sizing and accessibility are set for UI use.
export type UiIconName = keyof typeof icons;

/** Use the same local SVG geometry for native controls and CSS masks. */
export function uiIconUrl(name: UiIconName, color = "currentColor"): string {
  const svg = icons[name].replace('fill="currentColor"', `fill="${color}"`);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function uiIconMarkup(name: UiIconName): string {
  return icons[name].replace('<svg ', `<svg class="wupage-icon" data-icon="${name}" aria-hidden="true" focusable="false" style="vertical-align:middle;flex-shrink:0;fill:currentColor;stroke:none;pointer-events:none" `)
    .replace('width="24" height="24"', 'width="1em" height="1em"');
}

/** Populate static HTML placeholders; dynamic controls use uiIconMarkup directly. */
export function renderUiIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-wupage-icon]")) {
    const name = element.dataset.wupageIcon;
    if (name && Object.hasOwn(icons, name)) setHtmlContent(element, uiIconMarkup(name as UiIconName));
  }
}
