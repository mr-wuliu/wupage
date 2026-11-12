import { translationOwner } from "./translation-boundaries";
import { TWITCH_MESSAGE_BODY_SELECTOR } from "./twitch-content";

export const TEXT_FLOW_SOURCE_SELECTOR = "[data-wupage-prose-source]";
const OUTPUT = ".wupage-translation";
const ATOMIC_INLINE = "br,wbr,code,kbd,samp,math,svg,img,ruby";
const NON_CONTENT = "script,style,noscript,template,input,textarea,select,iframe,video,audio,canvas";
const INLINE_FALLBACK = "a,span,b,strong,i,em,u,s,del,ins,mark,small,big,sub,sup,font,q,abbr,time,code,kbd,samp,br,wbr,ruby";
// These readers own authored lines/attributed text and must not be absorbed by
// an otherwise inline outer wrapper. They still use the shared source lifecycle.
const CONTENT_OWNER = "[data-testid='tweetText'],[id^='message-content-'],[data-wupage-scientific-source],"
  + ".ytAttributedStringHost,ytd-comment-view-model #content-text,ytd-comment-renderer #content-text,"
  + TWITCH_MESSAGE_BODY_SELECTOR;

/** A contiguous authored range, which need not have an element of its own. */
export interface TextFlow {
  readonly container: Element;
  readonly nodes: readonly ChildNode[];
  readonly whole: boolean;
}

/** One synchronous layout snapshot; discard it after host mutations or a yield. */
export class TextFlowSnapshot {
  private readonly displays = new WeakMap<Element, string>();
  private readonly partitions = new WeakMap<Element, TextFlow[]>();
  private readonly inlineTrees = new WeakMap<Element, boolean>();

  hasIndependentItems(element: Element, allowEmpty = false): boolean {
    const layout = /^(?:(?:inline-)?(?:flex|grid|table)|table-(?:row|row-group|header-group|footer-group))$/u.test(this.display(element));
    // A clickable sentence remains one label even when its emphasis is laid
    // out with flex. Container layouts without that ownership keep their items.
    const label = element.matches("a[href],button,label")
      && [...element.childNodes].some(node => node instanceof Text && (allowEmpty || /\p{L}/u.test(node.data)));
    return layout && !label;
  }

  display(element: Element): string {
    let display = this.displays.get(element);
    if (display === undefined) {
      display = element.ownerDocument.defaultView?.getComputedStyle(element).display
        || (element.matches(INLINE_FALLBACK) ? "inline" : "block");
      this.displays.set(element, display);
    }
    return display;
  }

  isInlineTree(element: Element): boolean {
    const cached = this.inlineTrees.get(element);
    if (cached !== undefined) return cached;
    // Source atoms keep their existing protection protocol and original nodes.
    if (element.matches(ATOMIC_INLINE)) return element.matches("br,wbr,math,svg") || this.display(element) !== "block";
    const inline = !element.matches(NON_CONTENT) && !element.matches(`${TEXT_FLOW_SOURCE_SELECTOR},${CONTENT_OWNER}`)
      && translationOwner(element) !== element
      && /^(?:inline|contents|none)$/u.test(this.display(element))
      && [...element.children].every(child => child.matches(OUTPUT) || this.isInlineTree(child));
    this.inlineTrees.set(element, inline);
    return inline;
  }

