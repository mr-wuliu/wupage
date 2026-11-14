import { hasExtensionContext } from "../shared/extension-context";

// Keep each component's DOM intact. Collection crosses roots; grouping and
// insertion stay inside the original tree so slots and event handlers survive.
const roots = new Set<ShadowRoot>();
const listeners = new Set<(root: ShadowRoot) => void>();

export function componentShadowRoot(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  if (!(element instanceof HTMLElement)) return null;
  // Extension-only APIs; ordinary page scripts cannot inspect closed roots.
  const firefoxRoot = (element as Element & { openOrClosedShadowRoot?: ShadowRoot }).openOrClosedShadowRoot;
  if (firefoxRoot) return firefoxRoot;
  // Chromium can keep exposing chrome.dom to old scripts after a reload.
  if (!hasExtensionContext()) return null;
  return chrome.dom?.openOrClosedShadowRoot?.(element) ?? null;
}

export function projectedSlot(node: Text | Element): HTMLSlotElement | null {
  if (node.assignedSlot) return node.assignedSlot;
  const root = node.parentElement && componentShadowRoot(node.parentElement);
  // assignedSlot deliberately hides slots inside closed roots. Read the
  // actual assignment through the extension's root instead.
  return root ? [...root.querySelectorAll("slot")].find(slot => slot.assignedNodes().includes(node)) ?? null : null;
}

export function translationNodePath(node: Node): Node[] {
  const path: Node[] = [];
  const seen = new Set<Node>();
  let current: Node | null = node;
  while (current && !seen.has(current)) {
    path.push(current);
    seen.add(current);
    current = (current instanceof Text || current instanceof Element ? projectedSlot(current) : null)
      ?? (current instanceof ShadowRoot ? current.host : current.parentNode);
  }
  return path;
}

export function sameTranslationNodePath(node: Node, expected: Node[]): boolean {
  const actual = translationNodePath(node);
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

export function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Layout follows slot assignment, while content ownership follows the DOM. */
export function renderedParent(node: Element | Text): Element | null {
  return projectedSlot(node) ?? node.parentElement
    ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
}

export function renderedContains(container: Element, node: Element): boolean {
  for (let current: Element | null = node; current; current = renderedParent(current)) {
    if (current === container) return true;
  }
  return false;
}

export function isTopLayer(element: Element): boolean {
  const root = element.getRootNode() as Document | ShadowRoot;
  if (root.fullscreenElement === element) return true;
  // Test separately so an unsupported selector cannot hide another state.
  try { if (element.localName === "dialog" && element.matches(":modal")) return true; } catch { /* Older DOM implementations. */ }
  try { if (element.hasAttribute("popover") && element.matches(":popover-open")) return true; } catch { /* Older DOM implementations. */ }
  return false;
}

/** A bare text node in a shadow tree is laid out by its host. */
export function textContainer(node: Text): Element | null {
  return node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
}

export function composedContains(container: Node, node: Node): boolean {
  if (container.contains(node)) return true;
  let root = node.getRootNode();
  while (root instanceof ShadowRoot) {
    if (container.contains(root.host)) return true;
    root = root.host.getRootNode();
  }
  return false;
}

/** Discover only the supplied subtree; callers budget large scans in chunks. */
export function discoverShadowRoots(element: Element | ShadowRoot, subtree = true): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const visit = (candidate: Element) => {
    const root = componentShadowRoot(candidate);
    if (!root) return;
    found.push(root);
    if (!roots.has(root)) {
      roots.add(root);
      listeners.forEach(listener => listener(root));
    }
  };
  if (element instanceof Element) visit(element);
  if (!subtree) return found;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) visit(walker.currentNode as Element);
  return found;
}

export function translationRoots(): Array<Document | ShadowRoot> {
  for (const root of roots) if (!root.host.isConnected) roots.delete(root);
  return [document, ...roots];
}

export function onTranslationRoot(listener: (root: ShadowRoot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function queryTranslationElements<T extends Element = Element>(selector: string): T[] {
  return translationRoots().flatMap(root => Array.from(root.querySelectorAll<T>(selector)));
}

export function mutationElement(node: Node): Element | null {
  return node instanceof Element ? node : node instanceof ShadowRoot ? node.host
    : node instanceof Text ? textContainer(node) : node.parentElement;
}
