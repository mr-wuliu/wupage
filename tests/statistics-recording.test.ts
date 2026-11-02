import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { STATISTICS_KEY, statisticsDates, summarizeStatistics } from "../src/shared/statistics";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";

describe("local statistics recording", () => {
  let local: Record<string, unknown>, session: Record<string, unknown>, settings: ExtensionSettings;
  let module: typeof import("../src/background/statistics");
  let localSet: ReturnType<typeof vi.fn>;
  let notify: (changes: Record<string, unknown>, area: string) => void;
  const provider: ProviderConfig = { ...DEFAULT_SETTINGS.providers.find(provider => provider.type === "openai-compatible")!,
    id: "stats-model", label: "Test service", apiKey: "secret-key", model: "model-a", ollamaCompatibility: false } as ProviderConfig;

  beforeEach(async () => {
    vi.resetModules();
    settings = { ...structuredClone(DEFAULT_SETTINGS), statisticsEnabled: true, cacheEnabled: false,
      providers: [provider], activeProviderId: provider.id };
    local = { [SETTINGS_KEY]: settings }; session = {};
    const storage = (data: Record<string, unknown>) => ({
      get: vi.fn(async (keys: string | string[] | null) => structuredClone(keys === null ? data
        : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])))),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
      remove: vi.fn(async (key: string) => { delete data[key]; })
    });
    const localStorage = storage(local); localSet = localStorage.set;
    vi.stubGlobal("chrome", { storage: { local: localStorage, session: storage(session), onChanged: {
      addListener: (listener: typeof notify) => { notify = listener; }
    } } });
    module = await import("../src/background/statistics"); module.initStatistics();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const disable = () => { settings.statisticsEnabled = false; notify({ [SETTINGS_KEY]: {
    oldValue: { statisticsEnabled: true }, newValue: { statisticsEnabled: false }
  } }, "local"); };

  it("does no statistics reads or writes when disabled", async () => {
    expect(module.createStatisticsRecorder({ ...settings, statisticsEnabled: false })).toBeUndefined();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
  });

  it("preserves all concurrent updates, model changes and page deduplication", async () => {
    const recorder = module.createStatisticsRecorder(settings)!;
    await Promise.all(Array.from({ length: 24 }, (_, index) => recorder.call({ ...provider, model: index % 2 ? "model-b" : "model-a" } as ProviderConfig,
      ["private source text"], async usage => { usage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); return ["private translation"]; })));
    await Promise.all(Array.from({ length: 8 }, () => recorder.result("https://private.example.com/document", 2, 2)));
    const stats = await module.getStatistics();
    const summary = summarizeStatistics(stats, 7);
    expect(summary.totals).toMatchObject({ requests: 24, succeeded: 24, failed: 0, totalTokens: 360, pages: 1, cachedTexts: 16 });
    expect(summary.models.map(model => model.requests)).toEqual([12, 12]);
    const stored = JSON.stringify({ stats: local[STATISTICS_KEY], session });
    for (const secret of ["secret-key", "private source text", "private translation", "private.example.com"]) expect(stored).not.toContain(secret);
  });

  it("records reported Token usage even if a response fails validation", async () => {
    const recorder = module.createStatisticsRecorder(settings)!;
    const failure = new Error("bad translation format");
    await expect(recorder.call(provider, ["source"], async usage => {
      usage({ usage: { input_tokens: 20, output_tokens: 10 } }); throw failure;
    })).rejects.toBe(failure);
    expect(summarizeStatistics(await module.getStatistics(), 7).totals).toMatchObject({ requests: 1, failed: 1, totalTokens: 30, reportedUsage: 1, pages: 0 });
  });

  it.each(["disable", "clear"])("drops in-flight data after %s", async action => {
    const recorder = module.createStatisticsRecorder(settings)!;
    let finish!: () => void;
    const pending = recorder.call(provider, ["source"], async usage => {
      await new Promise<void>(resolve => { finish = resolve; }); usage({ usage: { total_tokens: 30 } }); return ["translated"];
    });
    if (action === "clear") await module.clearStatistics(); else disable();
    finish(); await pending;
    await recorder.result("old-page", 0, 1);
    expect((await module.getStatistics()).days).toEqual([]);
  });

  it("does not revive an old recorder when re-enabled", async () => {
    const old = module.createStatisticsRecorder(settings)!;
    disable(); settings.statisticsEnabled = true;
    notify({ [SETTINGS_KEY]: { oldValue: { statisticsEnabled: false }, newValue: { statisticsEnabled: true } } }, "local");
    await old.result("page", 0, 1);
    const fresh = module.createStatisticsRecorder(settings)!;
    await fresh.result("page", 0, 1);
    expect(summarizeStatistics(await module.getStatistics(), 7).totals.pages).toBe(1);
  });

  it("deduplicates pages across background restarts and clears identities with statistics", async () => {
    await module.createStatisticsRecorder(settings)!.result("same-page", 1, 1);
    vi.resetModules(); module = await import("../src/background/statistics");
    await module.createStatisticsRecorder(settings)!.result("same-page", 1, 1);
    expect(summarizeStatistics(await module.getStatistics(), 7).totals).toMatchObject({ pages: 1, requests: 0, cachedTexts: 2 });
    await module.clearStatistics();
    expect(session).toEqual({});
    expect(local[SETTINGS_KEY]).toBe(settings);
    await module.createStatisticsRecorder(settings)!.result("same-page", 0, 1);
    expect(summarizeStatistics(await module.getStatistics(), 7).totals.pages).toBe(1);
  });

  it("does not fail translations when statistics storage is unavailable", async () => {
    localSet.mockRejectedValue(new Error("quota exceeded"));
    const recorder = module.createStatisticsRecorder(settings)!;
    await expect(recorder.call(provider, ["source"], async () => ["translated"])).resolves.toEqual(["translated"]);
    await expect(recorder.result("page", 0, 1)).resolves.toBeUndefined();
    const error = new Error("provider failed");
    await expect(recorder.call(provider, ["source"], async () => { throw error; })).rejects.toBe(error);
  });

  it("actually removes expired history when viewing statistics", async () => {
    local[STATISTICS_KEY] = { version: 1, days: [{ date: statisticsDates(100)[0], requests: 999 }] };
    expect((await module.getStatistics()).days).toEqual([]);
    expect(local[STATISTICS_KEY]).toEqual({ version: 1, days: [] });
  });

  it("records real provider response usage and excludes cache hits from requests", async () => {
    settings.cacheEnabled = true;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["你好"]' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })));
    vi.stubGlobal("fetch", fetchMock);
    const { translateWithSettings } = await import("../src/background/translation");
    const request = { texts: ["Hello"], targetLang: "zh-CN", pageSession: { id: "page-session", documentKey: "frame-a" } };
    expect((await translateWithSettings(settings, request)).cached).toBe(0);
    expect((await translateWithSettings(settings, { ...request, pageSession: { ...request.pageSession, documentKey: "frame-b" } })).cached).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(summarizeStatistics(await module.getStatistics(), 7).totals).toMatchObject({ requests: 1, succeeded: 1, totalTokens: 12, reportedUsage: 1, pages: 1, cachedTexts: 1 });
  });
});
