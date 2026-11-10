import { mutationElement, discoverShadowRoots, onTranslationRoot, translationRoots } from "./dom-roots";
import { observedTranslationAttributes } from "./element-exclusions";
import type { ProgressiveScanOptions, TextSegment } from "./text-segments";

interface ScanDependencies {
  isCurrent: () => boolean;
  isParagraph: (element: Element) => boolean;
  collect: (root: Element | ShadowRoot, directTextOnly: boolean) => TextSegment[];
  clearHiddenCandidates: () => void;
  invalidate: (roots: Element[]) => string[];
  uncover: (roots: Element[]) => Element[];
}

const SCAN_CHUNK_NODES = 120;

const SCAN_SLICE_MS = 12;

const SCAN_MUTATION_ROOT_LIMIT = 200;

function yieldToMain(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let channel: MessageChannel | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      signal?.removeEventListener("abort", finish);
      channel?.port1.close();
      channel?.port2.close();
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener("abort", finish, { once: true });
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === "function") {
      scheduler.yield().then(finish, finish);
    } else if (typeof MessageChannel !== "undefined") {
      channel = new MessageChannel();
      channel.port1.onmessage = finish;
      channel.port2.postMessage(0);
    } else timer = setTimeout(finish, 0);
  });
}

interface ScanChunk {
  root: Element | ShadowRoot;
  directTextOnly: boolean;
}

// Discover chunks lazily so planning a large document also yields. Keep authored
// paragraphs intact: splitting inline runs changes grouping and line breaks.
function* collectScanChunks(root: Element, isParagraph: (element: Element) => boolean): Generator<ScanChunk> {
  const stack: Array<Element | ShadowRoot> = [root];
  while (stack.length) {
    const element = stack.pop()!;
    if (!element.isConnected) continue;
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let count = 0;
    while (count <= SCAN_CHUNK_NODES && walker.nextNode()) count += 1;
    if (count <= SCAN_CHUNK_NODES || !element.firstElementChild
      || (element instanceof Element && isParagraph(element))) {
      for (const shadow of discoverShadowRoots(element).reverse()) stack.push(shadow);
      yield { root: element, directTextOnly: false };
      continue;
    }
    yield { root: element, directTextOnly: true };
    for (const shadow of discoverShadowRoots(element, false)) stack.push(shadow);
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
  }
}

function addCoveredScanRoot(roots: Set<Element>, element: Element): void {
  for (const root of roots) {
    if (root.contains(element)) return;
    if (element.contains(root)) roots.delete(root);
  }
  roots.add(element);
}

export async function scanTextRootsProgressive(
  roots: Element[], options: ProgressiveScanOptions, dependencies: ScanDependencies
): Promise<TextSegment[]> {
  const cancelled = () => options.signal?.aborted || !dependencies.isCurrent();
  if (cancelled()) return [];
  const segments = new Map<string, TextSegment>();
  const touched = new Set<Element>();
  const recordMutations = (records: MutationRecord[]) => {
    for (const record of records) {
      const element = mutationElement(record.target);
      if (!element?.isConnected) continue;
      addCoveredScanRoot(touched, element);
      if (touched.size > SCAN_MUTATION_ROOT_LIMIT) { touched.clear(); touched.add(document.body); }
    }
  };
  const observer = options.observeChanges !== false ? new MutationObserver(recordMutations) : undefined;
  const observerOptions = { childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: observedTranslationAttributes(document) };
  for (const root of translationRoots()) observer?.observe(root, observerOptions);
  const unsubscribe = onTranslationRoot(root => observer?.observe(root, observerOptions));
  let sliceStarted = performance.now();
  const scan = async (pending: Element[]) => {
    const candidates = new Set(pending.filter(root => root.isConnected));
    const covered = [...candidates].filter(root => {
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (candidates.has(ancestor)) return false;
      }
      return true;
    });
    for (const root of covered) {
      if (root === document.body || root === document.documentElement) dependencies.clearHiddenCandidates();
      for (const chunk of collectScanChunks(root, dependencies.isParagraph)) {
        if (cancelled()) return;
        recordMutations(observer?.takeRecords() ?? []);
        const found = dependencies.collect(chunk.root, chunk.directTextOnly);
        // Text normalization performed by the collector is already represented in
        // found; do not mistake its own node splits for host changes.
        observer?.takeRecords();
        for (const segment of found) segments.set(segment.id, segment);
        options.onSegments?.(found);
        if (performance.now() - sliceStarted < SCAN_SLICE_MS) continue;
        await yieldToMain(options.signal);
        if (cancelled()) return;
        sliceStarted = performance.now();
      }
    }
  };
  try {
    await scan(roots);
    // Reconcile bursts without letting a continuously updating page keep the
    // initial scan open forever. The page session takes over any remaining work.
    for (let pass = 0; pass < 2 && !cancelled(); pass++) {
      recordMutations(observer?.takeRecords() ?? []);
      if (!touched.size) break;
      const changed = [...touched]; touched.clear();
      for (const id of dependencies.invalidate(changed)) segments.delete(id);
      await scan([...changed, ...dependencies.uncover(changed)]);
    }
    if (cancelled()) return [];
    recordMutations(observer?.takeRecords() ?? []);
    if (touched.size) {
      for (const id of dependencies.invalidate([...touched])) segments.delete(id);
      options.onPendingRoots?.([...touched, ...dependencies.uncover([...touched])]);
    }
    return [...segments.values()];
  } finally { unsubscribe(); observer?.disconnect(); }
}
