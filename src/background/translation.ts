import { anySignal } from "../shared/abort";
import { CACHE_PREFIX } from "../shared/defaults";
import { sha256 } from "../shared/hash";
import { getEffectiveProviderPerformance, isLlmProvider } from "../shared/performance";
import type {
  ExtensionSettings,
  ProviderConfig,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslationDebugSnapshot,
  TranslationDebugTask
} from "../shared/types";
import { createProvider } from "./providers";
import { normalizeProtectedText } from "../shared/protected-text";
import { translateProtectedText } from "./protected-translation";
import { assertTranslationResponse, TranslationResponseError } from "./translation-response";
import { LOCAL_MODELS } from "../local/models";
import { DOUBAO_PROTOCOL_VERSION } from "../shared/doubao";
import { withDoubaoDeadline } from "./doubao";
import { createStatisticsRecorder, type StatisticsRecorder } from "./statistics";

const GLOBAL_LIMITER = Symbol("global-translation-limiter");
const providerLimiters = new Map<string | symbol, ProviderLimiter>();
const debugTasks: TranslationDebugTask[] = [];
let nextDebugTaskId = 1;
const MAX_DEBUG_TASKS = 100;
const MAX_LLM_BATCH_ITEMS = 16;
/** Bumping this invalidates every persisted translation. */
const CACHE_KEY_VERSION = 5;
/** Proxy fields that only affect scheduling or presentation, never the text. */
const CACHE_KEY_IGNORED_FIELDS = ["label", "enabled", "performanceMode", "chunkSize", "concurrency"] as const;

export interface TranslationTaskOptions {
  signal?: AbortSignal;
  priority?: boolean;
  persistentCache?: boolean;
  statisticsPageKey?: string;
}

export async function translateWithSettings(
  settings: ExtensionSettings,
  request: TranslateBatchRequest,
  options: TranslationTaskOptions = {}
): Promise<TranslateBatchResponse> {
  const { signal } = options;
  signal?.throwIfAborted();
  const providerId = request.providerId ?? settings.activeProviderId;
  const providerConfig = settings.providers.find((provider) => provider.id === providerId);
  if (!providerConfig) throw new Error(`Provider not found: ${providerId}`);
  if (providerConfig.enabled === false) throw new Error(`Provider is disabled: ${providerId}`);

  if (providerConfig.type === "doubao-web") {
    return withDoubaoDeadline(async (deadlineSignal) => {
      const requestSignal = signal ? anySignal([signal, deadlineSignal]) : deadlineSignal;
      // The article endpoint detects its own source language. Browser detection
      // must not gate short paragraphs, titles, or mixed-language batches.
      const sourceLang = request.sourceLang ?? "auto";
      return translateConfigured(settings, { ...request, sourceLang, context: undefined }, providerConfig, { ...options, signal: requestSignal });
    }, signal);
  }
  return translateConfigured(settings, request, providerConfig, options);
}

