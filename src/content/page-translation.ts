import type { ExtensionSettings, RuntimeRequest, TranslateBatchResponse } from "../shared/types";
import {
  clearTranslationPlaceholders,
  clearTranslations,
  collectTextSegments,
  renderTranslationPlaceholders,
  renderTranslations
} from "./dom";
import type { TextSegment } from "./dom";
import { sendRuntimeRequest } from "./runtime";

const VIEWPORT_MARGIN_RATIO = 0.75;
const MIN_VIEWPORT_MARGIN = 240;
const MAX_PAGE_CONCURRENCY = 2;
const MAX_PROGRESSIVE_CHUNK_SIZE = 4000;
const VIEWPORT_DEBOUNCE_MS = 100;

type SegmentStatus = "idle" | "queued" | "running" | "done" | "failed";

interface SegmentEntry {
  segment: TextSegment;
  status: SegmentStatus;
}

interface TranslationSession {
  id: number;
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
  initialPending: Set<string>;
  initialResolved: boolean;
  resolveInitial: (result: PageTranslationResult) => void;
}

export interface PageTranslationResult {
  translated: number;
  cached: number;
  failed: number;
  error?: string;
  remaining: number;
}

let sessionCounter = 0;
let activeSession: TranslationSession | null = null;
let viewportTimer: number | undefined;

export function startPageTranslation(settings: ExtensionSettings): Promise<PageTranslationResult> {
  clearPageTranslation();
  const segments = collectTextSegments(settings.translateCodeComments);
  if (!segments.length) return Promise.resolve(emptyResult());

  let resolveInitial!: (result: PageTranslationResult) => void;
  const initialPromise = new Promise<PageTranslationResult>((resolve) => {
    resolveInitial = resolve;
  });
  const performance = getPageProviderPerformance(settings);
  const session: TranslationSession = {
    id: ++sessionCounter,
    settings,
    entries: new Map(segments.map((segment) => [segment.id, { segment, status: "idle" }])),
    queue: [],
    activeCount: 0,
    maxConcurrency: Math.min(MAX_PAGE_CONCURRENCY, performance.concurrency),
    cancelled: false,
    translated: 0,
    cached: 0,
    failed: 0,
    initialPending: new Set(),
    initialResolved: false,
    resolveInitial
  };

  activeSession = session;
  window.addEventListener("scroll", handleViewportChange, { passive: true });
  window.addEventListener("resize", handleViewportChange, { passive: true });
  scheduleNearbySegments(session, true);
  resolveInitialIfReady(session);
  return initialPromise;
}

export function clearPageTranslation(): void {
  cancelActiveSession();
  clearTranslations();
}

function scheduleNearbySegments(session: TranslationSession, initial = false): void {
  if (!isActive(session)) return;

  const nearby = [...session.entries.values()]
    .filter((entry) => entry.status === "idle" || entry.status === "queued")
    .map((entry) => ({ entry, priority: getViewportPriority(entry.segment.element) }))
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
  session.queue = groupSegments(queuedSegments, getProgressiveChunkSize(session.settings));
  pumpQueue(session);
}

function pumpQueue(session: TranslationSession): void {
  if (!isActive(session)) return;
  while (session.activeCount < session.maxConcurrency && session.queue.length) {
    const batch = session.queue.shift();
    if (!batch) break;
    const runnable = batch.filter((segment) => session.entries.get(segment.id)?.status === "queued");
    if (!runnable.length) continue;
    void runBatch(session, runnable);
  }
}

async function runBatch(session: TranslationSession, segments: TextSegment[]): Promise<void> {
  session.activeCount += 1;
  segments.forEach((segment) => {
    const entry = session.entries.get(segment.id);
    if (entry) entry.status = "running";
  });
  renderTranslationPlaceholders(segments);

  try {
    const data = await sendRuntimeRequest<TranslateBatchResponse>({
      type: "TRANSLATE_BATCH",
      texts: segments.map((segment) => segment.text),
      sourceLang: session.settings.sourceLang,
      targetLang: session.settings.targetLang,
      providerId: session.settings.activeProviderId
    } satisfies RuntimeRequest);
    if (!isActive(session)) return;

    renderTranslations(
      segments.map((segment, index) => ({
        id: segment.id,
        text: data.translations[index]
      }))
    );
    session.cached += data.cached;
    session.translated += segments.length;
    segments.forEach((segment) => {
      const entry = session.entries.get(segment.id);
      if (entry) entry.status = "done";
    });
  } catch (error) {
    if (!isActive(session)) return;
    clearTranslationPlaceholders(segments);
    session.failed += segments.length;
    session.firstError ??= error instanceof Error ? error.message : String(error);
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
    }
  }
}

function handleViewportChange(): void {
  if (viewportTimer !== undefined) window.clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(() => {
    viewportTimer = undefined;
    const session = activeSession;
    if (session) scheduleNearbySegments(session);
  }, VIEWPORT_DEBOUNCE_MS);
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

function groupSegments(segments: TextSegment[], maxChars: number): TextSegment[][] {
  const groups: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentLength = 0;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const normalizedSegment = text === segment.text ? segment : { ...segment, text };
    if (current.length && currentLength + normalizedSegment.text.length > maxChars) {
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

function getProgressiveChunkSize(settings: ExtensionSettings): number {
  const performance = getPageProviderPerformance(settings);
  return Math.max(200, Math.min(MAX_PROGRESSIVE_CHUNK_SIZE, performance.chunkSize));
}

function getPageProviderPerformance(settings: ExtensionSettings): {
  chunkSize: number;
  concurrency: number;
} {
  // Keep this calculation local so Vite does not add a shared import to the MV3 content script.
  const provider = settings.providers.find((entry) => entry.id === settings.activeProviderId);
  if (provider?.performanceMode !== "custom") {
    return { chunkSize: settings.chunkSize, concurrency: settings.concurrency };
  }
  return {
    chunkSize: clampPerformanceValue(provider.chunkSize, 200, 4000, settings.chunkSize),
    concurrency: Math.min(
      settings.concurrency,
      clampPerformanceValue(provider.concurrency, 1, 8, settings.concurrency)
    )
  };
}

function clampPerformanceValue(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
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
  window.removeEventListener("scroll", handleViewportChange);
  window.removeEventListener("resize", handleViewportChange);
  if (!session) return;
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
    remaining: [...session.entries.values()].filter((entry) => entry.status === "idle").length
  };
}

function emptyResult(): PageTranslationResult {
  return { translated: 0, cached: 0, failed: 0, remaining: 0 };
}
