import type { ExtensionSettings, RuntimeRequest, TranslateBatchResponse, TranslationDisplayMode } from "../shared/types";
import {
  clearTranslationPlaceholders,
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectTextSegmentsProgressive,
  takeHiddenScanRoots,
  hideTranslations,
  invalidateStaleSegments,
  renderTranslationPlaceholders,
  renderTranslations,
  restoreTranslations,
  setTranslationDisplayMode
} from "./dom";
import type { TextSegment } from "./dom";
import { sendRuntimeRequest } from "./runtime";
import { buildTranslationContext } from "./translation-context";
import { getEffectiveProviderPerformance, isLlmProvider } from "../shared/performance";
import { ProviderError } from "../shared/errors";
import { DocumentViewport } from "./document-viewport";
import { invalidatePendingDocumentTranslations } from "./translation-lifecycle";
import { composedParent, mutationElement, onTranslationRoot, translationRoots } from "./dom-roots";

const VIEWPORT_MARGIN_RATIO = 0.75;
const MIN_VIEWPORT_MARGIN = 240;
const MAX_PAGE_CONCURRENCY = 2;
const MAX_PROGRESSIVE_CHUNK_SIZE = 4000;
const MAX_LLM_BATCH_ITEMS = 16;
const VIEWPORT_DEBOUNCE_MS = 100;
const DYNAMIC_CONTENT_DEBOUNCE_MS = 160;
const EXTENSION_OWNED_SELECTOR = [
  "[data-wupage-video]",
  "[data-wupage-video-style]",
  "[data-wupage-video-native]",
  "#wupage-video-panel",
  "#wupage-video-overlay",
  ".wupage-translation",
  "#wupage-translation-style",
  "#wupage-floating-hitbox",
  "#wupage-floating-menu",
  "#wupage-debug-panel",
  "#wupage-paragraph-highlight"
].join(",");

type SegmentStatus = "idle" | "queued" | "running" | "done" | "failed";

interface SegmentEntry {
  segment: TextSegment;
  status: SegmentStatus;
}

interface TranslationSession {
  id: number;
  pageUrl: string;
  translationIdentity: string;
  settings: ExtensionSettings;
  entries: Map<string, SegmentEntry>;
  queue: TextSegment[][];
  activeCount: number;
  maxConcurrency: number;
  cancelled: boolean;
  translated: number;
  cached: number;
  failed: number;
  firstError?: string;
  firstErrorCode?: string;
  retryAt?: number;
  providerPaused?: boolean;
  initialPending: Set<string>;
  initialResolved: boolean;
  resolveInitial: (result: PageTranslationResult) => void;
  observer: MutationObserver;
  unobserveRoots?: () => void;
  viewport: DocumentViewport;
  initializing: boolean;
  dynamicRoots: Set<Element>;
  changedRoots: Set<Element>;
  dynamicTimer?: number;
  /**
   * What the pending viewport refresh has to look at. Scrolling only revisits
   * text that was hidden, while a layout change can move text anywhere.
   */
  viewportRescanScope: ViewportRescanScope;
  scanController: AbortController;
  refreshRoots: Set<Element>;
  refreshTask?: Promise<void>;
}

type ViewportRescanScope = "hidden" | "full";

/** How much of the document a refresh has to revisit. */
type RescanScope = "none" | "changed" | ViewportRescanScope;

export interface PageTranslationResult {
  translated: number;
  cached: number;
  failed: number;
  error?: string;
  errorCode?: string;
  retryAt?: number;
  remaining: number;
  cancelled?: boolean;
}

export interface PageTranslationState extends PageTranslationResult {
  active: boolean;
  pending: number;
}

let sessionCounter = 0;
let activeSession: TranslationSession | null = null;
let suspendedSession: TranslationSession | null = null;
let viewportTimer: number | undefined;
let currentDisplayMode: TranslationDisplayMode | undefined;
// Bumped by every start and every teardown, so a scan that is still yielding
// can tell that its result is stale before it builds a session.
let sessionEpoch = 0;
let pendingScan: { controller: AbortController; settings: ExtensionSettings } | null = null;

function cancelPendingScan(): void {
  pendingScan?.controller.abort();
  pendingScan = null;
}
let settingsRevision = 0;
let latestSettings: ExtensionSettings | undefined;
const stateListeners = new Set<(event?: "stopped") => void>();

