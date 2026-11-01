// Keep each component's DOM intact. Collection crosses open roots; grouping and
// insertion stay inside the original tree so slots and event handlers survive.
const roots = new Set<ShadowRoot>();
const listeners = new Set<(root: ShadowRoot) => void>();

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
    const root = candidate.shadowRoot;
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
