/** Implicit-root intersection observes clipping through nested browsing contexts. */
import { frameIsRendered } from "./frame-visibility";
import { composedParent } from "./dom-roots";
import type { TextSegment } from "./text-segments";

export function segmentViewportRect(segment: TextSegment): DOMRect | undefined {
  const { element, anchor } = segment;
  if (!element.isConnected) return;
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return rect;
  // display:contents has no box even when its text is painted. Measure the
  // source range instead of using the geometry of an unrelated large ancestor.
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(anchor ?? element);
  const bounds = range.getBoundingClientRect?.();
  return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
}

export class DocumentViewport {
  private observer?: IntersectionObserver;
  private visible = new Map<Element, DOMRectReadOnly>();
  private targets = new Map<Element, Element>();
  private tracked = new Set<Element>();
  private order: Element[] = [];
  private positions = new Map<Element, number>();
  readonly ready: Promise<void>;
  private resolveReady = () => {};
  private readyTimer?: ReturnType<typeof setTimeout>;
  get deferred(): boolean { return Boolean(this.observer); }
  constructor(private changed: () => void) {
    this.ready = Promise.resolve();
    if (window !== window.top && typeof IntersectionObserver !== "undefined") {
      this.ready = new Promise(resolve => { this.resolveReady = resolve; });
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
            this.visible.set(entry.target, entry.intersectionRect);
          }
          else this.visible.delete(entry.target);
        }
        clearTimeout(this.readyTimer); this.resolveReady();
        this.changed();
      }, { threshold: 0 });
    }
  }
  update(elements: Element[]): void {
    if (!this.observer) return;
    this.order = elements;
    this.positions.clear();
    elements.forEach((element, index) => { if (!this.positions.has(element)) this.positions.set(element, index); });
    this.targets.clear();
    for (const element of this.positions.keys()) {
      let target: Element | null = element;
      while (target && getComputedStyle(target).display === "contents") target = composedParent(target);
      if (target) this.targets.set(element, target);
    }
    if (!elements.length) this.resolveReady();
    else if (!this.readyTimer) this.readyTimer = setTimeout(this.resolveReady, 250);
    const current = new Set(this.targets.values());
    for (const element of this.tracked) if (!current.has(element)) {
      this.observer.unobserve(element); this.tracked.delete(element); this.visible.delete(element);
    }
    for (const element of current) if (!this.tracked.has(element)) {
      this.tracked.add(element); this.observer.observe(element);
    }
  }
  priority(segment: TextSegment): number | undefined | null {
    if (!frameIsRendered()) return null;
    if (!this.observer) return undefined;
    const { element } = segment;
    const target = this.targets.get(element);
    if (target && target !== element) {
      const visible = this.visible.get(target);
      if (!visible) return null;
      const rect = segmentViewportRect(segment);
      return rect && rect.left < visible.right && rect.right > visible.left
        && rect.top < visible.bottom && rect.bottom > visible.top ? Math.max(0, rect.top) : null;
    }
    if (this.visible.has(element)) return Math.max(0, element.getBoundingClientRect().top);
    // Cross-origin rootMargin is restricted. Prefetch only immediate reading
    // neighbours of an actually intersecting paragraph, never an entire iframe.
    const index = this.positions.get(element) ?? -1;
    const rect = element.getBoundingClientRect();
    const margin = Math.max(240, Math.min(window.innerHeight, 960) * 0.75);
    const neighbour = [this.order[index - 1], this.order[index + 1]].find(candidate => {
      if (!this.visible.has(candidate)) return false;
      const visibleRect = candidate.getBoundingClientRect();
      return rect.top - visibleRect.bottom <= margin && visibleRect.top - rect.bottom <= margin;
    });
    return neighbour ? 100000 + index : null;
  }
  disconnect(): void {
    clearTimeout(this.readyTimer); this.resolveReady(); this.observer?.disconnect();
    this.tracked.clear(); this.visible.clear(); this.targets.clear(); this.positions.clear(); this.order = [];
  }
}