async function translateConfigured(
  settings: ExtensionSettings,
  request: TranslateBatchRequest,
  providerConfig: ProviderConfig,
  options: TranslationTaskOptions = {}
): Promise<TranslateBatchResponse> {
  const { signal } = options;
  signal?.throwIfAborted();
  const useCache = settings.cacheEnabled && options.persistentCache !== false;
  const providerId = providerConfig.id;
  const provider = createProvider(providerConfig);
  const statistics = createStatisticsRecorder(settings);
  const performance = getEffectiveProviderPerformance(settings, providerId);
  // Model/prompt/source-language changes must not keep serving old translations.
  // Scheduling and presentation fields stay out of the fingerprint: renaming a
  // provider or tuning its concurrency must not discard the whole cache.
  const cacheProviderId = useCache
    ? `${providerId}.${await sha256(JSON.stringify({ version: CACHE_KEY_VERSION, provider: cacheStableProviderConfig(providerConfig), sourceLang: request.sourceLang ?? "auto",
      ...(providerConfig.type === "google-web-translate" && providerConfig.serviceMode !== "api" ? { googleContextVersion: 1 } : {}),
      ...(providerConfig.type === "firefox-local" ? { models: LOCAL_MODELS.map(({ id, version }) => [id, version]) } : {}),
      ...(providerConfig.type === "doubao-web" ? { doubaoProtocolVersion: DOUBAO_PROTOCOL_VERSION, translateService: "1" } : {}),
      // Bump the style version when its built-in translation instructions change.
      ...(request.translationStyle ? { translationStyle: request.translationStyle, translationStyleVersion: 1 } : {}),
      ...(request.preservePlaceholders ? { protectedTextVersion: 1 } : {}) }))}`
    : providerId;
  const cachedTranslations = new Map<number, string>();
  const uncachedTexts: string[] = [];
  const uncachedIndexes: number[] = [];
  // Hash every text once and read the whole batch with a single storage call;
  // a 50-segment page used to cost 50 hashes and 50 IPC round trips here.
  const cacheKeys = useCache
    ? await Promise.all(request.texts.map((text) => cacheKey(cacheProviderId, request.targetLang, text, request.context)))
    : [];
  const storedCache = cacheKeys.length ? await readCachedTranslations(cacheKeys) : {};

  for (const [index, text] of request.texts.entries()) {
    signal?.throwIfAborted();
    const stored = cacheKeys.length ? asCachedTranslation(storedCache[cacheKeys[index]]) : undefined;
    const cached = stored !== undefined && request.preservePlaceholders
      ? normalizeProtectedText(text, stored)
      : stored;
    if (cached !== undefined) {
      cachedTranslations.set(index, cached);
    } else {
      uncachedIndexes.push(index);
      uncachedTexts.push(text);
    }
  }

  const runProviderTexts = (texts: string[]) =>
    runProviderTask(providerConfig, request, texts, performance, settings.concurrency, async () => {
      const result = await translateProviderTexts(providerConfig, provider, request, texts, signal, statistics);
      signal?.throwIfAborted();
      assertTranslationResponse(result, texts.length);
      return result;
    }, signal, options.priority ? 2 : request.pageSession ? 0 : 1);
  const translated = await runBatches(
    uncachedTexts,
    performance.chunkSize,
    providerConfig.type === "doubao-web" ? 10 : isLlmProvider(providerConfig) ? MAX_LLM_BATCH_ITEMS : Number.POSITIVE_INFINITY,
    performance.concurrency,
    (texts) => translateProviderBatchWithRecovery(providerConfig, texts, runProviderTexts)
  );

  const output = Array<string>(request.texts.length);
  signal?.throwIfAborted();
  for (const [index, value] of cachedTranslations) output[index] = value;

  const pendingCacheWrites: Record<string, string> = {};
  for (const [translatedIndex, sourceIndex] of uncachedIndexes.entries()) {
    signal?.throwIfAborted();
    const translation = translated[translatedIndex];
    output[sourceIndex] = translation;
    if (useCache) pendingCacheWrites[cacheKeys[sourceIndex]] = translation;
  }
  await writeCachedTranslations(pendingCacheWrites);

  signal?.throwIfAborted();
  await statistics?.result(request.pageSession?.id ?? options.statisticsPageKey, cachedTranslations.size, output.length);
  return {
    translations: output,
    cached: cachedTranslations.size
  };
}

export function getTranslationDebugSnapshot(): TranslationDebugSnapshot {
  const activeCount = debugTasks.filter(
    (task) => task.status === "running" || task.status === "waiting"
  ).length;
  const queuedCount = debugTasks.filter((task) => task.status === "queued").length;
  return {
    tasks: [...debugTasks].reverse(),
    activeCount,
    queuedCount
  };
}

export async function clearTranslationCache(): Promise<{ removed: number }> {
  const items = await chrome.storage.local.get(null);
  const keys = Object.keys(items).filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return { removed: keys.length };
}