  /** Partition the container's direct children, descending into formatting only. */
  units(container: Element): readonly TextFlow[] {
    const cached = this.partitions.get(container);
    if (cached) return cached;
    const units: TextFlow[] = [];
    let run: ChildNode[] = [], breaks: ChildNode[] = [], breakCount = 0, divided = false;
    const flush = (beforeBlock = false) => {
      // A BR before a new block separates blocks rather than adding a blank
      // translated line. Keep such original separators outside anonymous runs.
      if (beforeBlock) {
        let end = run.length;
        while (end && run[end - 1] instanceof Text && !run[end - 1].textContent?.trim()) end--;
        while (end && run[end - 1] instanceof Element && (run[end - 1] as Element).matches("br")) {
          run.splice(--end); divided = true;
          while (end && run[end - 1] instanceof Text && !run[end - 1].textContent?.trim()) end--;
        }
      }
      if (run.some(node => /\p{L}/u.test(node.textContent ?? ""))) {
        units.push({ container, nodes: run, whole: false });
      }
      run = [];
    };
    const finishBreaks = () => {
      if (breakCount >= 2) { divided = true; flush(); }
      else run.push(...breaks);
      breaks = []; breakCount = 0;
    };
    const layout = this.hasIndependentItems(container)
      || (container === container.ownerDocument.body
        && ![...container.childNodes].some(node => node instanceof Text && /\p{L}/u.test(node.data)));
    for (const node of container.childNodes) {
      if (node instanceof Element && node.matches(OUTPUT)) continue;
      if (node instanceof Element && node.matches("br") && this.display(node) !== "none") {
        breaks.push(node); breakCount++; continue;
      }
      if (breakCount && node instanceof Text && !node.data.trim()) { breaks.push(node); continue; }
      finishBreaks();
      if (node instanceof Text) run.push(node);
      else if (node instanceof Element && !layout && this.isInlineTree(node)) run.push(node);
      else { divided = true; flush(true); }
    }
    finishBreaks(); flush();
    if (!divided && units.length === 1 && container !== container.ownerDocument.body) {
      units[0] = { ...units[0], whole: true };
    }
    this.partitions.set(container, units);
    return units;
  }

  isWhole(element: Element, allowEmpty = false): boolean {
    const known = this.partitions.get(element);
    if (known && !allowEmpty) return known.length === 1 && known[0].whole;
    if (element === element.ownerDocument.body) return false;
    if (this.hasIndependentItems(element, allowEmpty) && element.firstElementChild) return false;
    // Reject document/layout wrappers at their first independent child, before
    // visiting thousands of siblings or reading all their computed styles.
    let breaks = 0;
    for (const child of element.childNodes) {
      if (child instanceof Element && child.matches(OUTPUT)) continue;
      if (child instanceof Element && child.matches("br") && this.display(child) !== "none") {
        if (++breaks >= 2) return false;
      } else if (!(child instanceof Text && !child.data.trim())) {
        breaks = 0;
        if (child instanceof Element && !this.isInlineTree(child)) return false;
        if (!(child instanceof Element || child instanceof Text)) return false;
      }
    }
    return allowEmpty || /\p{L}/u.test(element.textContent ?? "");
  }

  /** The nearest layout flow wins over an outer P, cell, list or wrapper. */
  containing(node: Node): TextFlow | null {
    let element = node instanceof Element ? node : node.parentElement;
    const source = element?.closest(TEXT_FLOW_SOURCE_SELECTOR);
    if (source) return { container: source, nodes: [...source.childNodes], whole: true };
    while (element) {
      const display = this.display(element);
      const parentLayout = element.parentElement && this.hasIndependentItems(element.parentElement);
      const authoredLines = [...element.children].some(child => child.matches("br"))
        && element.parentElement && [...element.parentElement.childNodes].every(child => child === element || !child.textContent?.trim());
      const mixedInline = /^(?:inline|contents)$/u.test(display) && !this.isInlineTree(element);
      if (!/^(?:inline|contents|none)$/u.test(display) || mixedInline || parentLayout || authoredLines || translationOwner(element) === element) {
        const units = this.units(element);
        const unit = units.find(unit => unit.nodes.some(child => child === node || child.contains(node)))
          ?? (node === element ? units[0] : undefined);
        if (unit) {
          const meaningful = unit.nodes.filter(child => !(child instanceof Text && !child.data.trim()));
          const child = meaningful.length === 1 && meaningful[0];
          // A pre-existing inline box can own an otherwise anonymous range.
          if (!unit.whole && child instanceof Element && this.isWhole(child)) {
            return { container: child, nodes: [...child.childNodes], whole: true };
          }
          return unit;
        }
        if (node === element && element.firstElementChild?.matches(TEXT_FLOW_SOURCE_SELECTOR)) {
          const source = element.firstElementChild;
          return { container: source, nodes: [...source.childNodes], whole: true };
        }
        return null;
      }
      element = element.parentElement;
    }
    return null;
  }

  block(node: Node): Element | null {
    const unit = this.containing(node);
    return unit?.whole ? unit.container : null;
  }
}

/** Native hit testing disambiguates multiple bare ranges in the same element. */
export function textNodeAtPoint(document: Document, x: number, y: number): Text | null {
  const api = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const node = api.caretPositionFromPoint?.(x, y)?.offsetNode
    ?? api.caretRangeFromPoint?.(x, y)?.startContainer;
  return node instanceof Text ? node : null;
}
