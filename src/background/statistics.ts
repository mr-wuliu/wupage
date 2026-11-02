import { SETTINGS_KEY } from "../shared/defaults";
import { sha256 } from "../shared/hash";
import { getSettings } from "../shared/settings";
import { addUsageTotals, emptyUsageTotals, localDateKey, normalizeStatistics, readTokenUsage, STATISTICS_KEY,
  type DailyUsage, type UsageStatistics } from "../shared/statistics";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";

const PAGE_SESSIONS_KEY = "wupage.statistics.pages";
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
let pageSessions = new Set<string>();

export function initStatistics(): void {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const current = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    const previous = changes[SETTINGS_KEY]?.oldValue as ExtensionSettings | undefined;
    if (area === "local" && changes[SETTINGS_KEY]
      && current?.statisticsEnabled !== previous?.statisticsEnabled) generation++;
  });
}

function serial<T>(run: () => Promise<T>): Promise<T> {
  const task = queue.then(run);
  queue = task.catch(() => undefined);
  return task;
}

export function getStatistics(): Promise<UsageStatistics> {
  return serial(async () => {
    const stored = (await chrome.storage.local.get(STATISTICS_KEY))[STATISTICS_KEY];
    const statistics = normalizeStatistics(stored);
    if (stored && JSON.stringify(stored) !== JSON.stringify(statistics)) await chrome.storage.local.set({ [STATISTICS_KEY]: statistics });
    return statistics;
  });
}

export function clearStatistics(): Promise<void> {
  generation++;
  return serial(async () => {
    await chrome.storage.local.remove(STATISTICS_KEY);
    pageSessions.clear();
    await chrome.storage.session?.remove(PAGE_SESSIONS_KEY);
  });
}

/** Browser document identity is used only for local deduplication, never stored as a URL. */
export function statisticsPageKey(sender: chrome.runtime.MessageSender): string | undefined {
  return sender.tab?.id === undefined ? undefined
    : `${sender.tab.id}:${sender.documentId ?? sender.url ?? sender.frameId ?? 0}`;
}

export function createStatisticsRecorder(settings: ExtensionSettings) {
  if (settings.statisticsEnabled !== true) return undefined;
  const capturedGeneration = generation;
  const update = (timestamp: number, change: (day: DailyUsage) => Promise<void> | void): Promise<void> => serial(async () => {
    if (capturedGeneration !== generation || !(await getSettings()).statisticsEnabled) return;
    const result = await chrome.storage.local.get(STATISTICS_KEY);
    if (capturedGeneration !== generation) return;
    const statistics = normalizeStatistics(result[STATISTICS_KEY]);
    const date = localDateKey(new Date(timestamp));
    let day = statistics.days.find(entry => entry.date === date);
    if (!day) { day = { ...emptyUsageTotals(), date, pages: 0, cachedTexts: 0, models: [], minutes: {} }; statistics.days.push(day); }
    await change(day);
    if (capturedGeneration !== generation) return;
    await chrome.storage.local.set({ [STATISTICS_KEY]: normalizeStatistics(statistics) });
  }).catch(() => undefined); // Optional statistics must never break translation.

  return {
    async call<T>(provider: ProviderConfig, texts: string[], run: (onUsage: (payload: unknown) => void) => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      const totals = emptyUsageTotals();
      totals.requests = 1;
      totals.characters = texts.reduce((sum, text) => sum + text.length, 0);
      const onUsage = (payload: unknown) => {
        const usage = readTokenUsage(payload);
        totals.inputTokens += usage.inputTokens; totals.outputTokens += usage.outputTokens; totals.totalTokens += usage.totalTokens;
        totals.reportedUsage = Math.max(totals.reportedUsage, usage.reportedUsage);
      };
      try { const result = await run(onUsage); totals.succeeded = 1; return result; }
      catch (error) { totals.failed = 1; throw error; }
      finally {
        totals.durationMs = Math.max(0, Date.now() - startedAt);
        await update(startedAt, day => {
          addUsageTotals(day, totals);
          const date = new Date(startedAt), minute = String(date.getHours() * 60 + date.getMinutes());
          day.minutes[minute] = (day.minutes[minute] ?? 0) + 1;
          const model = "model" in provider ? provider.model
            : provider.type === "tencent-transmart" && provider.serviceMode === "api" ? provider.api?.model ?? "" : "";
          let entry = day.models.find(entry => entry.providerId === provider.id && entry.model === model);
          if (!entry) { entry = { ...emptyUsageTotals(), providerId: provider.id, providerLabel: provider.label, model }; day.models.push(entry); }
          addUsageTotals(entry, totals);
        });
      }
    },
    async result(pageKey: string | undefined, cachedTexts: number, translatedTexts: number): Promise<void> {
      const timestamp = Date.now();
      await update(timestamp, async day => {
        day.cachedTexts += cachedTexts;
        if (!pageKey || !translatedTexts) return;
        const key = `${day.date}:${await sha256(pageKey)}`;
        const stored = await chrome.storage.session?.get(PAGE_SESSIONS_KEY);
        if (Array.isArray(stored?.[PAGE_SESSIONS_KEY])) pageSessions = new Set(stored[PAGE_SESSIONS_KEY]);
        // Only live browser sessions need identities; persisted history contains aggregates only.
        pageSessions = new Set([...pageSessions].filter(value => value.startsWith(`${day.date}:`)));
        if (pageSessions.has(key)) return;
        day.pages++;
        pageSessions.add(key);
        await chrome.storage.session?.set({ [PAGE_SESSIONS_KEY]: [...pageSessions] });
      });
    }
  };
}

export type StatisticsRecorder = ReturnType<typeof createStatisticsRecorder>;
