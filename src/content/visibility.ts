import { composedContains, isTopLayer, renderedContains, renderedParent, textContainer } from "./dom-roots";
import { basicShapeClip } from "./paint-clips";
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

interface AncestorClip {
  x: boolean;
  y: boolean;
  parent: Element | null;
  marginX: number;
  marginY: number;
  paintParent: Element | null;
  shape: (rect: RectLike) => RectLike | null;
}

export interface RenderVisibilitySnapshot {
  isElementStyleVisible(element: Element): boolean;
  isTextNodeVisuallyRendered(node: Text): boolean;
  isElementVisuallyRendered(element: Element): boolean;
  /**
   * Per-snapshot memo for caller-side element decisions such as skip selectors.
   * A snapshot describes one point in time, so anything derived from it stays
   * valid for the snapshot's lifetime and is dropped together with it.
   */
  readonly decisions: WeakMap<Element, boolean>;
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

export function createRenderVisibilitySnapshot(onOccluded?: (blockers: Set<Element>) => void): RenderVisibilitySnapshot {
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const paintedTrees = new WeakMap<Element, boolean>();
  const elementRects = new WeakMap<Element, RectLike[]>();
  const textRects = new WeakMap<Text, RectLike[]>();
  const ancestorClips = new WeakMap<Element, AncestorClip>();
  const decisions = new WeakMap<Element, boolean>();
  const parents = new WeakMap<Element, Element | null>();
  const topLayers = new WeakMap<Element, boolean>();
  const parentOf = (element: Element): Element | null => {
    if (!parents.has(element)) parents.set(element, renderedParent(element));
    return parents.get(element)!;
  };
  const inTopLayer = (element: Element): boolean => {
    if (!topLayers.has(element)) topLayers.set(element, isTopLayer(element));
    return topLayers.get(element)!;
  };

  const readStyle = (element: Element): CSSStyleDeclaration | undefined => {
    const cached = styles.get(element);
    if (cached) return cached;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style) styles.set(element, style);
    return style;
  };
  const paintsDescendants = (element: Element): boolean => {
    const cached = paintedTrees.get(element);
    if (cached !== undefined) return cached;
    const style = readStyle(element);
    const parent = parentOf(element);
    // Top-layer boxes escape ancestor painting effects, but a display:none
    // ancestor still prevents their box tree from being generated.
    const ancestorsPaint = () => {
      if (!inTopLayer(element)) return !parent || paintsDescendants(parent);
      for (let ancestor = parent; ancestor; ancestor = parentOf(ancestor)) {
        if (readStyle(ancestor)?.display === "none") return false;
      }
      return true;
    };
    const paints = Boolean(style && style.display !== "none" && style.contentVisibility !== "hidden"
      && parseOpacity(style.opacity) > 0 && ancestorsPaint());
    paintedTrees.set(element, paints);
    return paints;
  };
  // Computed visibility already includes inheritance. A visible child can
  // override a hidden parent, unlike display:none or zero ancestor opacity.
  const isRendered = (element: Element): boolean => {
    const style = readStyle(element);
    return Boolean(style && style.visibility !== "hidden" && style.visibility !== "collapse" && paintsDescendants(element));
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

  // getComputedStyle is the most expensive call in a full-page scan, and every
  // text node under the same container re-reads the same ancestors.
  const readAncestorClip = (element: Element): AncestorClip => {
    const cached = ancestorClips.get(element);
    if (cached) return cached;
    const style = readStyle(element);
    let parent = inTopLayer(element) ? null : parentOf(element);
    if (!inTopLayer(element) && (style?.position === "fixed" || style?.position === "absolute")) {
      // Positioned descendants escape overflow between themselves and their
      // containing block. A viewport-fixed reader can outgrow a zero-height
      // page wrapper; transformed/contained readers still obey their block.
      while (parent) {
        const parentStyle = readStyle(parent);
        if (parentStyle && establishesContainingBlock(parent, parentStyle, style.position === "fixed")) break;
        parent = parentOf(parent);
      }
    }
    const overflowX = style?.overflowX || style?.overflow || "visible";
    const overflowY = style?.overflowY || style?.overflow || "visible";
    const containsPaint = Boolean(style && canContainPaint(style) && /\b(?:paint|strict|content)\b/u.test(style.contain));
    const viewportOverflow = element === element.ownerDocument.documentElement || isViewportBody(element, readStyle);
    const clips = Boolean(style && canClipOverflow(element, style) && !viewportOverflow);
    const margin = Number.parseFloat(style?.getPropertyValue?.("overflow-clip-margin")?.match(/(?:^|\s)([\d.]+)px\s*$/u)?.[1] ?? "0");
    const clip: AncestorClip = {
      x: containsPaint || clips && clipsOverflow(overflowX), y: containsPaint || clips && clipsOverflow(overflowY), parent,
      marginX: overflowX === "clip" || containsPaint && overflowX === "visible" ? margin : 0,
      marginY: overflowY === "clip" || containsPaint && overflowY === "visible" ? margin : 0,
      paintParent: inTopLayer(element) ? null : parentOf(element),
      shape: style ? basicShapeClip(element, style) : rect => rect
    };
    ancestorClips.set(element, clip);
    return clip;
  };

  const anyVisible = (rects: RectLike[], host: Element, root = host.getRootNode()): boolean => {
    let blockers: Set<Element> | undefined;
    for (const rect of rects) {
      const clipped = clipToHiddenAncestors(rect, host, readElementRects, readAncestorClip);
      if (!clipped || !hasRenderedArea(clipped)) continue;
      const coveredBy = occlusionAtSamplePoints(clipped, host, root as Document | ShadowRoot, readStyle);
      if (!coveredBy) return true;
      blockers ??= new Set();
      for (const blocker of coveredBy) blockers.add(blocker);
    }
    if (blockers) onOccluded?.(blockers);
    return false;
  };

  return {
    decisions,
    isElementStyleVisible: isRendered,
    isTextNodeVisuallyRendered(node: Text): boolean {
      const host = renderedParent(node);
      return Boolean(host && isRendered(host) && anyVisible(readTextRects(node), host, node.getRootNode()));
    },
    isElementVisuallyRendered(element: Element): boolean {
      return isRendered(element) && anyVisible(readElementRects(element), element);
    }
  };
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
  const host = textContainer(node);
  return host ? readElementRects(host) : [];
}

function getElementRects(element: Element): RectLike[] {
  const rects = Array.from(element.getClientRects?.() ?? []).filter(hasRenderedArea);
  if (rects.length) return rects;
  const boundingRect = element.getBoundingClientRect();
  return hasRenderedArea(boundingRect) ? [boundingRect] : [];
}

function clipToHiddenAncestors(
  rect: RectLike,
  host: Element,
  readElementRects: (element: Element) => RectLike[],
  readAncestorClip: (element: Element) => AncestorClip
): RectLike | null {
  if (!host.ownerDocument.defaultView) return null;
  let visibleRect: RectLike | null = rect;
  let ancestor: Element | null = host;
  let overflowAncestor: Element | null = host;

  while (ancestor && visibleRect) {
    const clip = readAncestorClip(ancestor);
    const clipsX = clip.x;
    const clipsY = clip.y;
    if (ancestor === overflowAncestor && (clipsX || clipsY)) {
      const bounds = readElementRects(ancestor)[0] ?? ancestor.getBoundingClientRect();
      visibleRect = intersectOnAxes(visibleRect, makeRect(bounds.top - clip.marginY, bounds.right + clip.marginX,
        bounds.bottom + clip.marginY, bounds.left - clip.marginX), clipsX, clipsY);
    }
    // clip-path follows the painting tree even when positioned content can
    // escape an intermediate ancestor's overflow clipping.
    if (visibleRect) visibleRect = clip.shape(visibleRect);
    if (ancestor === overflowAncestor) overflowAncestor = clip.parent;
    ancestor = clip.paintParent;
  }
  return visibleRect;
}

function occlusionAtSamplePoints(
  bounds: RectLike, host: Element, root: Document | ShadowRoot,
  readStyle: (element: Element) => CSSStyleDeclaration | undefined
): Set<Element> | undefined {
  const document = host.ownerDocument;
  const view = document.defaultView;
  if (!view || readStyle(host)?.pointerEvents === "none") return;
  const rect = intersectRects(bounds, makeRect(0, view.innerWidth, view.innerHeight, 0));
  if (!rect) return;
  const hitTest = root.elementFromPoint?.bind(root) ?? document.elementFromPoint?.bind(document);
  if (!hitTest) return;
  const hitStack = root.elementsFromPoint?.bind(root);

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

  const bareShadowText = root instanceof ShadowRoot && root.host === host;
  const related = (hit: Element) => renderedContains(hit, host) || composedContains(hit, host)
    || (!bareShadowText && (renderedContains(host, hit) || composedContains(host, hit)));
  let blockers: Set<Element> | undefined;
  for (const [x, y] of points) {
    const hit = hitTest(x, y);
    if (!hit || related(hit)) return;
    let blocker = opaqueCover(hit, host, x, y, readStyle);
    if (!blocker && hitStack) {
      // Hit testing reports pointer targets, including invisible overlays.
      // An underlying opaque surface can still cover the source.
      for (const layer of hitStack(x, y)) {
        if (related(layer)) break;
        if (layer !== hit && (blocker = opaqueCover(layer, host, x, y, readStyle))) break;
      }
    }
    if (!blocker) return;
    (blockers ??= new Set()).add(blocker);
  }
  return blockers;
}

function opaqueCover(
  hit: Element, host: Element, x: number, y: number, readStyle: (element: Element) => CSSStyleDeclaration | undefined
): Element | undefined {
  let cover: Element | undefined;
  for (let layer: Element | null = hit; layer; layer = isTopLayer(layer) ? null : renderedParent(layer)) {
    const style = readStyle(layer);
    if (!style || parseOpacity(style.opacity) < 1 || (style.filter && style.filter !== "none")
      || (style.maskImage && style.maskImage !== "none") || (style.mixBlendMode && style.mixBlendMode !== "normal")) return;
    if (cover || composedContains(layer, host) || style.visibility === "hidden" || style.visibility === "collapse"
      || !/^rgb\(/u.test(style.backgroundColor) || (style.backgroundClip && style.backgroundClip !== "border-box")) continue;
    const bounds = layer.getBoundingClientRect();
    if (x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom) cover = layer;
  }
  return cover;
}

function establishesContainingBlock(element: Element, style: CSSStyleDeclaration, fixed: boolean): boolean {
  if (style.display === "contents") return false;
  if (!fixed && style.position && style.position !== "static") return true;
  const changed = (value: string) => Boolean(value && value !== "none");
  if (canTransform(element, style) && [style.transform, style.translate, style.rotate, style.scale, style.perspective].some(changed)) return true;
  // A filter on the document root does not contain fixed descendants.
  if (element !== element.ownerDocument.documentElement && [style.filter, style.backdropFilter].some(changed)) return true;
  return canContainPaint(style) && (/\b(?:layout|paint|strict|content)\b/u.test(style.contain) || style.contentVisibility === "auto")
    || style.willChange?.split(",").some(property => {
      const name = property.trim();
      if (/^(?:transform|translate|rotate|scale|perspective)$/u.test(name)) return canTransform(element, style);
      if (name === "contain") return canContainPaint(style);
      return /^(?:filter|backdrop-filter)$/u.test(name) && element !== element.ownerDocument.documentElement;
    }) || false;
}

function canTransform(element: Element, style: CSSStyleDeclaration): boolean {
  return !/^(?:inline|table-column|table-column-group)$/u.test(style.display)
    || element.matches("img,video,iframe,object,embed,canvas,input,textarea,select,svg");
}

function canContainPaint(style: CSSStyleDeclaration): boolean {
  return !/^(?:none|contents|inline|ruby.*|table-(?!cell).*)$/u.test(style.display);
}

function canClipOverflow(element: Element, style: CSSStyleDeclaration): boolean {
  return style.display !== "contents" && (style.display !== "inline" || element.matches("img,video,iframe,object,embed,canvas,input,textarea,select,svg"));
}

function isViewportBody(element: Element, readStyle: (element: Element) => CSSStyleDeclaration | undefined): boolean {
  const doc = element.ownerDocument;
  if (element !== doc.body || doc.documentElement.localName !== "html") return false;
  const root = readStyle(doc.documentElement), body = readStyle(element);
  const noContainment = (style: CSSStyleDeclaration | undefined) => !style?.contain || style.contain === "none";
  return Boolean(root && (root.overflowX || root.overflow || "visible") === "visible"
    && (root.overflowY || root.overflow || "visible") === "visible" && noContainment(root) && noContainment(body));
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
