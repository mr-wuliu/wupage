import { t } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { normalizeStatistics, summarizeStatistics, type UsageStatistics } from "../shared/statistics";
import "./statistics.css";

const format = (value: number): string => value.toLocaleString(t("interfaceLanguage"), { maximumFractionDigits: 1 });
const svgNS = "http://www.w3.org/2000/svg";

export function setupStatisticsControls(root: HTMLElement) {
  const query = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const enabled = query<HTMLInputElement>("#statisticsEnabled");
  const collectionStatus = query<HTMLElement>("#statisticsCollectionStatus");
  const range = query<HTMLSelectElement>("#statisticsRange");
  const metric = query<HTMLSelectElement>("#statisticsMetric");
  const status = query<HTMLElement>("#statisticsStatus");
  const refresh = query<HTMLButtonElement>("#refreshStatistics");
  const clear = query<HTMLButtonElement>("#clearStatistics");
  const controller = new AbortController();
  let statistics: UsageStatistics = { version: 1, days: [] };
  let savedEnabled = false, revision = 0, busy = false;

  function renderCollectionStatus(): void {
    collectionStatus.textContent = enabled.checked !== savedEnabled
      ? t("saveToRecordingUsage", enabled.checked ? t("start") : t("stop"))
      : savedEnabled ? t("enabledUsageIsRecordedFromTheTimeTracking") : t("trackingIsOffEnableItAndSaveTo");
  }

  function renderData(): void {
    const summary = summarizeStatistics(statistics, Number(range.value));
    const { totals, models } = summary;
    const cards = [
      [t("translatedPages"), format(totals.pages)], [t("translationRequests"), format(totals.requests)],
      [t("reportedTokens"), totals.reportedUsage ? format(totals.totalTokens) : t("noUsageYet")],
      [t("mostUsedModelService"), models[0]?.model || models[0]?.providerLabel || t("noRecords")],
      [t("reportedInputOutputTokens"), totals.reportedUsage && (totals.inputTokens + totals.outputTokens || !totals.totalTokens)
        ? `${format(totals.inputTokens)} / ${format(totals.outputTokens)}` : t("noBreakdownAvailable")],
      [t("successRate"), totals.requests ? `${format(totals.succeeded / totals.requests * 100)}%` : t("noRequests")],
      [t("averageResponseTime"), totals.requests ? t("durationSeconds", format(totals.durationMs / totals.requests / 1000)) : t("noRequests")],
      [t("textServedFromCache"), format(totals.cachedTexts)]
    ];
    query("#statisticsSummary").replaceChildren(...cards.map(([label, value]) => {
      const card = document.createElement("div"); card.className = "statistics-card";
      const name = document.createElement("span"); name.textContent = label;
      const content = document.createElement("strong"); content.textContent = value; content.title = value;
      card.append(name, content); return card;
    }));
    const metricKey = metric.value as "totalTokens" | "requests" | "pages";
    const metricLabel = metric.selectedOptions[0].textContent ?? "";
    renderChart(query("#statisticsTrend"), summary.days.map(day => ({ label: day.date, value: day[metricKey],
      unknown: metricKey === "totalTokens" && day.requests > day.reportedUsage })), metricLabel, false);
    query("#statisticsFrequency").textContent = t("averagePerActiveMinutePeakPerMinuteFailed", format(summary.averagePerActiveMinute), format(summary.peakPerMinute), format(totals.failed));
    renderChart(query("#statisticsHours"), summary.hours.map((value, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, value })), t("numberOfRequests"), true);
    query("#statisticsDailyRows").replaceChildren(...summary.days.slice().reverse().map(day => row([
      day.date, format(day.pages), format(day.requests), day.reportedUsage ? `${format(day.totalTokens)}${day.reportedUsage < day.requests ? t("partial") : ""}` : day.requests ? t("unreported") : "—"
    ])));
    query("#statisticsModelRows").replaceChildren(...(models.length ? models.map(model => row([
      model.model ? `${model.model} · ${model.providerLabel}` : model.providerLabel,
      format(model.requests), model.reportedUsage ? `${format(model.totalTokens)}${model.reportedUsage < model.requests ? t("partial") : ""}` : t("unreported"),
      `${format(model.succeeded / model.requests * 100)}%`
    ])) : [row([t("noUsageRecorded"), "—", "—", "—"])]));
  }

  async function load(): Promise<void> {
    if (busy) return;
    const current = ++revision;
    status.textContent = t("loadingStatistics");
    refresh.disabled = true;
    try {
      const data = await sendRuntimeMessage<UsageStatistics>({ type: "GET_STATISTICS" });
      if (current !== revision || controller.signal.aborted) return;
      statistics = normalizeStatistics(data);
      renderData();
      status.textContent = statistics.days.length ? "" : t("noRecordsYetEnableStatisticsAndTranslateSome");
    } catch (error) {
      if (current === revision) status.textContent = t("couldNotLoadData", error instanceof Error ? error.message : String(error));
    } finally { if (current === revision) refresh.disabled = false; }
  }

  enabled.addEventListener("change", renderCollectionStatus, { signal: controller.signal });
  range.addEventListener("change", renderData, { signal: controller.signal });
  metric.addEventListener("change", renderData, { signal: controller.signal });
  refresh.addEventListener("click", () => { void load(); }, { signal: controller.signal });
  clear.addEventListener("click", async () => {
    if (!window.confirm(t("clearAllUsageStatisticsThisCannotBeUndone"))) return;
    busy = true; revision++; clear.disabled = true; refresh.disabled = true;
    try {
      await sendRuntimeMessage({ type: "CLEAR_STATISTICS" });
      statistics = { version: 1, days: [] }; renderData(); status.textContent = t("statisticsCleared");
    } catch (error) { status.textContent = t("couldNotClearStatistics", error instanceof Error ? error.message : String(error)); }
    finally { busy = false; clear.disabled = false; refresh.disabled = false; }
  }, { signal: controller.signal });
  const maybeLoad = () => { if (!root.hidden) void load(); };
  window.addEventListener("hashchange", maybeLoad, { signal: controller.signal });
  window.addEventListener("focus", maybeLoad, { signal: controller.signal });
  window.addEventListener("resize", () => { if (!root.hidden) renderData(); }, { signal: controller.signal });
  document.querySelector(`.settings-nav a[aria-controls='${root.id}']`)?.addEventListener("click", maybeLoad, { signal: controller.signal });
  window.addEventListener("pagehide", event => { if (!event.persisted) { revision++; controller.abort(); } }, { signal: controller.signal });
  renderData();
  return {
    reset(): void {
      enabled.checked = false; range.value = "30"; metric.value = "totalTokens";
      renderCollectionStatus(); renderData();
    },
    render(value: boolean): void { savedEnabled = value; enabled.checked = value; renderCollectionStatus(); maybeLoad(); },
    read(): boolean { return enabled.checked; }
  };
}