export interface PageTranslationCoordinator {
  state(): PageTranslationState;
  start(settings: ExtensionSettings, reuseResults: boolean): Promise<PageTranslationResult>;
  stop(): void | Promise<void>;
  display(mode: TranslationDisplayMode): void;
}
let coordinator: PageTranslationCoordinator | undefined;
let pageRequestIdentity: { id: string; documentKey: string } | undefined;
export function configurePageTranslationCoordinator(value: PageTranslationCoordinator): void { coordinator = value; }
export function setPageRequestIdentity(value: typeof pageRequestIdentity): void { pageRequestIdentity = value; }
export function notifyCoordinatedPageState(): void { notifyTranslationState(); }

export function getPageTranslationState(): PageTranslationState {
  return coordinator?.state() ?? getLocalPageTranslationState();
}

export function getLocalPageTranslationState(): PageTranslationState {
  const session = activeSession;
  if (session) {
    return {
      ...getResult(session),
      active: true,
      pending: [...session.entries.values()].filter((entry) => entry.status === "queued" || entry.status === "running").length
    };
  }
  // The initial scan yields to the browser, so a start request is pending work
  // even before a session exists; reporting it as idle would flash "not started".
  return { active: Boolean(pendingScan), pending: pendingScan ? 1 : 0, translated: 0, cached: 0, failed: 0, remaining: 0 };
}

