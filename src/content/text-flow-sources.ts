import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
import { containsElementRuleBoundary } from "./element-exclusions";
import { TEXT_FLOW_SOURCE_SELECTOR, TextFlowSnapshot, type TextFlow } from "./text-flow";

const sources = new Set<Element>();
let pendingSources = new WeakMap<Node, Element>();
let pendingMoves = new WeakMap<Node, { from: Element; to: Element }>();
let cleanupQueued = false;
// Specialized post/description readers already preserve their authored lines.
const EXCLUDED = "pre,code,kbd,samp,nav,header,footer,aside,button,summary,label,h1,h2,h3,h4,h5,h6,a,[role='button'],[role='navigation'],"
  + ".highlight,.example-wrap,.blob-code,.react-code-text,"
  + "[role='tab'],[role='menuitem'],[tabindex],[onclick],[slot],.wupage-translation,"
  + "[data-testid='tweetText'],[id^='message-content-'],.ytAttributedStringHost,"
  + "ytd-comment-view-model,ytd-comment-renderer,#description,[data-wupage-scientific-source],.MATH," + TEXT_FLOW_SOURCE_SELECTOR;

/** Adapt anonymous ranges to the existing renderer without cloning author nodes. */
export function materializeTextFlow(unit: TextFlow): Element | null {
  if (unit.whole) return unit.container;
  const meaningful = unit.nodes.filter(node => !(node instanceof Text && !node.data.trim()));
  const child = meaningful.length === 1 && meaningful[0];
  if (child instanceof Element && new TextFlowSnapshot().isWhole(child)) return child;
  const element = unit.container;
  if (element.closest(EXCLUDED) || isNonProseElement(element) || isTranslationOptedOut(element)
    || containsElementRuleBoundary(element) || [...element.childNodes].some(node => node.nodeType === Node.COMMENT_NODE)
    || /^(?:(?:inline-)?(?:flex|grid|table)|table-(?:row|row-group|header-group|footer-group))$/u.test(getComputedStyle(element).display)
    || unit.nodes.some(node => node.parentNode !== element)) return null;
  return wrapProseSource(element, [...unit.nodes]);
}

function wrapProseSource(element: Element, nodes: ChildNode[]): Element {
  const source = element.ownerDocument.createElement("span");
  source.setAttribute("data-wupage-prose-source", "");
  pendingSources.set(source, element);
  for (const node of nodes) pendingMoves.set(node, { from: element, to: source });
  nodes[0].before(source);
  source.append(...nodes);
  sources.add(source);
  if (!cleanupQueued) {
    cleanupQueued = true;
    // Mutation observers see these exact moves before this checkpoint. Later
    // application edits inside the source boxes must still be rescanned.
    queueMicrotask(() => {
      pendingSources = new WeakMap(); pendingMoves = new WeakMap(); cleanupQueued = false;
    });
  }
  return source;
}

export function prepareTextFlowParagraphs(root: Element | ShadowRoot, directTextOnly = false): void {
  const snapshot = new TextFlowSnapshot();
  const candidates = [
    ...(root instanceof Element ? [root] : []),
    ...(!directTextOnly ? root.querySelectorAll("*") : [])
  ];
  for (const element of candidates.reverse()) {
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || !element.childNodes.length || element.closest(EXCLUDED)) continue;
    for (const unit of snapshot.units(element)) if (!unit.whole) materializeTextFlow(unit);
  }
}

export function isTextFlowMutation(record: MutationRecord): boolean {
  return record.type === "childList" && Boolean(record.addedNodes.length || record.removedNodes.length)
    && [...record.addedNodes].every(node => pendingSources.get(node) === record.target
      || pendingMoves.get(node)?.to === record.target)
    && [...record.removedNodes].every(node => pendingMoves.get(node)?.from === record.target);
}

export function clearTextFlowSources(): void {
  for (const source of sources) source.replaceWith(...source.childNodes);
  sources.clear();
}
