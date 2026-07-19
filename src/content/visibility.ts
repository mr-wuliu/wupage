const MIN_RENDERED_SIZE = 1;
const SAMPLE_INSET = 1;

interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface RenderVisibilitySnapshot {
  isTextNodeVisuallyRendered(node: Text): boolean;
  isElementVisuallyRendered(element: Element): boolean;
}

/**
 * Determines whether a text node currently produces pixels that a user can
 * see. Unlike checking only the parent element, this follows the browser's
 * text layout boxes, ancestor clipping and (inside the viewport) hit testing.
 * Text outside the viewport remains eligible because whole-page translation
 * must also cover content that becomes visible after scrolling.
 */
export function isTextNodeVisuallyRendered(node: Text): boolean {
  return createRenderVisibilitySnapshot().isTextNodeVisuallyRendered(node);
}

export function isElementVisuallyRendered(element: Element): boolean {
  return createRenderVisibilitySnapshot().isElementVisuallyRendered(element);
}

export function createRenderVisibilitySnapshot(): RenderVisibilitySnapshot {
  const renderedElements = new WeakMap<Element, boolean>();
  const elementRects = new WeakMap<Element, RectLike[]>();
  const textRects = new WeakMap<Text, RectLike[]>();

  const isRendered = (element: Element): boolean => {
    const cached = renderedElements.get(element);
    if (cached !== undefined) return cached;
    const rendered = isElementTreeRendered(element, renderedElements);
    renderedElements.set(element, rendered);
    return rendered;
  };

  const readElementRects = (element: Element): RectLike[] => {
    const cached = elementRects.get(element);
    if (cached) return cached;
    const rects = getElementRects(element);
    elementRects.set(element, rects);
    return rects;
  };

  const readTextRects = (node: Text): RectLike[] => {
    const cached = textRects.get(node);
    if (cached) return cached;
    const rects = getTextRects(node, readElementRects);
    textRects.set(node, rects);
    return rects;
  };

  const isRectVisible = (rect: RectLike, host: Element): boolean =>
    isRenderedRectVisible(rect, host, readElementRects);

  return {
    isTextNodeVisuallyRendered(node: Text): boolean {
      const host = node.parentElement;
      return Boolean(
        host &&
        isRendered(host) &&
        readTextRects(node).some((rect) => isRectVisible(rect, host))
      );
    },
    isElementVisuallyRendered(element: Element): boolean {
      return isRendered(element) && readElementRects(element).some(
        (rect) => isRectVisible(rect, element)
      );
    }
  };
}

