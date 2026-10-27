import { isDivProseBlock, READABLE_ROOT_SELECTOR } from "./readable-content";

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
  "#wupage-selection-translator",
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
  const textByBlock = new Map(blocks.map((block) => [block, readSourceText(block, eligible)]));
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
    const index = blocks.findIndex((block) => block === focus || block.contains(focus) || focus.contains(block));
    if (index < 0) continue;
    addExcerpt(textByBlock.get(blocks[index]) ?? "");
    const precedingHeading = blocks
      .slice(0, index + 1)
      .reverse()
      .find((block) => block.matches("h1,h2,h3"));
    if (precedingHeading) addExcerpt(textByBlock.get(precedingHeading) ?? "");
    for (const block of blocks.slice(Math.max(0, index - 2), index + 3)) {
      addExcerpt(textByBlock.get(block) ?? "");
    }
  }

  for (const block of blocks) {
    if (excerptLength >= GLOBAL_EXCERPT_CHARS) break;
    addExcerpt(textByBlock.get(block) ?? "");
  }

  const title = normalizeText(document.title).slice(0, 240);
  const sections = [
    title ? `Page title: ${title}` : "",
    excerpts.length ? `Document excerpts:\n${excerpts.join("\n")}` : ""
  ].filter(Boolean);
  if (!sections.length) return undefined;
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function findReadableRoot(focusElements: Element[]): Element | null {
  for (const focus of focusElements) {
    const root = focus.closest(READABLE_ROOT_SELECTOR);
    if (root) return root;
  }
  return document.querySelector(READABLE_ROOT_SELECTOR);
}

function createContextFilter(): (element: Element) => boolean {
  const cache = new WeakMap<Element, boolean>();
  const eligible = (element: Element): boolean => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    const style = window.getComputedStyle(element);
    const result = !element.matches(`${EXTENSION_OWNED_SELECTOR},nav,[role='navigation'],[aria-hidden='true'],[hidden],`
      + "[contenteditable]:not([contenteditable='false']),textarea,input,script,style,noscript")
      && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && style.contentVisibility !== "hidden" && style.opacity !== "0"
      && (!element.parentElement || eligible(element.parentElement));
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