async function runProviderTask(
  providerConfig: ProviderConfig,
  request: TranslateBatchRequest,
  texts: string[],
  performance: ReturnType<typeof getEffectiveProviderPerformance>,
  globalConcurrency: number,
  task: () => Promise<string[]>,
  signal?: AbortSignal,
  priority = 1
): Promise<string[]> {
  const debugTask = createDebugTask(providerConfig, request, texts, performance);
  let release: (() => void) | undefined;
  try {
    release = await acquireTaskSlots(
      providerConfig.id, performance.concurrency, globalConcurrency, debugTask, signal, priority
    );
    signal?.throwIfAborted();
    debugTask.status = "running";
    debugTask.startedAt = Date.now();
    const result = await task();
    signal?.throwIfAborted();
    debugTask.status = "succeeded";
    debugTask.finishedAt = Date.now();
    debugTask.translatedTexts = result.map(truncateDebugText);
    return result;
  } catch (error) {
    debugTask.status = "failed";
    debugTask.finishedAt = Date.now();
    debugTask.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    release?.();
  }
}

function createDebugTask(
  providerConfig: ProviderConfig,
  request: TranslateBatchRequest,
  texts: string[],
  performance: ReturnType<typeof getEffectiveProviderPerformance>
): TranslationDebugTask {
  const task: TranslationDebugTask = {
    id: nextDebugTaskId,
    providerId: providerConfig.id,
    providerLabel: providerConfig.label,
    status: "queued",
    textCount: texts.length,
    charCount: texts.reduce((sum, text) => sum + text.length, 0),
    createdAt: Date.now(),
    sourceLang: request.sourceLang ?? "auto",
    targetLang: request.targetLang,
    chunkSize: performance.chunkSize,
    concurrency: performance.concurrency,
    performanceMode: performance.performanceMode,
    sourceTexts: texts.map(truncateDebugText)
  };
  nextDebugTaskId += 1;
  debugTasks.push(task);
  if (debugTasks.length > MAX_DEBUG_TASKS) {
    debugTasks.splice(0, debugTasks.length - MAX_DEBUG_TASKS);
  }
  return task;
}

function truncateDebugText(text: string): string {
  return text.length > 1600 ? `${text.slice(0, 1600)}...` : text;
}

async function acquireProviderSlot(
  key: string | symbol,
  maxConcurrency: number,
  debugTask: TranslationDebugTask,
  signal?: AbortSignal,
  priority = 0
): Promise<() => void> {
  signal?.throwIfAborted();
  const limiter = getProviderLimiter(key);
  limiter.maxConcurrency = maxConcurrency;
  if (limiter.active < limiter.maxConcurrency) {
    limiter.active += 1;
    return () => releaseProviderSlot(limiter);
  }

  debugTask.status = "queued";
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = limiter.queue.indexOf(entry);
      if (index !== -1) limiter.queue.splice(index, 1);
      reject(signal!.reason);
    };
    const enter = () => {
      signal?.removeEventListener("abort", abort);
      limiter.active += 1;
      resolve(() => releaseProviderSlot(limiter));
    };
    const entry = { enter, priority };
    signal?.addEventListener("abort", abort, { once: true });
    limiter.queue.push(entry);
  });
}

async function acquireTaskSlots(
  providerId: string,
  providerConcurrency: number,
  globalConcurrency: number,
  debugTask: TranslationDebugTask,
  signal?: AbortSignal,
  priority = 0
): Promise<() => void> {
  const releaseProvider = await acquireProviderSlot(
    providerId,
    Math.max(1, providerConcurrency),
    debugTask,
    signal,
    priority
  );
  try {
    const releaseGlobal = await acquireProviderSlot(
      GLOBAL_LIMITER,
      Math.max(1, globalConcurrency),
      debugTask,
      signal,
      priority
    );
    return () => {
      releaseGlobal();
      releaseProvider();
    };
  } catch (error) {
    releaseProvider();
    throw error;
  }
}