export function subscribePageTranslationState(listener: (event?: "stopped") => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function notifyTranslationState(event?: "stopped"): void {
  stateListeners.forEach((listener) => listener(event));
}

export async function loadPageTranslationSettings(): Promise<ExtensionSettings> {
  const revision = settingsRevision;
  const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
  // A language change can arrive while the initial settings read is pending,
  // before there is an active session for the storage listener to restart.
  return revision !== settingsRevision && latestSettings ? latestSettings : settings;
}

export function updatePageTranslationSettings(settings: ExtensionSettings): void {
  settingsRevision += 1;
  latestSettings = settings;
  if (coordinator) return;
  if (pendingScan) {
    if (getTranslationIdentity(pendingScan.settings) !== getTranslationIdentity(settings)) {
      void startPageTranslation(settings, false);
    } else pendingScan.settings = settings;
  }
  const session = activeSession;
  if (session && (session.settings.sourceLang !== settings.sourceLang || session.settings.targetLang !== settings.targetLang)) {
    // Start from the saved originals, cancelling the old generation before any
    // late response can render. A hidden or never-started page stays inactive.
    preserveViewportPosition(() => { void startPageTranslation(settings, false); },
      [...session.entries.values()].map((entry) => entry.segment));
    return;
  }
  const mode = settings.translationDisplayMode;
  if (mode !== currentDisplayMode && (mode === "replace" || mode === "bilingual" || mode === "bilingual-accent")) {
    setPageTranslationDisplayMode(mode);
  }
}

export function startPageTranslation(settings: ExtensionSettings, reuseResults = true): Promise<PageTranslationResult> {
  return coordinator ? coordinator.start(settings, reuseResults) : startLocalPageTranslation(settings, reuseResults);
}

export async function startLocalPageTranslation(settings: ExtensionSettings, reuseResults = true): Promise<PageTranslationResult> {
  cancelPendingScan();
  const saved = suspendedSession;
  const canRestore = reuseResults && saved && saved.pageUrl === location.href
    && saved.translationIdentity === getTranslationIdentity(settings);
  const epoch = ++sessionEpoch;
  let entries = new Map<string, SegmentEntry>();
  if (canRestore) {
    handleDynamicContent(saved, saved.observer.takeRecords());
    disconnectPageObserver(saved);
    suspendedSession = null;
    const stale = new Set(invalidateStaleSegments([...saved.changedRoots]));
    entries = new Map([...saved.entries].filter(([id, entry]) => !stale.has(id) && entry.segment.element.isConnected)
      .map(([id, entry]) => [id, { segment: entry.segment, status: entry.status === "done" ? "done" : "idle" }]));
  } else clearPageTranslationState();
  const pending = { controller: new AbortController(), settings };
  pendingScan = pending;
  const pendingRoots = new Set<Element>();
  notifyTranslationState();
  try {
    const options = { signal: pending.controller.signal,
      onPendingRoots: (roots: Element[]) => roots.forEach(root => pendingRoots.add(root)) };
    const scanned = canRestore
      ? await collectAdditionalTextSegmentsProgressive([document.body], settings.translateCodeComments, options)
      : await collectTextSegmentsProgressive(settings.translateCodeComments, options);
    if (epoch !== sessionEpoch || pending.controller.signal.aborted) return { ...getLocalPageTranslationState(), cancelled: true };
    settings = pending.settings;
    for (const segment of scanned) entries.set(segment.id, { segment, status: "idle" });
    if (canRestore) preserveViewportPosition(() => restoreTranslations(settings.translationDisplayMode),
      [...entries.values()].map(entry => entry.segment));
  } finally {
    if (pendingScan === pending) pendingScan = null;
  }
  currentDisplayMode = settings.translationDisplayMode;
  const restored = [...entries.values()].filter((entry) => entry.status === "done").length;

  let resolveInitial!: (result: PageTranslationResult) => void;
  const initialPromise = new Promise<PageTranslationResult>((resolve) => {
    resolveInitial = resolve;
  });
  const performance = getEffectiveProviderPerformance(settings);
  const observer = new MutationObserver((mutations) => handleDynamicContent(session, mutations));
  const session: TranslationSession = {
    id: ++sessionCounter,
    pageUrl: location.href,
    translationIdentity: getTranslationIdentity(settings),
    settings,
    entries,
    queue: [],
    activeCount: 0,
    maxConcurrency: Math.min(MAX_PAGE_CONCURRENCY, performance.concurrency),
    cancelled: false,
    translated: restored,
    cached: restored,
    failed: 0,
    initialPending: new Set(),
    initialResolved: false,
    resolveInitial,
    observer,
    viewport: new DocumentViewport(() => { if (isActive(session) && !session.initializing) scheduleNearbySegments(session); }),
    initializing: true,
    dynamicRoots: new Set(),
    changedRoots: new Set(),
    viewportRescanScope: "hidden",
    scanController: new AbortController(),
    refreshRoots: new Set()
  };

  activeSession = session;
  observePage(session);
  window.addEventListener("scroll", handleViewportChange, { passive: true, capture: true });
  window.addEventListener("resize", handleViewportResize, { passive: true });
  document.addEventListener("wupage:frame-visibility", handleViewportChange);
  document.addEventListener("load", handleImageLoad, true);
  const begin = () => {
    if (!isActive(session)) return;
    session.initializing = false;
    for (const root of pendingRoots) session.dynamicRoots.add(root);
    if (pendingRoots.size) refreshSegments(session, "changed");
    scheduleNearbySegments(session, true);
    resolveInitialIfReady(session);
  };
  if (session.viewport.deferred) {
    session.viewport.update([...session.entries.values()].map(entry => entry.segment.element));
    void session.viewport.ready.then(begin);
  } else begin();
  return initialPromise;
}

export function clearPageTranslation(): void {
  sessionEpoch += 1;
  clearPageTranslationState();
  notifyTranslationState();
}

// Teardown without invalidating a scan that is already building its session.
function clearPageTranslationState(): void {
  cancelPendingScan();
  invalidatePendingDocumentTranslations();
  cancelActiveSession();
  if (suspendedSession) disconnectPageObserver(suspendedSession);
  suspendedSession = null;
  clearTranslations();
}

export function hidePageTranslation(): void | Promise<void> {
  if (coordinator) return coordinator.stop();
  hideLocalPageTranslation();
}

export function hideLocalPageTranslation(explicitStop = true): void {
  // An initial scan can still be yielding; without this bump it would finish and
  // start translating again for a user who already asked to stop.
  sessionEpoch += 1;
  const stoppedScan = Boolean(pendingScan);
  cancelPendingScan();
  if (stoppedScan) clearTranslations();
  invalidatePendingDocumentTranslations();
  const session = activeSession;
  if (!session && suspendedSession) {
    // Paragraph translation can add visible results while the page session is
    // suspended. Hide those too, keeping the saved page results and observer.
    preserveViewportPosition(hideTranslations, [...suspendedSession.entries.values()].map((entry) => entry.segment));
    notifyTranslationState(explicitStop ? "stopped" : undefined);
    return;
  }
  cancelActiveSession();
  if (suspendedSession) disconnectPageObserver(suspendedSession);
  suspendedSession = session;
  preserveViewportPosition(hideTranslations, session ? [...session.entries.values()].map((entry) => entry.segment) : []);
  if (session) observePage(session);
  notifyTranslationState(explicitStop ? "stopped" : undefined);
}

function getTranslationIdentity(settings: ExtensionSettings): string {
  return JSON.stringify({
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    activeProviderId: settings.activeProviderId,
    provider: settings.providers.find((provider) => provider.id === settings.activeProviderId),
    translateCodeComments: settings.translateCodeComments
  });
}

function observePage(session: TranslationSession): void {
  const options = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "placeholder", "alt", "open", "translate", "contenteditable", "role"]
  };
  for (const root of translationRoots()) session.observer.observe(root, options);
  session.unobserveRoots?.();
  session.unobserveRoots = onTranslationRoot(root => session.observer.observe(root, options));
}

