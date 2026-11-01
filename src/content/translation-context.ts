import { isDivProseBlock, READABLE_ROOT_SELECTOR } from "./readable-content";
import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
import { composedParent } from "./dom-roots";

const CONTEXT_BLOCK_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "caption",
  "dt",
  "dd"
].join(",");
const EXTENSION_OWNED_SELECTOR = [
  ".wupage-translation",
  "#wupage-floating-hitbox",
  "#wupage-floating-menu",
  "#wupage-debug-panel",
  "#wupage-paragraph-highlight"
].join(",");
const MAX_CONTEXT_CHARS = 2400;
const GLOBAL_EXCERPT_CHARS = 1700;

export function buildTranslationContext(focusElements: Element[] = []): string | undefined {
  const root = findReadableRoot(focusElements) ?? document.body;
  if (!root) return undefined;

  const eligible = createContextFilter();
  const blocks = [root, ...root.querySelectorAll<HTMLElement>(`${CONTEXT_BLOCK_SELECTOR},div`)]
    .filter((element) => element.matches(CONTEXT_BLOCK_SELECTOR) || isDivProseBlock(element))
    .filter(eligible);
  // Reading every block's text up front was the single most expensive part of
  // building context: a document-order walk per block on a long article. Only
  // the excerpts that survive de-duplication are ever used, so resolve text on
  // demand instead.
  const textByBlock = new Map<Element, string>();
  const textOf = (block: Element): string => {
    const cached = textByBlock.get(block);
    if (cached !== undefined) return cached;
    const text = readSourceText(block, eligible);
    textByBlock.set(block, text);
    return text;
  };
  const indexByBlock = new Map<Element, number>();
  blocks.forEach((block, index) => { if (!indexByBlock.has(block)) indexByBlock.set(block, index); });
  const excerpts: string[] = [];
  const seen = new Set<string>();
  let excerptLength = 0;

  const addExcerpt = (value: string): void => {
    const text = normalizeText(value).slice(0, MAX_CONTEXT_CHARS - 280 - excerptLength);
    if (text.length < 2 || seen.has(text)) return;
    seen.add(text);
    excerpts.push(text);
    excerptLength += text.length;
  };

  for (const focus of focusElements) {
    const index = findFocusBlockIndex(focus, blocks, indexByBlock);
    if (index < 0) continue;
    addExcerpt(textOf(blocks[index]));
    let precedingHeading: Element | undefined;
    for (let scan = index; scan >= 0; scan -= 1) {
      if (blocks[scan].matches("h1,h2,h3")) { precedingHeading = blocks[scan]; break; }
    }
    if (precedingHeading) addExcerpt(textOf(precedingHeading));
    for (const block of blocks.slice(Math.max(0, index - 2), index + 3)) {
      addExcerpt(textOf(block));
    }
  }

  for (const block of blocks) {
    if (excerptLength >= GLOBAL_EXCERPT_CHARS) break;
    addExcerpt(textOf(block));
  }

  const title = normalizeText(document.title).slice(0, 240);
  const sections = [
    title ? `Page title: ${title}` : "",
    excerpts.length ? `Document excerpts:\n${excerpts.join("\n")}` : ""
  ].filter(Boolean);
  if (!sections.length) return undefined;
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

/**
 * The first block in document order that is the focus, contains it, or sits
 * inside it. Ancestors always come first in document order, so the outermost
 * mapped ancestor answers the common case without scanning the block list.
 */
function findFocusBlockIndex(
  focus: Element,
  blocks: Element[],
  indexByBlock: Map<Element, number>
): number {
  let ancestor: Element | null = focus.parentElement;
  let ancestorIndex = -1;
  while (ancestor) {
    const index = indexByBlock.get(ancestor);
    if (index !== undefined) ancestorIndex = index;
    ancestor = ancestor.parentElement;
  }
  if (ancestorIndex >= 0) return ancestorIndex;
  const own = indexByBlock.get(focus);
  if (own !== undefined) return own;
  return blocks.findIndex((block) => focus.contains(block));
}

function findReadableRoot(focusElements: Element[]): Element | null {
  for (const focus of focusElements) {
    const root = focus.closest(READABLE_ROOT_SELECTOR);
    if (root) return root;
    if (focus.getRootNode() instanceof ShadowRoot) return focus.parentElement ?? focus;
  }
  return document.querySelector(READABLE_ROOT_SELECTOR);
}

function createContextFilter(): (element: Element) => boolean {
  const cache = new WeakMap<Element, boolean>();
  const eligible = (element: Element): boolean => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    const style = window.getComputedStyle(element);
    const parent = composedParent(element);
    const result = !isNonProseElement(element) && !isTranslationOptedOut(element)
      && !element.matches(`${EXTENSION_OWNED_SELECTOR},nav,[role='navigation'],[aria-hidden='true'],[hidden],`
      + "[contenteditable]:not([contenteditable='false']),textarea,input,script,style,noscript")
      && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && style.contentVisibility !== "hidden" && style.opacity !== "0"
      && (!parent || eligible(parent));
    cache.set(element, result);
    return result;
  };
  return eligible;
}

function readSourceText(element: Element, eligible: (element: Element) => boolean): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement && eligible(node.parentElement)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
  return normalizeText(parts.join(""));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
