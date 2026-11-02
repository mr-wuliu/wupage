import { sendRuntimeMessage } from "../shared/messaging";
import { normalizeStatistics, summarizeStatistics, type UsageStatistics } from "../shared/statistics";
import "./statistics.css";

const format = (value: number): string => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
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
      ? `保存后${enabled.checked ? "开始" : "停止"}记录统计。`
      : savedEnabled ? "已开启，仅记录开启后的使用数据。" : "统计已关闭；开启并保存后开始记录。已有数据仍可查看或清空。";
  }

  function renderData(): void {
    const summary = summarizeStatistics(statistics, Number(range.value));
    const { totals, models } = summary;
    const cards = [
      ["翻译页面", format(totals.pages)], ["翻译请求", format(totals.requests)],
      ["已报告 Token", totals.reportedUsage ? format(totals.totalTokens) : "暂无用量"],
      ["最常用模型 / 服务", models[0]?.model || models[0]?.providerLabel || "暂无记录"],
      ["已报告输入 / 输出 Token", totals.reportedUsage && (totals.inputTokens + totals.outputTokens || !totals.totalTokens)
        ? `${format(totals.inputTokens)} / ${format(totals.outputTokens)}` : "暂无明细"],
      ["成功率", totals.requests ? `${format(totals.succeeded / totals.requests * 100)}%` : "暂无请求"],
      ["平均响应时间", totals.requests ? `${format(totals.durationMs / totals.requests / 1000)} 秒` : "暂无请求"],
      ["缓存命中文本", format(totals.cachedTexts)]
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
    query("#statisticsFrequency").textContent = `活跃分钟平均 ${format(summary.averagePerActiveMinute)} 次 · 单分钟峰值 ${format(summary.peakPerMinute)} 次 · 失败 ${format(totals.failed)} 次。下图为所选日期内各小时的累计请求。`;
    renderChart(query("#statisticsHours"), summary.hours.map((value, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, value })), "请求次数", true);
    query("#statisticsDailyRows").replaceChildren(...summary.days.slice().reverse().map(day => row([
      day.date, format(day.pages), format(day.requests), day.reportedUsage ? `${format(day.totalTokens)}${day.reportedUsage < day.requests ? "（部分）" : ""}` : day.requests ? "未报告" : "—"
    ])));
    query("#statisticsModelRows").replaceChildren(...(models.length ? models.map(model => row([
      model.model ? `${model.model} · ${model.providerLabel}` : model.providerLabel,
      format(model.requests), model.reportedUsage ? `${format(model.totalTokens)}${model.reportedUsage < model.requests ? "（部分）" : ""}` : "未报告",
      `${format(model.succeeded / model.requests * 100)}%`
    ])) : [row(["暂无使用记录", "—", "—", "—"])]));
  }

  async function load(): Promise<void> {
    if (busy) return;
    const current = ++revision;
    status.textContent = "正在读取统计…";
    refresh.disabled = true;
    try {
      const data = await sendRuntimeMessage<UsageStatistics>({ type: "GET_STATISTICS" });
      if (current !== revision || controller.signal.aborted) return;
      statistics = normalizeStatistics(data);
      renderData();
      status.textContent = statistics.days.length ? "" : "暂无统计记录。开启统计并完成翻译后，可在此查看用量。";
    } catch (error) {
      if (current === revision) status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
    } finally { if (current === revision) refresh.disabled = false; }
  }

  enabled.addEventListener("change", renderCollectionStatus, { signal: controller.signal });
  range.addEventListener("change", renderData, { signal: controller.signal });
  metric.addEventListener("change", renderData, { signal: controller.signal });
  refresh.addEventListener("click", () => { void load(); }, { signal: controller.signal });
  clear.addEventListener("click", async () => {
    if (!window.confirm("清空全部使用统计？此操作无法撤销，翻译缓存和设置会保留。")) return;
    busy = true; revision++; clear.disabled = true; refresh.disabled = true;
    try {
      await sendRuntimeMessage({ type: "CLEAR_STATISTICS" });
      statistics = { version: 1, days: [] }; renderData(); status.textContent = "统计已清空。";
    } catch (error) { status.textContent = `清空失败：${error instanceof Error ? error.message : String(error)}`; }
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
  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${label}，${points[0].label} 至 ${points.at(-1)!.label}` });
  svg.append(svgElement("title", {}, `${label}；悬停数据点可查看数值，每日明细见下方表格。`));
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
    mark.append(svgElement("title", {}, `${point.label}：${format(point.value)}${point.unknown ? "（仅已报告用量）" : ""}`));
    svg.append(mark);
    const step = Math.ceil((points.length - 1) / 4);
    if (index % step === 0 || index === points.length - 1) svg.append(svgElement("text", { x: point.x, y: height - 9,
      "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle", class: "statistics-axis" }, bars ? point.label : point.label.slice(5)));
  }
  container.replaceChildren(svg);
}