function disconnectPageObserver(session: TranslationSession): void {
  session.observer.disconnect();
  session.unobserveRoots?.();
  session.unobserveRoots = undefined;
}

export function getPageTranslationDisplayMode(fallback: TranslationDisplayMode): TranslationDisplayMode {
  return currentDisplayMode ?? fallback;
}

export function setPageTranslationDisplayMode(mode: TranslationDisplayMode): void {
  if (coordinator) { coordinator.display(mode); return; }
  setLocalPageTranslationDisplayMode(mode);
}

export function setLocalPageTranslationDisplayMode(mode: TranslationDisplayMode): void {
  currentDisplayMode = mode;
  if (pendingScan) pendingScan.settings = { ...pendingScan.settings, translationDisplayMode: mode };
  const session = activeSession;
  if (!session && suspendedSession) return;
  if (session) session.settings = { ...session.settings, translationDisplayMode: mode };
  preserveViewportPosition(() => setTranslationDisplayMode(mode),
    session ? [...session.entries.values()].map((entry) => entry.segment) : []);
}

function scheduleNearbySegments(session: TranslationSession, initial = false): void {
  if (!isActive(session) || session.providerPaused) return;
  if (session.initializing && !initial) return;
  const entries = [...session.entries.values()];
  // Only a deferred viewport (nested browsing context) needs the full ordered
  // element list to look up reading neighbours, and only it observes anything.
  if (session.viewport.deferred) session.viewport.update(entries.map(entry => entry.segment.element));
  const nearby = entries
    .filter((entry) => entry.status === "idle" || entry.status === "queued")
    .map((entry) => ({ entry, priority: session.viewport.priority(entry.segment.element) ??
      (window === window.top || typeof IntersectionObserver === "undefined" ? getViewportPriority(entry.segment.element) : null) }))
    .filter((candidate): candidate is { entry: SegmentEntry; priority: number } => candidate.priority !== null)
    .sort((left, right) => left.priority - right.priority);
  const nearbyIds = new Set(nearby.map(({ entry }) => entry.segment.id));

  for (const entry of session.entries.values()) {
    if (entry.status !== "queued" || nearbyIds.has(entry.segment.id)) continue;
    entry.status = "idle";
    settleInitialSegment(session, entry.segment.id);
  }

  for (const { entry } of nearby) {
    if (entry.status === "idle") entry.status = "queued";
    if (initial) session.initialPending.add(entry.segment.id);
  }

  const queuedSegments = nearby
    .map(({ entry }) => entry)
    .filter((entry) => entry.status === "queued")
    .map((entry) => entry.segment);
  session.queue = groupSegments(
    queuedSegments,
    getProgressiveChunkSize(session.settings),
    getProgressiveMaxItems(session.settings)
  );
  pumpQueue(session);
  notifyTranslationState();
}

function pumpQueue(session: TranslationSession): void {
  if (!isActive(session) || session.providerPaused) return;
  const launches: TextSegment[][] = [];
  while (session.activeCount + launches.length < session.maxConcurrency && session.queue.length) {
    const batch = session.queue.shift();
    if (!batch) break;
    const runnable = batch.filter((segment) => session.entries.get(segment.id)?.status === "queued");
    if (!runnable.length) continue;
    launches.push(runnable);
  }
  if (!launches.length) return;
  // Every guard forces a layout, so batches that start together must share one
  // guard: rendering placeholders per batch multiplied the reflow cost by the
  // concurrency factor on long documents.
  preserveViewportPosition(() => {
    for (const segments of launches) renderTranslationPlaceholders(segments);
  }, launches.flat());
  for (const segments of launches) void runBatch(session, segments);
}