function row(values: string[]): HTMLTableRowElement {
  const row = document.createElement("tr");
  values.forEach(value => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
  return row;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderChart(container: HTMLElement, points: Array<{ label: string; value: number; unknown?: boolean }>, label: string, bars: boolean): void {
  const width = Math.min(640, Math.max(320, container.clientWidth || 640)), height = 190, left = 54, right = 20, top = 16, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(1, ...points.map(point => point.value));
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": t("to", label, points[0].label, points.at(-1)!.label) });
  svg.append(svgElement("title", {}, t("hoverOverAPointForItsValueOr", label)));
  for (let index = 0; index <= 2; index++) {
    const y = top + index * plotHeight / 2;
    svg.append(svgElement("line", { x1: left, y1: y, x2: width - right, y2: y, class: "statistics-grid-line" }));
    const value = max * (1 - index / 2);
    svg.append(svgElement("text", { x: left - 8, y: y + 4, "text-anchor": "end", class: "statistics-axis" },
      value >= 1000 ? `${format(value / 1000)}k` : format(value)));
  }
  const coords = points.map((point, index) => ({
    ...point, x: left + (bars ? (index + .5) / points.length : index / (points.length - 1)) * plotWidth,
    y: top + plotHeight * (1 - point.value / max)
  }));
  if (!bars) svg.append(svgElement("polyline", { points: coords.map(point => `${point.x},${point.y}`).join(" "), class: "statistics-trend-line" }));
  for (const [index, point] of coords.entries()) {
    const mark = bars ? svgElement("rect", { x: point.x - plotWidth / points.length * .32, y: point.y,
      width: plotWidth / points.length * .64, height: top + plotHeight - point.y, rx: 2, class: "statistics-bar" })
      : svgElement("circle", { cx: point.x, cy: point.y, r: points.length <= 7 ? 4 : 2.5, class: `statistics-point${point.unknown ? " statistics-point-unknown" : ""}` });
    mark.append(svgElement("title", {}, `${point.label}：${format(point.value)}${point.unknown ? t("reportedUsageOnly") : ""}`));
    svg.append(mark);
    const step = Math.ceil((points.length - 1) / 4);
    if (index % step === 0 || index === points.length - 1) svg.append(svgElement("text", { x: point.x, y: height - 9,
      "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle", class: "statistics-axis" }, bars ? point.label : point.label.slice(5)));
  }
  container.replaceChildren(svg);
}
