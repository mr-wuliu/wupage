// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPopupMenuLayout, DEFAULT_POPUP_MENU, isPopupMenuLink, normalizePopupMenu, POPUP_MENU_ITEMS } from "../src/shared/popup-menu";
import { normalizeAppearance } from "../src/shared/appearance";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const mount = () => { document.open(); document.write(readFileSync("popup.html", "utf8")); document.close(); };

describe("popup menu preferences", () => {
  it("keeps all entries for older settings and returns independent arrays", () => {
    const layout = normalizeAppearance(undefined).popupMenu;
    expect(layout).toEqual(DEFAULT_POPUP_MENU);
    layout.hidden.push("debug"); layout.order.reverse();
    layout.rows[0].reverse();
    expect(normalizePopupMenu(undefined)).toEqual(DEFAULT_POPUP_MENU);
  });

  it("drops unknown and duplicate IDs, retains explicit hiding and appends missing entries", () => {
    const result = normalizePopupMenu({ order: ["videoTranslation", "videoTranslation", "unknown", null], hidden: ["debug", "debug", "bad"] });
    expect(result.order[0]).toBe("videoTranslation");
    expect(new Set(result.order).size).toBe(POPUP_MENU_ITEMS.length);
    expect(result.hidden).toEqual(["debug"]);
    expect(normalizePopupMenu({ order: "invalid", hidden: false })).toEqual(DEFAULT_POPUP_MENU);
  });

  it("reorders existing controls without replacing their listeners, values or OCR helpers", () => {
    mount();
    const button = document.querySelector<HTMLButtonElement>("#contextMenuTranslation")!;
    const helper = document.querySelector("#ocrModelAction");
    button.disabled = false; button.setAttribute("aria-pressed", "true");
    const clicked = vi.fn(); button.addEventListener("click", clicked);
    const order = [...DEFAULT_POPUP_MENU.order].reverse();
    applyPopupMenuLayout(document, { order, hidden: [] });
    expect([...document.querySelector('[data-popup-menu-grid]')!.children].map(node => (node as HTMLElement).dataset.popupMenuItem))
      .toEqual(order.filter(id => !isPopupMenuLink(id)));
    expect([...document.querySelector('[data-popup-menu-footer]')!.children].map(node => (node as HTMLElement).dataset.popupMenuItem))
      .toEqual(["openGithub", "openWebsite", "openSupport"]);
    expect(document.querySelector("#contextMenuTranslation")).toBe(button);
    expect(document.querySelector("#ocrModelAction")).toBe(helper);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click(); expect(clicked).toHaveBeenCalledOnce();
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU); button.click(); expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("collapses empty groups while keeping settings accessible and preserving feature state", () => {
    mount();
    const video = document.querySelector<HTMLElement>("#videoTranslation")!; video.setAttribute("aria-pressed", "true");
    applyPopupMenuLayout(document, { hidden: DEFAULT_POPUP_MENU.order });
    expect(document.querySelector<HTMLElement>("[data-popup-menu-grid]")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#openOptions")!.hidden).toBe(false);
    expect(video.getAttribute("aria-pressed")).toBe("true");
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(document.querySelector("#videoTranslation")).toBe(video);
    expect(video.hasAttribute("data-popup-menu-hidden")).toBe(false);
  });

  it("respects touch-only paragraph visibility and fills the remaining action row", () => {
    mount();
    const paragraph = document.querySelector<HTMLElement>("#paragraphMode")!;
    paragraph.hidden = true;
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(paragraph.hidden).toBe(true);
    expect(document.querySelector("#pageToggle")!.hasAttribute("data-popup-menu-wide")).toBe(true);
    const hidden = DEFAULT_POPUP_MENU.order.filter(id => id !== "paragraphMode");
    applyPopupMenuLayout(document, { hidden });
    expect(document.querySelector<HTMLElement>('[data-popup-menu-grid]')!.hidden).toBe(true);
    paragraph.hidden = false; applyPopupMenuLayout(document, { hidden });
    expect(document.querySelector<HTMLElement>('[data-popup-menu-grid]')!.hidden).toBe(false);
    expect(paragraph.hasAttribute("data-popup-menu-wide")).toBe(true);
  });

  it("does not mutate an unchanged layout during unrelated settings saves", () => {
    mount(); applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    const observer = new MutationObserver(() => {}); observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    applyPopupMenuLayout(document, DEFAULT_POPUP_MENU);
    expect(observer.takeRecords()).toEqual([]); observer.disconnect();
  });

  it("migrates older orders into rows while fixing links at the bottom and retaining their hidden state", () => {
    expect(normalizePopupMenu({ order: DEFAULT_POPUP_MENU.order, hidden: [] })).toEqual(DEFAULT_POPUP_MENU);
    const layout = normalizePopupMenu({ order: ["openWebsite", "clearCache", "openGithub", "openPdfWorkspace"], hidden: ["openWebsite"] });
    expect(layout.order.slice(-3)).toEqual(["openGithub", "openWebsite", "openSupport"]);
    expect(layout.rows.slice(0, 2)).toEqual([["clearCache"], ["openPdfWorkspace"]]);
    expect(layout.hidden).toEqual(["openWebsite"]);
    expect(layout.rows.flat().some(isPopupMenuLink)).toBe(false);
  });

  it("keeps explicit pairs, cleans malformed rows and excludes hidden entries from geometry", () => {
    const layout = normalizePopupMenu({ rows: [["openPdfWorkspace", "clearCache", "clearCache", "openWebsite"], null,
      ["pageToggle", "floatingBall", "selectionTranslation"]], hidden: ["selectionTranslation"] });
    expect(layout.rows.slice(0, 2)).toEqual([["openPdfWorkspace", "clearCache"], ["pageToggle", "floatingBall"]]);
    expect(layout.rows.every(row => row.length > 0 && row.length <= 2)).toBe(true);
    expect(new Set(layout.order).size).toBe(POPUP_MENU_ITEMS.length);
    expect(layout.rows.flat()).not.toContain("selectionTranslation");
  });

  it("renders a merged long row as two short buttons and expands it again when its partner leaves", () => {
    mount();
    const pdf = document.querySelector<HTMLElement>("#openPdfWorkspace")!, cache = document.querySelector<HTMLElement>("#clearCache")!;
    const paired = normalizePopupMenu({ ...DEFAULT_POPUP_MENU, rows: [["openPdfWorkspace", "clearCache"],
      ...DEFAULT_POPUP_MENU.rows.map(row => row.filter(id => id !== "openPdfWorkspace" && id !== "clearCache"))] });
    applyPopupMenuLayout(document, paired);
    expect(pdf.hasAttribute("data-popup-menu-wide")).toBe(false);
    expect(cache.hasAttribute("data-popup-menu-wide")).toBe(false);
    applyPopupMenuLayout(document, { ...paired, rows: [["openPdfWorkspace"], ["clearCache"],
      ...paired.rows.filter(row => !row.includes("openPdfWorkspace"))] });
    expect(pdf.hasAttribute("data-popup-menu-wide")).toBe(true);
    expect(cache.hasAttribute("data-popup-menu-wide")).toBe(true);
  });
});
