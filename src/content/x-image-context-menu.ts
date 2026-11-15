import { t } from "../shared/i18n";
import { setHtmlContent } from "../shared/html";
import { uiIconMarkup } from "../shared/ui-icons";
import { visibleViewport } from "../shared/touch";

export interface ContextImageTarget { image: HTMLImageElement; source: string }

const PHOTO = '[data-testid="tweetPhoto"]';
const COPY_ITEM = '[data-testid="copyPhotoLinkContextMenuItem"]';
const ITEM_ID = "wupage-x-image-menu-item";

function isX(): boolean { return /^(?:www\.)?(?:x|twitter)\.com$/i.test(location.hostname); }

/** X's visible pixels may be a background sibling of a transparent img. */
export function findXContextImage(event: MouseEvent): HTMLImageElement | undefined {
  if (!isX()) return;
  for (const node of event.composedPath()) {
    if (node instanceof Element) {
      const image = node.closest(PHOTO)?.querySelector("img");
      if (image) return image;
    }
  }
}

/** Extend only X's photo menu, leaving native browser menus and other X menus alone. */
export function createXImageContextMenu(translate: (target: ContextImageTarget) => Promise<unknown>): {
  open: (event: MouseEvent, target?: ContextImageTarget) => void;
  close: () => void;
} | undefined {
  if (!isX()) return;
  let stop = () => {};
  return { close: () => stop(), open(event, target) {
    stop();
    if (!target) return;
    const selected = target;
    let active = true;
    let item: HTMLButtonElement | undefined;
    let menu: HTMLElement | undefined;
    let restoreMenu = () => {};
    const events = new AbortController();
    const observer = new MutationObserver(sync);
    const timeout = window.setTimeout(() => { if (!item) close(); }, 2000);
    // Browser event dispatch can run a microtask checkpoint between the
    // extension's capture listener and the site's delegated page listener.
    const afterEvent = window.setTimeout(() => { if (!event.defaultPrevented) close(); else sync(); }, 0);

    function close(): void {
      if (!active) return;
      active = false;
      observer.disconnect(); events.abort(); window.clearTimeout(timeout); window.clearTimeout(afterEvent);
      item?.remove(); restoreMenu();
    }
    stop = close;

    function sync(): void {
      if (!active) return;
      // This runs after the page's contextmenu handlers, including React's
      // delegated listener. An ordinary browser menu requires no injection.
      if (!event.defaultPrevented) return;
      if (!selected.image.isConnected
        || (selected.image.currentSrc || selected.image.src) !== selected.source) { close(); return; }
      const native = [...document.querySelectorAll<HTMLElement>(COPY_ITEM)].find(visible);
      const nextMenu = native?.closest<HTMLElement>('[role="menu"]');
      if (!native || !nextMenu) { if (item) close(); return; }
      if (item?.isConnected && menu === nextMenu) return;
      item?.remove(); restoreMenu();
      menu = nextMenu;
      item = document.createElement("button");
      item.id = ITEM_ID; item.type = "button"; item.setAttribute("role", "menuitem");
      item.setAttribute("translate", "no"); item.tabIndex = 0;
      const text = native.querySelector<HTMLElement>('[dir]') ?? native;
      const css = window.getComputedStyle(text);
      item.style.cssText = "all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;"
        + "width:100%;min-height:44px;padding:12px 16px;cursor:pointer;overflow-wrap:anywhere;";
      item.style.font = css.font || "700 15px/20px system-ui,sans-serif";
      item.style.color = css.color;
      const icon = document.createElement("span"); icon.style.cssText = "display:flex;flex:0 0 20px;font-size:20px";
      setHtmlContent(icon, uiIconMarkup("font"));
      const label = document.createElement("span"); label.textContent = t("translateImage");
      item.append(icon, label);
      const highlight = () => { item!.style.backgroundColor = `color-mix(in srgb, ${css.color} 8%, transparent)`; };
      const unhighlight = () => { item!.style.backgroundColor = "transparent"; };
      item.addEventListener("pointerenter", highlight);
      item.addEventListener("pointerleave", () => { if (document.activeElement !== item) unhighlight(); });
      item.addEventListener("focus", highlight); item.addEventListener("blur", unhighlight);
      item.addEventListener("click", click => {
        click.preventDefault(); click.stopPropagation();
        if (!active) return;
        // Escape uses X's own dismissal/focus handling; never click its copy
        // action or replace the site's menu/backdrop to close the popup.
        native.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        close();
        void translate(selected);
      });
      native.after(item);
      restoreMenu = fitMenu(menu);
    }

    document.addEventListener("pointerdown", pointer => {
      if (!(pointer.target instanceof Node) || !menu?.contains(pointer.target)) close();
    }, { capture: true, signal: events.signal });
    document.addEventListener("keydown", key => {
      if (key.key === "Escape") { window.setTimeout(close, 0); return; }
      if (!(key.target instanceof Element) || !menu?.contains(key.target)) return;
      const directions: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 };
      if (!(key.key in directions)) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .filter(candidate => visible(candidate) && candidate.getAttribute("aria-disabled") !== "true");
      const current = items.indexOf(key.target.closest<HTMLElement>('[role="menuitem"]')!);
      const next = key.key === "Home" ? 0 : key.key === "End" ? items.length - 1
        : (current + directions[key.key] + items.length) % items.length;
      if (!items[next]) return;
      key.preventDefault(); key.stopPropagation(); items[next].focus();
    }, { capture: true, signal: events.signal });
    window.addEventListener("blur", close, { signal: events.signal });
    window.addEventListener("resize", close, { signal: events.signal });
    window.addEventListener("scroll", scroll => {
      if (!(scroll.target instanceof Node) || !menu?.contains(scroll.target)) close();
    }, { capture: true, passive: true, signal: events.signal });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden", "src", "srcset", "sizes"] });
  } };
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
  const css = window.getComputedStyle(element);
  return css.display !== "none" && css.visibility !== "hidden" && css.visibility !== "collapse";
}

function fitMenu(menu: HTMLElement): () => void {
  const styles = new Map<string, { original: string; priority: string; applied: string }>();
  const set = (property: string, value: string) => {
    const original = menu.style.getPropertyValue(property), priority = menu.style.getPropertyPriority(property);
    menu.style.setProperty(property, value);
    styles.set(property, { original, priority, applied: menu.style.getPropertyValue(property) });
  };
  const view = visibleViewport();
  set("max-width", `${Math.max(1, view.width - 16)}px`);
  set("max-height", `${Math.max(1, view.height - 16)}px`);
  set("overflow-y", "auto");
  const rect = menu.getBoundingClientRect();
  const dx = Math.max(view.left + 8, Math.min(rect.left, view.right - rect.width - 8)) - rect.left;
  const dy = Math.max(view.top + 8, Math.min(rect.top, view.bottom - rect.height - 8)) - rect.top;
  if (dx || dy) set("transform", `translate(${dx}px,${dy}px) ${menu.style.transform}`.trim());
  return () => {
    for (const [property, value] of styles) {
      if (menu.style.getPropertyValue(property) !== value.applied) continue;
      if (value.original) menu.style.setProperty(property, value.original, value.priority);
      else menu.style.removeProperty(property);
    }
  };
}
