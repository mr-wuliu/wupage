export const STATISTICS_KEY = "wupage.statistics.v1";
export const STATISTICS_RETENTION_DAYS = 90;

export interface UsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  characters: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reportedUsage: number;
}

export interface ModelUsage extends UsageTotals {
  providerId: string;
  providerLabel: string;
  model: string;
}

export interface DailyUsage extends UsageTotals {
  date: string;
  pages: number;
  cachedTexts: number;
  models: ModelUsage[];
  /** Local minute of day; only minutes with calls are stored. */
  minutes: Record<string, number>;
}

export interface UsageStatistics {
  version: 1;
  days: DailyUsage[];
}

export function emptyUsageTotals(): UsageTotals {
  return { requests: 0, succeeded: 0, failed: 0, durationMs: 0, characters: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, reportedUsage: 0 };
}

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function statisticsDates(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    date.setDate(date.getDate() - (count - index - 1));
    return localDateKey(date);
  });
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  for (const key of Object.keys(emptyUsageTotals()) as Array<keyof UsageTotals>) target[key] += source[key];
}

/** Missing token counts stay unknown. Never estimate billed tokens from text length. */
export function readTokenUsage(payload: unknown): Pick<UsageTotals, "inputTokens" | "outputTokens" | "totalTokens" | "reportedUsage"> {
  const empty = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reportedUsage: 0 };
  if (!isRecord(payload)) return empty;
  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const input = tokenCount(usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt_eval_count);
  const output = tokenCount(usage.completion_tokens ?? usage.output_tokens ?? usage.eval_count);
  let total = tokenCount(usage.total_tokens);
  // Anthropic reports cache creation/read input separately from input_tokens.
  const cacheRead = tokenCount(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens) ?? 0;
  const inputTokens = (input ?? 0) + cacheRead + cacheWrite;
  if (total === undefined && input !== undefined && output !== undefined) total = inputTokens + output;
  if (total === undefined) return empty;
  return { inputTokens, outputTokens: output ?? 0, totalTokens: total, reportedUsage: 1 };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeStatistics(value: unknown, now = new Date()): UsageStatistics {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.days)) return { version: 1, days: [] };
  const dates = new Set(statisticsDates(STATISTICS_RETENTION_DAYS, now));
  const totals = (raw: Record<string, unknown>): UsageTotals => Object.fromEntries(
    Object.keys(emptyUsageTotals()).map(key => [key, tokenCount(raw[key]) ?? 0])
  ) as unknown as UsageTotals;
  const days: DailyUsage[] = [];
  for (const raw of value.days) {
    if (!isRecord(raw) || typeof raw.date !== "string" || !dates.delete(raw.date)) continue;
    days.push({ ...totals(raw), date: raw.date, pages: tokenCount(raw.pages) ?? 0, cachedTexts: tokenCount(raw.cachedTexts) ?? 0,
      models: Array.isArray(raw.models) ? raw.models.filter(isRecord).filter(model => typeof model.providerId === "string"
        && typeof model.providerLabel === "string" && typeof model.model === "string").map(model => ({ ...totals(model),
          providerId: String(model.providerId), providerLabel: String(model.providerLabel), model: String(model.model) })) : [],
      minutes: isRecord(raw.minutes) ? Object.fromEntries(Object.entries(raw.minutes)
        .filter(([key, count]) => /^\d{1,4}$/.test(key) && Number(key) < 1440 && tokenCount(count) !== undefined)) as Record<string, number> : {}
    });
  }
  return { version: 1, days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

export function summarizeStatistics(statistics: UsageStatistics, count: number, now = new Date()) {
  const dates = statisticsDates(count, now);
  const days = dates.map(date => statistics.days.find(day => day.date === date)
    ?? { ...emptyUsageTotals(), date, pages: 0, cachedTexts: 0, models: [], minutes: {} } as DailyUsage);
  const totals = { ...emptyUsageTotals(), pages: 0, cachedTexts: 0 };
  const models = new Map<string, ModelUsage>();
  const hours = Array<number>(24).fill(0);
  let peakPerMinute = 0, activeMinutes = 0;
  for (const day of days) {
    addUsageTotals(totals, day); totals.pages += day.pages; totals.cachedTexts += day.cachedTexts;
    for (const model of day.models) {
      const key = JSON.stringify([model.providerId, model.model]);
      const entry = models.get(key) ?? { ...model, ...emptyUsageTotals() };
      addUsageTotals(entry, model); models.set(key, entry);
    }
    for (const [minute, calls] of Object.entries(day.minutes)) {
      hours[Math.floor(Number(minute) / 60)] += calls;
      peakPerMinute = Math.max(peakPerMinute, calls);
      if (calls) activeMinutes++;
    }
  }
  return { days, totals, models: [...models.values()].sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens),
    hours, peakPerMinute, averagePerActiveMinute: activeMinutes ? totals.requests / activeMinutes : 0 };
}