async function runBatch(session: TranslationSession, segments: TextSegment[]): Promise<void> {
  session.activeCount += 1;
  segments.forEach((segment) => {
    const entry = session.entries.get(segment.id);
    if (entry) entry.status = "running";
  });

  try {
    const data = await sendRuntimeRequest<TranslateBatchResponse>({
      type: "TRANSLATE_BATCH",
      texts: segments.map((segment) => segment.text),
      preservePlaceholders: true,
      context: buildTranslationContext(segments.map((segment) => segment.element)),
      sourceLang: session.settings.sourceLang,
      targetLang: session.settings.targetLang,
      providerId: session.settings.activeProviderId,
      ...(pageRequestIdentity ? { pageSession: pageRequestIdentity } : {})
    } satisfies RuntimeRequest);
    if (!isActive(session)) return;
    // A response can arrive after a virtualized row has been reused.
    refreshSegments(session, "none");
    const currentSegments = segments.filter((segment) => session.entries.has(segment.id));
    if (data.translations.length !== segments.length
      || data.translations.some((text) => typeof text !== "string" || !text.trim())) {
      throw new Error("Translation response contains missing or empty items.");
    }

    preserveViewportPosition(() => {
      renderTranslations(
        segments.map((segment, index) => ({
          id: segment.id,
          text: data.translations[index]
        })).filter((entry) => session.entries.has(entry.id)),
        session.settings.translationDisplayMode
      );
    }, segments);
    session.cached += data.cached;
    session.translated += currentSegments.length;
    currentSegments.forEach((segment) => {
      const entry = session.entries.get(segment.id);
      if (entry) entry.status = "done";
    });
  } catch (error) {
    if (!isActive(session)) return;
    preserveViewportPosition(() => clearTranslationPlaceholders(segments), segments);
    session.failed += segments.length;
    session.firstError ??= error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderError) {
      session.firstErrorCode ??= error.errorCode;
      if (error.retryAfterMs !== undefined) session.retryAt = Date.now() + error.retryAfterMs;
      if (["login-required", "rate-limited", "service-rejected", "permission-required",
        "unsupported-browser", "unsupported-language", "protocol-changed", "service-unavailable"].includes(error.errorCode)) {
        session.providerPaused = true;
        session.queue = [];
        for (const entry of session.entries.values()) {
          if (entry.status !== "queued") continue;
          entry.status = "idle";
          settleInitialSegment(session, entry.segment.id);
        }
      }
    }
    segments.forEach((segment) => {
      const entry = session.entries.get(segment.id);
      if (entry) entry.status = "failed";
    });
  } finally {
    session.activeCount = Math.max(0, session.activeCount - 1);
    segments.forEach((segment) => settleInitialSegment(session, segment.id));
    if (isActive(session)) {
      scheduleNearbySegments(session);
      resolveInitialIfReady(session);
      if (session.providerPaused) notifyTranslationState();
    }
  }
}

function handleImageLoad(event: Event): void {
  if (event.target instanceof HTMLImageElement) handleViewportChange();
}

function handleViewportChange(): void {
  scheduleViewportRefresh("hidden");
}

function handleViewportResize(): void {
  scheduleViewportRefresh("full");
}

/**
 * Scrolling and resizing never change the DOM, they only change what is on
 * screen. Rescanning every text node on each of those events costs a full
 * document walk plus a visibility pass, so scrolling only revisits the subtrees
 * that were hidden last time and a layout change takes the whole document.
 */
function scheduleViewportRefresh(scope: ViewportRescanScope): void {
  const session = activeSession;
  if (!session) return;
  if (scope === "full") session.viewportRescanScope = "full";
  if (viewportTimer !== undefined) window.clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(() => {
    viewportTimer = undefined;
    if (activeSession !== session) return;
    const pending = session.viewportRescanScope;
    session.viewportRescanScope = "hidden";
    refreshSegments(session, pending);
    scheduleNearbySegments(session);
  }, VIEWPORT_DEBOUNCE_MS);
}

