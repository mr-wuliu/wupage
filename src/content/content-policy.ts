import { composedParent } from "./dom-roots";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// These are source documents or application state, rather than readable prose.
// Check ancestors before code/comment and compact-control exceptions apply.
export const NON_PROSE_SELECTOR = "script,style,noscript,textarea,input,select,option,template,"
  + "[contenteditable]:not([contenteditable='false']),[role='textbox']";

export function isTranslationOptedOut(element: Element): boolean {
  let translate: boolean | undefined;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.classList.contains("notranslate")) return true;
    const value = current.getAttribute("translate")?.toLowerCase();
    if (translate === undefined && value === "no") translate = false;
    if (translate === undefined && (value === "yes" || value === "")) translate = true;
  }
  return translate === false;
}

export function isNonProseElement(element: Element): boolean {
  if (element.namespaceURI !== HTML_NAMESPACE) return true;
  for (let current: Element | null = element; current; ) {
    if (current.closest(NON_PROSE_SELECTOR)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}
