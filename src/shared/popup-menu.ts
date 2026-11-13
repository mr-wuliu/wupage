import { t } from "./i18n";
export const POPUP_MENU_GROUPS = [
  { id: "features", get label() { return t("featureToggles"); } }, { id: "translation", get label() { return t("translationActions"); } },
  { id: "tools", get label() { return t("tools"); } }, { id: "links", get label() { return t("links"); } }
] as const;
export const POPUP_MENU_ITEMS = [
  { id: "contextMenuTranslation", get label() { return t("contextMenu"); }, group: "features" },
  { id: "floatingBall", get label() { return t("floatingButton"); }, group: "features" },
  { id: "selectionTranslation", get label() { return t("selectionTranslation"); }, group: "features" },
  { id: "imageTranslation", get label() { return t("imageTranslation"); }, group: "features" },
  { id: "videoTranslation", get label() { return t("videoSubtitles"); }, group: "features" },
  { id: "pageToggle", get label() { return t("translatePage"); }, group: "translation" },
  { id: "paragraphMode", get label() { return t("paragraphTranslation"); }, group: "translation" },
  { id: "openPdfWorkspace", get label() { return t("openPdf"); }, group: "tools" },
  { id: "debug", label: "Debug", group: "tools" },
  { id: "clearCache", get label() { return t("clearCache"); }, group: "tools" },
  { id: "openGithub", label: "GitHub", group: "links" },
  { id: "openWebsite", get label() { return t("website"); }, group: "links" },
  { id: "openSupport", get label() { return t("supportProject"); }, group: "links" }
] as const;
export type PopupMenuItem = typeof POPUP_MENU_ITEMS[number]["id"];
export const POPUP_MENU_LINKS: readonly PopupMenuItem[] = ["openGithub", "openWebsite", "openSupport"];
export const isPopupMenuLink = (id: PopupMenuItem): boolean => POPUP_MENU_LINKS.includes(id);
export interface PopupMenuLayout { order: PopupMenuItem[]; hidden: PopupMenuItem[]; rows: PopupMenuItem[][] }
export const DEFAULT_POPUP_MENU: PopupMenuLayout = {
  order: POPUP_MENU_ITEMS.map(item => item.id), hidden: [],
  rows: [["contextMenuTranslation", "floatingBall"], ["selectionTranslation", "imageTranslation"], ["videoTranslation"],
    ["pageToggle", "paragraphMode"], ["openPdfWorkspace"], ["debug", "clearCache"]]
};

/** Recover the exact former layout when importing settings without explicit rows. */
function legacyRows(order: PopupMenuItem[]): PopupMenuItem[][] {
  const rows: PopupMenuItem[][] = [];
  let run: PopupMenuItem[] = [];
  const finish = () => { for (let i = 0; i < run.length; i += 2) rows.push(run.slice(i, i + 2)); run = []; };
  for (const id of order) {
    if (id === "videoTranslation" || id === "openPdfWorkspace") { finish(); rows.push([id]); }
    else run.push(id);
  }
  finish(); return rows;
}

export function normalizePopupMenu(value: unknown): PopupMenuLayout {
  const input = value && typeof value === "object" ? value as Partial<PopupMenuLayout> : {};
  const known = new Set<string>(DEFAULT_POPUP_MENU.order);
  const valid = (list: unknown): PopupMenuItem[] => Array.isArray(list)
    ? [...new Set(list.filter((id): id is PopupMenuItem => typeof id === "string" && known.has(id)))] : [];
  const requested = valid(input.order);
  const order = [...requested, ...DEFAULT_POPUP_MENU.order.filter(id => !requested.includes(id))];
  const hidden = valid(input.hidden);
  const sortable = order.filter(id => !isPopupMenuLink(id) && !hidden.includes(id));
  const rows: PopupMenuItem[][] = [], seen = new Set<PopupMenuItem>();
  if (Array.isArray(input.rows)) {
    for (const row of input.rows) {
      const ids = valid(row).filter(id => sortable.includes(id) && !seen.has(id));
      ids.forEach(id => seen.add(id));
      for (let i = 0; i < ids.length; i += 2) rows.push(ids.slice(i, i + 2));
    }
  }
  rows.push(...legacyRows(sortable.filter(id => !seen.has(id))));
  return { rows, hidden, order: [...rows.flat(), ...order.filter(id => hidden.includes(id) && !isPopupMenuLink(id)), ...POPUP_MENU_LINKS] };
}

/** Preserve controls, handlers and capability visibility while applying explicit row geometry. */
export function applyPopupMenuLayout(root: ParentNode, value: unknown): void {
  const layout = normalizePopupMenu(value), hidden = new Set(layout.hidden);
  const grid = root.querySelector<HTMLElement>("[data-popup-menu-grid]");
  if (!grid) return;
  const nodes = new Map([...root.querySelectorAll<HTMLElement>("[data-popup-menu-item]")]
    .map(node => [node.dataset.popupMenuItem as PopupMenuItem, node]));
  const items = layout.order.filter(id => !isPopupMenuLink(id)).map(id => nodes.get(id)).filter((node): node is HTMLElement => !!node);
  for (const [index, node] of items.entries()) {
    const before = grid.children[index];
    if (node !== before) grid.insertBefore(node, before ?? null);
  }
  for (const [id, node] of nodes) {
    node.toggleAttribute("data-popup-menu-hidden", hidden.has(id));
  }
  const rows = layout.rows.map(row => row.map(id => nodes.get(id)).filter((node): node is HTMLElement => !!node && !node.hidden));
  const wide = new Set(rows.filter(row => row.length === 1).flat());
  for (const node of nodes.values()) node.toggleAttribute("data-popup-menu-wide", wide.has(node));
  const gridHidden = !rows.some(row => row.length);
  if (grid.hidden !== gridHidden) grid.hidden = gridHidden;
  const footer = root.querySelector<HTMLElement>("[data-popup-menu-footer]");
  if (footer) {
    const links = POPUP_MENU_LINKS.map(id => nodes.get(id)).filter((node): node is HTMLElement => !!node);
    for (const [index, node] of links.entries()) {
      const before = footer.children[index];
      if (node !== before) footer.insertBefore(node, before ?? null);
    }
    const footerHidden = !links.some(node => !node.hidden && !node.hasAttribute("data-popup-menu-hidden"));
    if (footer.hidden !== footerHidden) footer.hidden = footerHidden;
  }
}
