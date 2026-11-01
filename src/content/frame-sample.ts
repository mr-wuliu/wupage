/** A bounded local language sample, never an implicit translation request. */
import { frameIsRendered } from "./frame-visibility";
import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
export function sampleDocumentText(): string {
  if (!frameIsRendered() || !document.body || !["text/html", "application/xhtml+xml"].includes(document.contentType)) return "";
  const excluded = "script,style,noscript,textarea,input,select,button,pre,code,nav,header,footer,aside,[hidden],[aria-hidden='true'],[contenteditable]:not([contenteditable='false']),[id^='wupage-'],.wupage-translation";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let text = "";
  let visited = 0;
  while (walker.nextNode() && text.length < 3000 && visited++ < 12000) {
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest(excluded) || isNonProseElement(parent) || isTranslationOptedOut(parent)) continue;
    let rendered = true;
    for (let element: Element | null = parent; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden" || style.opacity === "0") { rendered = false; break; }
    }
    if (rendered) text += `${walker.currentNode.textContent?.trim() ?? ""}\n`;
  }
  return text.slice(0, 3000).trim();
}
