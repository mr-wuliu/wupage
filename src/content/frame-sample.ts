import { frameIsRendered } from "./frame-visibility";
import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
import { discoverShadowRoots, onTranslationRoot, textContainer, translationRoots } from "./dom-roots";
import { createRenderVisibilitySnapshot } from "./visibility";

const EXCLUDED = "script,style,noscript,textarea,input,select,button,pre,code,nav,header,footer,aside,"
  + "[hidden],[aria-hidden='true'],[contenteditable]:not([contenteditable='false']),"
  + "[id^='wupage-'],[data-wupage-video],[data-wupage-video-style],[data-wupage-video-native],.wupage-translation";
const OBSERVE_SAMPLE = { childList: true, subtree: true, characterData: true, attributes: true,
  attributeFilter: ["class", "style", "hidden", "aria-hidden", "lang", "open", "translate", "contenteditable", "slot", "name"] };
const MAX_SAMPLE_NODES = 12000;

/** Read a bounded local language sample from the same trees as page translation. */
export function sampleDocumentText(preferMain = false): string {
  if (!frameIsRendered() || !document.body || !["text/html", "application/xhtml+xml"].includes(document.contentType)) return "";
  const { isElementStyleVisible } = createRenderVisibilitySnapshot();
  const root = preferMain ? [...document.querySelectorAll("main,article,[role='main']")]
    .filter(element => !element.closest(EXCLUDED) && isElementStyleVisible(element))
    .map(element => ({ element, length: element.textContent?.length ?? 0 }))
    .sort((a, b) => b.length - a.length)[0]?.element : undefined;
  const limit = preferMain ? 6000 : 3000;
  let remaining = MAX_SAMPLE_NODES;
  const read = (element: Element) => {
    const iterators = [sampleChildren(element)];
    let text = "";
    while (iterators.length && text.length < limit && remaining > 0) {
      const next = iterators.at(-1)!.next();
      if (next.done) { iterators.pop(); continue; }
      remaining--;
      const node = next.value;
      if (node instanceof Element) {
        if (!node.matches(EXCLUDED)) iterators.push(sampleChildren(node));
      } else if (node instanceof Text && node.data.trim()) {
        const parent = textContainer(node);
        if (parent && !isNonProseElement(parent) && !isTranslationOptedOut(parent) && isElementStyleVisible(parent)) {
          text += `${node.data.trim()}\n`;
        }
      }
    }
    return text.slice(0, limit).trim();
  };
  return (root && read(root)) || read(document.body);
}

function* sampleChildren(element: Element): Generator<Node> {
  if (element instanceof HTMLSlotElement) {
    const assigned = element.assignedNodes();
    if (assigned.length) { yield* assigned; return; }
  }
  const tree = discoverShadowRoots(element, false)[0] ?? element;
  for (let child = tree.firstChild; child; child = child.nextSibling) yield child;
}

export function observeDocumentSample(observer: MutationObserver): () => void {
  for (const root of translationRoots()) observer.observe(root, OBSERVE_SAMPLE);
  const unsubscribe = onTranslationRoot(root => observer.observe(root, OBSERVE_SAMPLE));
  return () => { unsubscribe(); observer.disconnect(); };
}