function getProviderLimiter(key: string | symbol): ProviderLimiter {
  const existing = providerLimiters.get(key);
  if (existing) return existing;
  const limiter: ProviderLimiter = {
    active: 0,
    maxConcurrency: 1,
    queue: []
  };
  providerLimiters.set(key, limiter);
  return limiter;
}

function releaseProviderSlot(limiter: ProviderLimiter): void {
  limiter.active = Math.max(0, limiter.active - 1);
  while (limiter.active < limiter.maxConcurrency && limiter.queue.length) {
    const priority = limiter.queue.reduce((highest, entry) => Math.max(highest, entry.priority), 0);
    const index = limiter.queue.findIndex(entry => entry.priority === priority);
    const [next] = limiter.queue.splice(index, 1);
    if (!next) return;
    next.enter();
  }
}

interface ProviderLimiter {
  active: number;
  maxConcurrency: number;
  queue: Array<{ enter: () => void; priority: number }>;
}

export function groupTexts(
  texts: string[],
  maxChars: number,
  maxItems = Number.POSITIVE_INFINITY
): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const text of texts) {
    if (current.length && (currentLength + text.length > maxChars || current.length >= maxItems)) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(text);
    currentLength += text.length;
  }

  if (current.length) groups.push(current);
  return groups;
}

async function runBatches(
  texts: string[],
  maxChars: number,
  maxItems: number,
  concurrency: number,
  translate: (texts: string[]) => Promise<string[]>
): Promise<string[]> {
  const groups = groupTexts(texts, maxChars, maxItems);
  const results: string[][] = Array(groups.length);
  let cursor = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && cursor < groups.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await translate(groups[index]); }
      catch (error) { failed = true; throw error; }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  return results.flat();
}

async function translateProviderBatchWithRecovery(
  providerConfig: ProviderConfig,
  texts: string[],
  translate: (texts: string[]) => Promise<string[]>
): Promise<string[]> {
  try {
    return await translate(texts);
  } catch (error) {
    if (!isLlmProvider(providerConfig) || !(error instanceof TranslationResponseError)) throw error;
    if (texts.length === 1) return translate(texts);

    const midpoint = Math.ceil(texts.length / 2);
    const [left, right] = await Promise.all([
      translateProviderBatchWithRecovery(providerConfig, texts.slice(0, midpoint), translate),
      translateProviderBatchWithRecovery(providerConfig, texts.slice(midpoint), translate)
    ]);
    return [...left, ...right];
  }
}

async function translateProviderTexts(
  providerConfig: ProviderConfig,
  provider: ReturnType<typeof createProvider>,
  request: TranslateBatchRequest,
  texts: string[],
  signal?: AbortSignal,
  statistics?: StatisticsRecorder
): Promise<string[]> {
  signal?.throwIfAborted();
  const translate = (part: TranslateBatchRequest) => statistics
    ? statistics.call(providerConfig, part.texts, onUsage => provider.translateBatch(part, signal, onUsage))
    : signal ? provider.translateBatch(part, signal) : provider.translateBatch(part);
  if (request.preservePlaceholders) {
    return translateProtectedText({ ...request, texts }, (part) =>
      translateProviderTexts(providerConfig, provider, { ...part, preservePlaceholders: false }, part.texts, signal, statistics)
    );
  }
  if (providerConfig.type === "doubao-web" || providerConfig.type === "firefox-local"
    || (providerConfig.type === "google-web-translate" && providerConfig.serviceMode !== "api")
    || isLlmProvider(providerConfig) || !request.context || !texts.length) {
    return translate({ ...request, texts });
  }

  const contextualSource = buildContextualSource(request.context, texts);
  const contextualResult = await translate({
    ...request,
    texts: [contextualSource]
  });
  const translations = contextualResult.length === 1
    ? parseContextualTranslation(contextualResult[0], texts.length)
    : null;
  if (translations) {
    // A localized page can mix target-language controls with foreign prose.
    // Detecting the combined text can leave that prose untranslated. Retry only
    // unchanged items through the provider's ordinary per-item language detection.
    if (!request.sourceLang || request.sourceLang === "auto") {
      const unchanged = texts.flatMap((text, index) => translations[index].trim() === text.trim() ? [index] : []);
      if (unchanged.length) {
        const retried = await translate({ ...request, texts: unchanged.map(index => texts[index]) });
        assertTranslationResponse(retried, unchanged.length);
        unchanged.forEach((index, position) => { translations[index] = retried[position]; });
      }
    }
    return translations;
  }

  // Some machine-translation endpoints rewrite unusual delimiters. Fall back
  // to their ordinary batch mode rather than failing the whole page.
  return translate({ ...request, texts });
}