function handleDynamicContent(session: TranslationSession, mutations: MutationRecord[]): void {
  if (!isActive(session) && suspendedSession !== session) return;
  for (const mutation of mutations) {
    const target = mutationElement(mutation.target);
    if (!target || isExtensionOwned(target)) continue;
    if (mutation.type === "characterData") {
      session.dynamicRoots.add(target);
      if (suspendedSession === session) session.changedRoots.add(target);
      continue;
    }
    if (mutation.type === "attributes") {
      const root = mutation.target instanceof Element ? mutation.target : null;
      if (root && !isExtensionOwned(root)) {
        session.dynamicRoots.add(root);
        if (suspendedSession === session) session.changedRoots.add(root);
      }
      continue;
    }
    const sourceChanged = [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
      !(node instanceof Element && isExtensionOwned(node))
    );
    if (sourceChanged) {
      session.changedRoots.add(target);
      session.dynamicRoots.add(target);
    }
    for (const node of mutation.addedNodes) {
      const root = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
      if (!root || isExtensionOwned(root)) continue;
      session.dynamicRoots.add(root);
    }
  }
  if (suspendedSession === session || !session.dynamicRoots.size || session.dynamicTimer !== undefined) return;
  session.dynamicTimer = window.setTimeout(() => {
    session.dynamicTimer = undefined;
    collectDynamicSegments(session);
  }, DYNAMIC_CONTENT_DEBOUNCE_MS);
}

function collectDynamicSegments(session: TranslationSession): void {
  if (!isActive(session)) return;
  refreshSegments(session, "changed");
  scheduleNearbySegments(session);
}

function queueRefreshRoot(session: TranslationSession, root: Element): void {
  if (!root.isConnected || session.refreshRoots.has(document.body)) return;
  if (root === document.body || session.refreshRoots.size >= 4096) {
    session.refreshRoots.clear(); session.refreshRoots.add(document.body);
  } else session.refreshRoots.add(root);
}

function refreshSegments(session: TranslationSession, scope: RescanScope = "changed"): void {
  if (!isActive(session)) return;
  const changed = [...session.changedRoots];
  const roots = [...session.dynamicRoots, ...changed];
  const staleIds = invalidateStaleSegments(changed);
  session.changedRoots.clear();
  session.dynamicRoots.clear();
  // Invalidation stays synchronous so an arriving response cannot render a
  // recycled row while the replacement scan is yielding.
  for (const id of staleIds) {
    const entry = session.entries.get(id);
    if (entry?.segment.element.isConnected) roots.push(entry.segment.element);
    session.entries.delete(id);
    settleInitialSegment(session, id);
  }
  if (scope === "full") roots.push(document.body);
  // Take one snapshot of all candidates. Time slicing completes the snapshot
  // without requiring another scroll; roots that remain hidden wait for a new
  // viewport event instead of causing an endless background retry loop.
  else if (scope === "hidden") roots.push(...takeHiddenScanRoots(Number.POSITIVE_INFINITY));
  for (const root of roots) queueRefreshRoot(session, root);
  if (session.refreshTask || !session.refreshRoots.size) return;
  session.refreshTask = (async () => {
    while (isActive(session) && session.refreshRoots.size) {
      const pending = [...session.refreshRoots]; session.refreshRoots.clear();
      await collectAdditionalTextSegmentsProgressive(pending, session.settings.translateCodeComments, {
        signal: session.scanController.signal,
        observeChanges: false,
        onSegments: segments => {
          if (!isActive(session)) return;
          for (const segment of segments) {
            if (!session.entries.has(segment.id)) session.entries.set(segment.id, { segment, status: "idle" });
          }
        }
      });
      if (isActive(session)) scheduleNearbySegments(session);
    }
  })().catch(error => {
    if (!isActive(session)) return;
    session.firstError ??= error instanceof Error ? error.message : String(error);
    notifyTranslationState();
  }).finally(() => { session.refreshTask = undefined; });
}

function isExtensionOwned(element: Element): boolean {
  return element.matches(EXTENSION_OWNED_SELECTOR) || Boolean(element.closest(EXTENSION_OWNED_SELECTOR));
}

