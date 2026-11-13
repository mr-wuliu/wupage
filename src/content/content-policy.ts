import { composedParent } from "./dom-roots";
import { forcedTextRoot, isElementExcluded, matchesElementExclusion } from "./element-exclusions";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const OUTLOOK_HOSTS = new Set([
  "partner.outlook.cn", "outlook.live.com", "outlook.office.com",
  "outlook.office365.com", "outlook.cloud.microsoft"
]);

// These are source documents or application state, rather than readable prose.
// Check ancestors before code/comment and compact-control exceptions apply.
export const NON_PROSE_SELECTOR = "script,style,noscript,textarea,input,select,option,template,"
  + "[contenteditable]:not([contenteditable='false']),[role='textbox']";

export function isTranslationOptedOut(element: Element): boolean {
  let translate: boolean | undefined;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (matchesElementExclusion(current)) return true;
    if (current.classList.contains("notranslate")) return true;
    const value = current.getAttribute("translate")?.toLowerCase();
    // Outlook disables browser translation on the app root. Honor a user's
    // WuPage translation while keeping local opt-outs and user rules intact.
    const outlookRoot = current === current.ownerDocument.documentElement
      && OUTLOOK_HOSTS.has(current.ownerDocument.location?.hostname ?? "");
    if (translate === undefined && value === "no" && !outlookRoot) translate = false;
    if (translate === undefined && (value === "yes" || value === "")) translate = true;
  }
  return translate === false;
}

export function isTextTranslationOptedOut(element: Element, forceRoot = forcedTextRoot(element)): boolean {
  return forceRoot ? isElementExcluded(element) : isTranslationOptedOut(element);
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