function buildContextualSource(context: string, texts: string[]): string {
  const textLength = texts.reduce((sum, text) => sum + text.length, 0);
  const contextHint = textLength < 300
    ? context.slice(0, 800)
    : context.split("\n", 1)[0]?.slice(0, 240) ?? "";
  const segments = texts.map((text, index) => `⟪WUPAGESEGMENT${index}⟫\n${text}`);
  return [contextHint, ...segments].filter(Boolean).join("\n");
}

function parseContextualTranslation(value: string, expectedLength: number): string[] | null {
  const marker = /[⟪《〈<【\[\{«「『]+\s*WUPAGE\s*SEGMENT\s*(\d+)\s*[⟫》〉>】\]\}»」』]+/gi;
  const matches = [...value.matchAll(marker)];
  if (matches.length !== expectedLength) return null;
  const indexes = matches.map((match) => Number(match[1]));
  if (indexes.some((index, position) => index !== position)) return null;

  const translations = matches.map((match, position) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[position + 1]?.index ?? value.length;
    return value.slice(start, end).trim();
  });
  return translations.every((text) => text.trim()) ? translations : null;
}

async function readCachedTranslations(keys: string[]): Promise<Record<string, unknown>> {
  // One storage round trip per batch instead of one per text.
  return chrome.storage.local.get(keys).catch(() => ({} as Record<string, unknown>));
}

async function writeCachedTranslations(items: Record<string, string>): Promise<void> {
  if (!Object.keys(items).length) return;
  // Cache quota/availability must not discard an otherwise valid translation.
  try {
    await chrome.storage.local.set(items);
  } catch {
    // A full quota used to disable the cache silently and permanently; free the
    // oldest half and retry once so translation memory keeps working.
    await pruneCachedTranslations();
    await chrome.storage.local.set(items).catch(() => undefined);
  }
}

async function pruneCachedTranslations(): Promise<void> {
  const keys = (await readCacheKeys()).filter((key) => key.startsWith(CACHE_PREFIX));
  if (!keys.length) return;
  // Persisted keys come back in insertion order, so the head holds the oldest
  // entries; dropping half of them keeps the freshest translations.
  await chrome.storage.local.remove(keys.slice(0, Math.ceil(keys.length / 2))).catch(() => undefined);
}

async function readCacheKeys(): Promise<string[]> {
  const local = chrome.storage.local as typeof chrome.storage.local & { getKeys?: () => Promise<string[]> };
  if (typeof local.getKeys === "function") return local.getKeys().catch(() => [] as string[]);
  const items = await chrome.storage.local.get(null).catch(() => ({} as Record<string, unknown>));
  return Object.keys(items);
}

function asCachedTranslation(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cacheStableProviderConfig(providerConfig: ProviderConfig): Record<string, unknown> {
  const stable: Record<string, unknown> = { ...providerConfig };
  for (const field of CACHE_KEY_IGNORED_FIELDS) delete stable[field];
  return stable;
}

async function cacheKey(
  providerId: string,
  targetLang: string,
  text: string,
  context?: string
): Promise<string> {
  const contextualText = context ? `${context}\u0000${text}` : text;
  return `${CACHE_PREFIX}${providerId}.${targetLang}.${await sha256(contextualText)}`;
}
