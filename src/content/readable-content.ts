export const READABLE_ROOT_SELECTOR = [
  "main", "article", "[role='main']", ".markdown-body", ".docblock", "#main-content",
  ".entry-content", ".post-content", ".article-content"
].join(",");

const LAYOUT_DISPLAY = /^(?:inline-)?(?:flex|grid)$/u;
const INLINE_PROSE_SELECTOR = "a,span,b,strong,i,em,u,s,del,ins,mark,small,sub,sup,font,q,abbr,time,code,kbd,samp,br,wbr";

// A div can be a paragraph in either a semantic document or an application.
// Cards containing headings, controls or other blocks need independent segments.
export function isDivProseBlock(element: Element): boolean {
  if (!element.matches("div")
    || element.querySelector(
      "div,p,h1,h2,h3,h4,h5,h6,li,table,ul,ol,blockquote,section,article,header,footer,aside,nav,"
      + "button,input,textarea,select,[role='button'],[role='listitem'],[contenteditable]"
    )) return false;
  if (!element.closest(READABLE_ROOT_SELECTOR)) return isUnmarkedProseBlock(element);
  // Flex/grid children are separate layout fields, even when authored as spans.
  // Merging a title and its author moves the translation out of both fields and
  // loses their typography, links, truncation and alignment.
  const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
  return !LAYOUT_DISPLAY.test(display);
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
  return [...element.querySelectorAll("*")].every(child => child.matches(INLINE_PROSE_SELECTOR)
    && !child.matches("[role],[tabindex],[onclick],[slot],[contenteditable]")
    && (child.matches("br,wbr") || /^(?:inline|contents|none)?$/u.test(view.getComputedStyle(child).display)));
}
