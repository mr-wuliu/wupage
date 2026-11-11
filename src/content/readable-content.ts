import { TextFlowSnapshot } from "./text-flow";

export const READABLE_ROOT_SELECTOR = [
  "main", "article", "[role='main']", ".markdown-body", ".docblock", "#main-content",
  ".entry-content", ".post-content", ".article-content"
].join(",");

const LAYOUT_DISPLAY = /^(?:inline-)?(?:flex|grid)$/u;

// A div can be a paragraph in either a semantic document or an application.
// Cards containing headings, controls or other blocks need independent segments.
export function isDivProseBlock(element: Element): boolean {
  if (!element.matches("div")
    || element.querySelector(
      "button,input,textarea,select,[role='button'],[role='listitem'],[contenteditable]"
    )) return false;
  if (!element.closest(READABLE_ROOT_SELECTOR)) return isUnmarkedProseBlock(element);
  // Flex/grid children are separate layout fields, even when authored as spans.
  // Merging a title and its author moves the translation out of both fields and
  // loses their typography, links, truncation and alignment.
  return new TextFlowSnapshot().isWhole(element);
}

// Many application pages use plain divs or spans for sentences with links and
// formatting. Keep their runs together when they share an inline flow.
export function isUnmarkedProseBlock(element: Element): boolean {
  if (!element.firstElementChild || !element.matches("div,span") || element.matches("[role],[contenteditable]")) return false;
  const view = element.ownerDocument.defaultView;
  if (!view || LAYOUT_DISPLAY.test(view.getComputedStyle(element).display)) return false;
  // Keep explicit lines inside their existing flex or grid column.
  if (element.parentElement && element.querySelector("br")
    && LAYOUT_DISPLAY.test(view.getComputedStyle(element.parentElement).display)) return false;
  if (element.children.length === 1 && !element.firstElementChild.matches("br,wbr")
    && ![...element.childNodes].some(node => node instanceof Text && /\S/u.test(node.data))) return false;
  return new TextFlowSnapshot().isWhole(element);
}
