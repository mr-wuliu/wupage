import { CACHE_PREFIX } from "../shared/defaults";
import { sha256 } from "../shared/hash";
import type {
  ExtensionSettings,
  ProviderConfig,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslationDebugSnapshot,
  TranslationDebugTask
} from "../shared/types";
import { createProvider } from "./providers";

const providerLimiters = new Map<string, ProviderLimiter>();
const debugTasks: TranslationDebugTask[] = [];
let nextDebugTaskId = 1;
const MAX_DEBUG_TASKS = 100;

export async function translateWithSettings(
  settings: ExtensionSettings,
  request: TranslateBatchRequest
): Promise<TranslateBatchResponse> {
  const providerId = request.providerId ?? settings.activeProviderId;
  const providerConfig = settings.providers.find((provider) => provider.id === providerId);
  if (!providerConfig) throw new Error(`Provider not found: ${providerId}`);
  if (providerConfig.enabled === false) throw new Error(`Provider is disabled: ${providerId}`);

  const provider = createProvider(providerConfig);
  const chunkSize = getEffectiveChunkSize(settings.chunkSize, providerConfig.type);
  const concurrency = getEffectiveConcurrency(settings.concurrency);
  const cachedTranslations = new Map<number, string>();
  const uncachedTexts: string[] = [];
  const uncachedIndexes: number[] = [];

  for (const [index, text] of request.texts.entries()) {
    const cached = settings.cacheEnabled
      ? await readCachedTranslation(providerId, request.targetLang, text)
      : undefined;
    if (cached !== undefined) {
      cachedTranslations.set(index, cached);
    } else {
      uncachedIndexes.push(index);
      uncachedTexts.push(text);
    }
  }

  const translated = await runBatches(
    uncachedTexts,
    chunkSize,
    concurrency,
    async (texts) =>
      runProviderTask(providerConfig, request, texts, concurrency, () =>
        provider.translateBatch({ ...request, texts })
      )
  );

  const output = Array<string>(request.texts.length);
  for (const [index, value] of cachedTranslations) output[index] = value;

  for (const [translatedIndex, sourceIndex] of uncachedIndexes.entries()) {
    const translation = translated[translatedIndex];
    output[sourceIndex] = translation;
    if (settings.cacheEnabled) {
      await writeCachedTranslation(providerId, request.targetLang, request.texts[sourceIndex], translation);
    }
  }

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

function getEffectiveChunkSize(chunkSize: number, providerType: string): number {
  if (isLlmProvider(providerType)) return Math.max(chunkSize, 3200);
  return chunkSize;
}

function getEffectiveConcurrency(concurrency: number): number {
  return concurrency;
}

function isLlmProvider(providerType: string): boolean {
  return providerType === "openai-compatible"
    || providerType === "anthropic-compatible"
    || providerType === "zhipu-glm";
}

async function runProviderTask(
  providerConfig: ProviderConfig,
  request: TranslateBatchRequest,
  texts: string[],
  concurrency: number,
  task: () => Promise<string[]>
): Promise<string[]> {
  const debugTask = createDebugTask(providerConfig, request, texts);
  const release = await acquireProviderSlot(
    providerConfig.id,
    getProviderConcurrency(concurrency),
    debugTask
  );

  debugTask.status = "running";
  debugTask.startedAt = Date.now();
  try {
    const result = await task();
    debugTask.status = "succeeded";
    debugTask.finishedAt = Date.now();
    debugTask.translatedTexts = result;
    return result;
  } catch (error) {
    debugTask.status = "failed";
    debugTask.finishedAt = Date.now();
    debugTask.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    release();
  }
}

function getProviderConcurrency(concurrency: number): number {
  return Math.max(1, concurrency);
}

function createDebugTask(
  providerConfig: ProviderConfig,
  request: TranslateBatchRequest,
  texts: string[]
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
  key: string,
  maxConcurrency: number,
  debugTask: TranslationDebugTask
): Promise<() => void> {
  const limiter = getProviderLimiter(key);
  limiter.maxConcurrency = maxConcurrency;
  if (limiter.active < limiter.maxConcurrency) {
    limiter.active += 1;
    return () => releaseProviderSlot(limiter);
  }

  debugTask.status = "queued";
  return new Promise((resolve) => {
    limiter.queue.push(() => {
      limiter.active += 1;
      resolve(() => releaseProviderSlot(limiter));
    });
  });
}

function getProviderLimiter(key: string): ProviderLimiter {
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
    const next = limiter.queue.shift();
    if (!next) return;
    next();
  }
}

interface ProviderLimiter {
  active: number;
  maxConcurrency: number;
  queue: Array<() => void>;
}

export function groupTexts(texts: string[], maxChars: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const text of texts) {
    if (current.length && currentLength + text.length > maxChars) {
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
  concurrency: number,
  translate: (texts: string[]) => Promise<string[]>
): Promise<string[]> {
  const groups = groupTexts(texts, maxChars);
  const results: string[][] = Array(groups.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < groups.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await translate(groups[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  return results.flat();
}

async function readCachedTranslation(
  providerId: string,
  targetLang: string,
  text: string
): Promise<string | undefined> {
  const key = await cacheKey(providerId, targetLang, text);
  const result = await chrome.storage.local.get(key);
  return typeof result[key] === "string" ? result[key] : undefined;
}

async function writeCachedTranslation(
  providerId: string,
  targetLang: string,
  text: string,
  translation: string
): Promise<void> {
  const key = await cacheKey(providerId, targetLang, text);
  await chrome.storage.local.set({ [key]: translation });
}

async function cacheKey(providerId: string, targetLang: string, text: string): Promise<string> {
  return `${CACHE_PREFIX}${providerId}.${targetLang}.${await sha256(text)}`;
}
