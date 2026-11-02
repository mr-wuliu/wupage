// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { emptyUsageTotals, localDateKey } from "../src/shared/statistics";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("statistics settings and dashboard", () => {
  let stored = structuredClone(DEFAULT_SETTINGS);
  let sendMessage: ReturnType<typeof vi.fn>;
  let stats: unknown;
  const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const navigate = () => query<HTMLAnchorElement>("a[aria-controls='statisticsSettings']").click();

  beforeEach(() => {
    vi.resetModules(); history.replaceState(null, "", "/options.html");
    document.open(); document.write(readFileSync(resolve("options.html"), "utf8")); document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    stats = { version: 1, days: [{ ...emptyUsageTotals(), date: localDateKey(), pages: 2, cachedTexts: 3,
      requests: 5, succeeded: 4, failed: 1, totalTokens: 120, reportedUsage: 3, minutes: { "60": 5 },
      models: [{ ...emptyUsageTotals(), requests: 5, succeeded: 4, totalTokens: 120, reportedUsage: 3,
        providerId: "custom", providerLabel: "Custom", model: '<img src=x onerror="alert(1)">' }] }] };
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: stored };
      if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "not-installed" } };
      if (request.type === "GET_STATISTICS") return { ok: true, data: stats };
      if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
      if (request.type === "CLEAR_STATISTICS") stats = { version: 1, days: [] };
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide")); vi.restoreAllMocks(); vi.unstubAllGlobals();
    document.documentElement.replaceChildren();
  });
  async function mount() {
    await import("../src/options/index");
    await vi.waitFor(() => expect(query("#providerTriggerLabel").textContent).toBe("Microsoft 翻译"));
  }

  it("defaults off, reads history only on demand and saves opt-in with other drafts", async () => {
    await mount();
    expect(query<HTMLInputElement>("#statisticsEnabled").checked).toBe(false);
    expect(sendMessage.mock.calls.some(([request]) => request.type === "GET_STATISTICS")).toBe(false);
    navigate();
    await vi.waitFor(() => expect(query("#statisticsModelRows").textContent).toContain("120（部分）"));
    query<HTMLInputElement>("#statisticsEnabled").click();
    expect(stored.statisticsEnabled).toBe(false);
    expect(query("#statisticsCollectionStatus").textContent).toContain("保存后开始");
    query<HTMLAnchorElement>("a[aria-controls='generalSettings']").click();
    query<HTMLSelectElement>("#targetLang").value = "en";
    navigate();
    expect(query<HTMLInputElement>("#statisticsEnabled").checked).toBe(true);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored).toMatchObject({ statisticsEnabled: true, targetLang: "en" }));
  });

  it("shows partial Token coverage, safe model text, zero dates and range/metric controls", async () => {
    history.replaceState(null, "", "/options.html#statisticsSettings"); await mount();
    await vi.waitFor(() => expect(query("#statisticsModelRows").textContent).toContain("120（部分）"));
    expect(query("#statisticsModelRows img")).toBeNull();
    expect(query("#statisticsModelRows").textContent).toContain('<img src=x onerror="alert(1)">');
    const range = query<HTMLSelectElement>("#statisticsRange"); range.value = "7"; range.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll("#statisticsDailyRows tr")).toHaveLength(7);
    const metric = query<HTMLSelectElement>("#statisticsMetric"); metric.value = "pages"; metric.dispatchEvent(new Event("change"));
    expect(query("#statisticsTrend svg").getAttribute("aria-label")).toContain("翻译页面");
    expect(query("#statisticsFrequency").textContent).toContain("单分钟峰值 5 次");
    expect(query("#statisticsCollectionStatus").textContent).toContain("统计已关闭");
  });

  it("requires clear confirmation, preserves opt-in and handles empty history", async () => {
    await mount(); navigate();
    await vi.waitFor(() => expect(query("#statisticsModelRows").textContent).toContain("120（部分）"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    query<HTMLButtonElement>("#clearStatistics").click();
    expect(sendMessage.mock.calls.some(([request]) => request.type === "CLEAR_STATISTICS")).toBe(false);
    confirm.mockReturnValue(true); query<HTMLButtonElement>("#clearStatistics").click();
    await vi.waitFor(() => expect(query("#statisticsStatus").textContent).toBe("统计已清空。"));
    expect(query("#statisticsModelRows").textContent).toContain("暂无使用记录");
    expect(stored.statisticsEnabled).toBe(false);
  });

  it("keeps the dashboard usable after a read error", async () => {
    await mount();
    const normal = sendMessage.getMockImplementation() as (request: RuntimeRequest) => Promise<RuntimeResponse>;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => request.type === "GET_STATISTICS"
      ? { ok: false, error: "storage unavailable" } : normal(request));
    navigate();
    await vi.waitFor(() => expect(query("#statisticsStatus").textContent).toContain("读取失败"));
    expect(query<HTMLButtonElement>("#refreshStatistics").disabled).toBe(false);
    sendMessage.mockImplementation(normal); query<HTMLButtonElement>("#refreshStatistics").click();
    await vi.waitFor(() => expect(query("#statisticsModelRows").textContent).toContain("120（部分）"));
  });
});