function isElementTreeRendered(
  element: Element,
  cache?: WeakMap<Element, boolean>
): boolean {
  const checkVisibility = (element as Element & {
    checkVisibility?: (options?: {
      checkOpacity?: boolean;
      checkVisibilityCSS?: boolean;
    }) => boolean;
  }).checkVisibility;
  if (typeof checkVisibility === "function") {
    try {
      if (!checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {
      // Older Chromium builds may expose the method with a narrower signature.
      if (!checkVisibility.call(element)) return false;
    }
  }

  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.contentVisibility === "hidden" ||
    parseOpacity(style.opacity) <= 0
  ) {
    return false;
  }
  const parent = element.parentElement;
  if (!parent) return true;
  const cachedParent = cache?.get(parent);
  if (cachedParent !== undefined) return cachedParent;
  const parentRendered = isElementTreeRendered(parent, cache);
  cache?.set(parent, parentRendered);
  return parentRendered;
}

function getTextRects(
  node: Text,
  readElementRects: (element: Element) => RectLike[]
): RectLike[] {
  const document = node.ownerDocument;
  const range = document.createRange();
  range.selectNodeContents(node);
  const getClientRects = (range as Range & {
    getClientRects?: () => DOMRectList | ArrayLike<DOMRect>;
  }).getClientRects;

  if (typeof getClientRects === "function") {
    const rects = Array.from(getClientRects.call(range));
    range.detach?.();
    return rects.filter(hasRenderedArea);
  }

  range.detach?.();
  return node.parentElement ? readElementRects(node.parentElement) : [];
}

function getElementRects(element: Element): RectLike[] {
  const rects = Array.from(element.getClientRects?.() ?? []).filter(hasRenderedArea);
  if (rects.length) return rects;
  const boundingRect = element.getBoundingClientRect();
  return hasRenderedArea(boundingRect) ? [boundingRect] : [];
}

function isRenderedRectVisible(
  rect: RectLike,
  host: Element,
  readElementRects: (element: Element) => RectLike[]
): boolean {
  const clipped = clipToHiddenAncestors(rect, host, readElementRects);
  if (!clipped || !hasRenderedArea(clipped)) return false;

  const view = host.ownerDocument.defaultView;
  if (!view) return false;
  const viewportWidth = view.innerWidth;
  const viewportHeight = view.innerHeight;
  if (viewportWidth <= 0 || viewportHeight <= 0) return true;

  const viewportRect = makeRect(0, viewportWidth, viewportHeight, 0);
  const inViewport = intersectRects(clipped, viewportRect);
  if (!inViewport) return true;
  return isVisibleAtSamplePoint(inViewport, host);
}

function clipToHiddenAncestors(
  rect: RectLike,
  host: Element,
  readElementRects: (element: Element) => RectLike[]
): RectLike | null {
  const view = host.ownerDocument.defaultView;
  if (!view) return null;
  let visibleRect: RectLike | null = rect;
  let ancestor: Element | null = host;

  while (ancestor && visibleRect) {
    const style = view.getComputedStyle(ancestor);
    const clipsX = clipsOverflow(style.overflowX || style.overflow);
    const clipsY = clipsOverflow(style.overflowY || style.overflow);
    if (clipsX || clipsY) {
      const bounds = readElementRects(ancestor)[0] ?? ancestor.getBoundingClientRect();
      visibleRect = intersectOnAxes(visibleRect, bounds, clipsX, clipsY);
    }
    ancestor = ancestor.parentElement;
  }
  return visibleRect;
}

function isVisibleAtSamplePoint(rect: RectLike, host: Element): boolean {
  const document = host.ownerDocument;
  if (document.defaultView?.getComputedStyle(host).pointerEvents === "none") {
    return true;
  }
  const hitTest = document.elementFromPoint?.bind(document);
  if (!hitTest) return true;

  const left = Math.min(rect.right, rect.left + SAMPLE_INSET);
  const right = Math.max(rect.left, rect.right - SAMPLE_INSET);
  const top = Math.min(rect.bottom, rect.top + SAMPLE_INSET);
  const bottom = Math.max(rect.top, rect.bottom - SAMPLE_INSET);
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const points = [
    [centerX, centerY],
    [left, centerY],
    [right, centerY],
    [centerX, top],
    [centerX, bottom]
  ];

  let producedHit = false;
  for (const [x, y] of points) {
    const hit = hitTest(x, y);
    if (!hit) continue;
    producedHit = true;
    if (hit === host || host.contains(hit) || hit.contains(host)) return true;
  }
  // Some embedded documents return null from hit testing while still laying
  // out text. Do not turn that browser limitation into missing translations.
  return !producedHit;
}

function clipsOverflow(value: string): boolean {
  return value === "hidden" || value === "clip";
}

function intersectOnAxes(
  rect: RectLike,
  bounds: RectLike,
  clipX: boolean,
  clipY: boolean
): RectLike | null {
  const left = clipX ? Math.max(rect.left, bounds.left) : rect.left;
  const right = clipX ? Math.min(rect.right, bounds.right) : rect.right;
  const top = clipY ? Math.max(rect.top, bounds.top) : rect.top;
  const bottom = clipY ? Math.min(rect.bottom, bounds.bottom) : rect.bottom;
  return right > left && bottom > top ? makeRect(top, right, bottom, left) : null;
}

function intersectRects(left: RectLike, right: RectLike): RectLike | null {
  return intersectOnAxes(left, right, true, true);
}

function makeRect(top: number, right: number, bottom: number, left: number): RectLike {
  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function hasRenderedArea(rect: RectLike): boolean {
  return rect.width > MIN_RENDERED_SIZE && rect.height > MIN_RENDERED_SIZE;
}

function parseOpacity(value: string): number {
  const opacity = Number.parseFloat(value);
  return Number.isFinite(opacity) ? opacity : 1;
}
