import { CACHE_PREFIX, SETTINGS_KEY } from "../shared/defaults";
import type { ExtensionSettings } from "../shared/types";

let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

export function initTranslationCache(): void {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const change = changes[SETTINGS_KEY];
    if (area === "local" && (change?.newValue as ExtensionSettings | undefined)?.cacheEnabled === false
      && (change.oldValue as ExtensionSettings | undefined)?.cacheEnabled !== false) generation++;
  });
}

export function currentCacheGeneration(): number {
  return generation;
}

function serial<T>(run: () => Promise<T>): Promise<T> {
  const task = queue.then(run);
  queue = task.catch(() => undefined);
  return task;
}

export function clearTranslationCache(): Promise<{ removed: number }> {
  // Invalidate obsolete work now and wait for any write already in storage.
  generation++;
  return serial(async () => {
    const keys = await cacheKeys();
    if (keys.length) await chrome.storage.local.remove(keys);
    return { removed: keys.length };
  });
}

export function writeTranslationCache(items: Record<string, unknown>, started: number, signal?: AbortSignal): Promise<void> {
  if (!Object.keys(items).length) return Promise.resolve();
  const current = () => started === generation && !signal?.aborted;
  return serial(async () => {
    if (!current()) return;
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as ExtensionSettings | undefined;
    if (!current() || stored?.cacheEnabled === false) return;
    try {
      await chrome.storage.local.set(items);
    } catch {
      if (!current()) return;
      const keys = await cacheKeys();
      if (!current()) return;
      // Reclaim space once if storage rejected the write.
      if (keys.length) await chrome.storage.local.remove(keys.slice(0, Math.ceil(keys.length / 2)));
      if (current()) await chrome.storage.local.set(items);
    }
  }).catch(() => undefined); // Storage availability must not discard the translation.
}

async function cacheKeys(): Promise<string[]> {
  const local = chrome.storage.local as typeof chrome.storage.local & { getKeys?: () => Promise<string[]> };
  const keys = typeof local.getKeys === "function" ? await local.getKeys() : Object.keys(await local.get(null));
  return keys.filter(key => key.startsWith(CACHE_PREFIX));
}