function preserveViewportPosition(mutate: () => void, segments: TextSegment[] = []): void {
  const left = window.scrollX;
  const top = window.scrollY;
  // An inner scroll container (mail pane, document panel) can drift even while
  // the window itself sits at its origin, so the ancestor walk is required.
  const containers = new Map<Element, { left: number; top: number }>();
  for (const segment of segments) {
    let ancestor: Element | null = segment.element;
    while (ancestor && ancestor !== document.scrollingElement) {
      if (!containers.has(ancestor) && (ancestor.scrollTop || ancestor.scrollLeft)) {
        containers.set(ancestor, { left: ancestor.scrollLeft, top: ancestor.scrollTop });
      }
      ancestor = composedParent(ancestor);
    }
  }
  mutate();
  // Chromium applies scroll anchoring during layout, after the DOM mutation has
  // returned. Force that layout now so any resulting drift is observable and
  // can be corrected before the next frame is painted.
  void document.documentElement.offsetHeight;
  for (const [container, position] of containers) {
    if (container.scrollLeft !== position.left) container.scrollLeft = position.left;
    if (container.scrollTop !== position.top) container.scrollTop = position.top;
  }
  if (window.scrollX !== left || window.scrollY !== top) {
    window.scrollTo(left, top);
  }
}

function getViewportPriority(element: Element): number | null {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewportHeight = Math.max(1, window.innerHeight);
  const margin = Math.max(MIN_VIEWPORT_MARGIN, viewportHeight * VIEWPORT_MARGIN_RATIO);
  if (rect.bottom < -margin || rect.top > viewportHeight + margin) return null;
  if (rect.bottom >= 0 && rect.top <= viewportHeight) return Math.max(0, rect.top);
  return rect.bottom < 0
    ? viewportHeight + Math.abs(rect.bottom)
    : viewportHeight + Math.max(0, rect.top - viewportHeight);
}

function groupSegments(segments: TextSegment[], maxChars: number, maxItems: number): TextSegment[][] {
  const groups: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentLength = 0;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const normalizedSegment = text === segment.text ? segment : { ...segment, text };
    if (
      current.length
      && (currentLength + normalizedSegment.text.length > maxChars || current.length >= maxItems)
    ) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(normalizedSegment);
    currentLength += normalizedSegment.text.length;
  }

  if (current.length) groups.push(current);
  return groups;
}

function getProgressiveMaxItems(settings: ExtensionSettings): number {
  const provider = settings.providers.find((entry) => entry.id === settings.activeProviderId);
  return provider && isLlmProvider(provider) ? MAX_LLM_BATCH_ITEMS : Number.POSITIVE_INFINITY;
}

function getProgressiveChunkSize(settings: ExtensionSettings): number {
  const performance = getEffectiveProviderPerformance(settings);
  return Math.max(200, Math.min(MAX_PROGRESSIVE_CHUNK_SIZE, performance.chunkSize));
}

function settleInitialSegment(session: TranslationSession, id: string): void {
  if (!session.initialPending.delete(id)) return;
  resolveInitialIfReady(session);
}

function resolveInitialIfReady(session: TranslationSession): void {
  if (session.initialResolved || session.initialPending.size > 0) return;
  session.initialResolved = true;
  session.resolveInitial(getResult(session));
}

function cancelActiveSession(): void {
  const session = activeSession;
  activeSession = null;
  if (viewportTimer !== undefined) {
    window.clearTimeout(viewportTimer);
    viewportTimer = undefined;
  }
  window.removeEventListener("scroll", handleViewportChange, true);
  window.removeEventListener("resize", handleViewportResize);
  document.removeEventListener("wupage:frame-visibility", handleViewportChange);
  document.removeEventListener("load", handleImageLoad, true);
  if (!session) return;
  session.scanController.abort();
  session.refreshRoots.clear();
  disconnectPageObserver(session);
  session.viewport.disconnect();
  session.dynamicRoots.clear();
  session.changedRoots.clear();
  if (session.dynamicTimer !== undefined) {
    window.clearTimeout(session.dynamicTimer);
    session.dynamicTimer = undefined;
  }
  session.cancelled = true;
  if (!session.initialResolved) {
    session.initialResolved = true;
    session.resolveInitial(getResult(session));
  }
}

function isActive(session: TranslationSession): boolean {
  return !session.cancelled && activeSession?.id === session.id;
}

function getResult(session: TranslationSession): PageTranslationResult {
  return {
    translated: session.translated,
    cached: session.cached,
    failed: session.failed,
    error: session.firstError,
    ...(session.firstErrorCode ? { errorCode: session.firstErrorCode } : {}),
    ...(session.retryAt === undefined ? {} : { retryAt: session.retryAt }),
    remaining: [...session.entries.values()].filter((entry) => entry.status === "idle").length
  };
}
