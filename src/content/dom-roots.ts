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
  const api = (globalThis as typeof globalThis & {
    chrome?: { dom?: { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null } };
  }).chrome?.dom;
  return api?.openOrClosedShadowRoot?.(element) ?? null;
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
export function discoverShadowRoots(element: Element, subtree = true): ShadowRoot[] {
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
  visit(element);
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
  return node instanceof Element ? node : node instanceof ShadowRoot ? node.host : node.parentElement;
}
