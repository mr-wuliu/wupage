import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
import { containsElementRuleBoundary } from "./element-exclusions";

export const LINE_BREAK_SOURCE_SELECTOR = "[data-wupage-prose-source]";
const sources = new Set<Element>();
let pendingSources = new WeakMap<Node, Element>();
let pendingMoves = new WeakMap<Node, { from: Element; to: Element }>();
let cleanupQueued = false;
const INLINE = "a,span,b,strong,i,em,u,s,del,ins,mark,small,big,sub,sup,font,q,abbr,time,code,kbd,samp,br";
// Specialized post/description readers already preserve their authored lines.
const EXCLUDED = "pre,code,kbd,samp,nav,header,footer,aside,button,summary,a,[role='button'],[role='navigation'],"
  + ".highlight,.example-wrap,.blob-code,.react-code-text,"
  + "[role='tab'],[role='menuitem'],[tabindex],[onclick],[slot],.wupage-translation,"
  + "[data-testid='tweetText'],[id^='message-content-'],.ytAttributedStringHost,"
  + "ytd-comment-view-model,ytd-comment-renderer,#description," + LINE_BREAK_SOURCE_SELECTOR;

function isInlineProseElement(element: Element): boolean {
  if (!element.matches(INLINE) || element.matches("[role],[tabindex],[onclick],[slot],[contenteditable]")) return false;
  const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
  return !/^(?:block|inline-block|(?:inline-)?(?:flex|grid))$/u.test(display);
}

/**
 * Old journals/fiction use text + BR BR instead of P. Give each paragraph a
 * temporary inline source box so collection, viewport scheduling and rendering
 * share the same boundary. Move original nodes, never clone author markup; the
 * separators stay outside the boxes and clearing restores the exact tree.
 */
export function prepareLineBreakParagraphs(root: Element | ShadowRoot, directTextOnly = false): void {
  const candidates = new Set<Element>(root instanceof Element ? [root] : []);
  if (!directTextOnly) {
    for (const br of root.querySelectorAll("br")) if (br.parentElement) candidates.add(br.parentElement);
  }
  for (const element of candidates) {
    if (!element.matches("div,p,span,section,article,blockquote,td,dd")
      || !Array.from(element.children).some(child => child.matches("br"))
      || element.closest(EXCLUDED) || isNonProseElement(element) || isTranslationOptedOut(element)
      || containsElementRuleBoundary(element)) continue;
    const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
    if (/^(?:inline-)?(?:flex|grid)$/u.test(display)) continue;

    // Do not move layout fields, application owners or framework anchors into
    // prose. Already prepared paragraphs and their output remain untouched.
    const children = Array.from(element.childNodes);
    const ordinary = children.filter(node => !(node instanceof Element
      && (sources.has(node) || node.matches(".wupage-translation"))));
    if (ordinary.some(node => !(node instanceof Text) && (!(node instanceof Element)
      || (!node.matches("br") && !isInlineProseElement(node))
      || Array.from(node.querySelectorAll("*")).some(child => !child.matches("br") && !isInlineProseElement(child))))) continue;

    const runs: ChildNode[][] = [];
    let run: ChildNode[] = [], breaks: ChildNode[] = [], breakCount = 0;
    let hasBoundary = false;
    const flush = () => {
      if (run.some(node => /\p{L}/u.test(node.textContent ?? ""))) runs.push(run);
      run = [];
    };
    const finishBreaks = () => {
      if (breakCount >= 2) { hasBoundary = true; flush(); }
      else run.push(...breaks);
      breaks = []; breakCount = 0;
    };
    for (const node of children) {
      if (node instanceof Element && node.matches("br")) {
        breaks.push(node); breakCount++; continue;
      }
      if (breakCount && node instanceof Text && !node.data.trim()) { breaks.push(node); continue; }
      finishBreaks();
      if (node instanceof Element && (sources.has(node) || node.matches(".wupage-translation"))) flush();
      else run.push(node);
    }
    finishBreaks(); flush();
    if (!hasBoundary || (runs.length < 2 && !children.some(node => node instanceof Element && sources.has(node)))) continue;
    for (const nodes of runs) {
      const source = element.ownerDocument.createElement("span");
      source.setAttribute("data-wupage-prose-source", "");
      pendingSources.set(source, element);
      for (const node of nodes) pendingMoves.set(node, { from: element, to: source });
      nodes[0].before(source);
      source.append(...nodes);
      sources.add(source);
    }
    if (runs.length && !cleanupQueued) {
      cleanupQueued = true;
      // Mutation observers run before this checkpoint. Only these exact moves
      // are ours; future application edits inside the boxes must be rescanned.
      queueMicrotask(() => {
        pendingSources = new WeakMap(); pendingMoves = new WeakMap(); cleanupQueued = false;
      });
    }
  }
}

export function isLineBreakParagraphMutation(record: MutationRecord): boolean {
  return record.type === "childList" && Boolean(record.addedNodes.length || record.removedNodes.length)
    && [...record.addedNodes].every(node => pendingSources.get(node) === record.target
      || pendingMoves.get(node)?.to === record.target)
    && [...record.removedNodes].every(node => pendingMoves.get(node)?.from === record.target);
}

export function clearLineBreakParagraphs(): void {
  for (const source of sources) source.replaceWith(...source.childNodes);
  sources.clear();
}
