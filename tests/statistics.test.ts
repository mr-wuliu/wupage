import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { emptyUsageTotals, localDateKey, normalizeStatistics, readTokenUsage, statisticsDates, summarizeStatistics } from "../src/shared/statistics";

describe("opt-in statistics and usage parsing", () => {
  it("requires an explicit boolean opt-in, including after settings migration", () => {
    expect(DEFAULT_SETTINGS.statisticsEnabled).toBe(false);
    for (const value of [undefined, null, "true", 1, {}, false]) expect(normalizeSettings({ statisticsEnabled: value }).statisticsEnabled).toBe(false);
    expect(normalizeSettings({ statisticsEnabled: true }).statisticsEnabled).toBe(true);
  });

  it.each([
    [{ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }, [12, 8, 20]],
    [{ usage: { input_tokens: 12, output_tokens: 8 } }, [12, 8, 20]],
    [{ usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } }, [52, 8, 60]],
    [{ prompt_eval_count: 12, eval_count: 8 }, [12, 8, 20]],
    [{ usage: { total_tokens: 20 } }, [0, 0, 20]],
    [{ usage: { input_tokens: 0, output_tokens: 0 } }, [0, 0, 0]]
  ])("uses reported counts without double-counting cache details: %j", (payload, expected) => {
    const usage = readTokenUsage(payload);
    expect([usage.inputTokens, usage.outputTokens, usage.totalTokens]).toEqual(expected);
    expect(usage.reportedUsage).toBe(1);
  });

  it.each([undefined, null, {}, { usage: {} }, { usage: { input_tokens: 12 } },
    { usage: { total_tokens: "20" } }, { usage: { total_tokens: -1 } }, { usage: { total_tokens: Infinity } }, { usage: { total_tokens: 2.5 } }])(
    "keeps absent or invalid usage unknown: %j", payload => {
      expect(readTokenUsage(payload)).toMatchObject({ totalTokens: 0, reportedUsage: 0 });
    }
  );
});

describe("calendar-based usage summaries", () => {
  const now = new Date(2026, 10, 2, 0, 5);
  it("uses local calendar days over month and year boundaries", () => {
    expect(localDateKey(now)).toBe("2026-11-02");
    expect(statisticsDates(4, now)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(statisticsDates(2, new Date(2027, 0, 1))).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("prunes expired/future/duplicate days and malformed data", () => {
    const stats = normalizeStatistics({ version: 1, days: [
      { date: "2026-01-01", requests: 100 }, { date: "2027-01-01", requests: 100 },
      { date: "2026-11-02", requests: 2, failed: -1, pages: "3", minutes: { "0": 2, "1440": 9, "-1": 9, "2": -1 }, models: [null, {}] },
      { date: "2026-11-02", requests: 99 }, null
    ] }, now);
    expect(stats.days).toHaveLength(1);
    expect(stats.days[0]).toMatchObject({ requests: 2, failed: 0, pages: 0, minutes: { "0": 2 }, models: [] });
  });

  it("fills zero days, ranks each provider/model pair and aggregates frequency", () => {
    const day = (date: string, requests: number, model: string, providerId = "first") => ({
      ...emptyUsageTotals(), date, requests, succeeded: requests, pages: 1, cachedTexts: 2, minutes: { "60": requests },
      models: [{ ...emptyUsageTotals(), providerId, providerLabel: providerId, model, requests, succeeded: requests }]
    });
    const stats = normalizeStatistics({ version: 1, days: [day("2026-11-01", 3, "model-a"), day("2026-11-02", 5, "model-a", "second"), day("2026-10-01", 10, "old-model")] }, now);
    const summary = summarizeStatistics(stats, 7, now);
    expect(summary.days).toHaveLength(7);
    expect(summary.days[0].requests).toBe(0);
    expect(summary.totals).toMatchObject({ pages: 2, requests: 8, cachedTexts: 4 });
    expect(summary.models.map(model => [model.providerId, model.requests])).toEqual([["second", 5], ["first", 3]]);
    expect(summary.hours[1]).toBe(8);
    expect(summary.peakPerMinute).toBe(5);
    expect(summary.averagePerActiveMinute).toBe(4);
  });
});
