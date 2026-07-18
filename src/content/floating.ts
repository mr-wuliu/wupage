import type {
  ExtensionSettings,
  RuntimeRequest,
  TranslateBatchResponse,
  TranslationDebugSnapshot,
  TranslationDebugTask
} from "../shared/types";
import { sendRuntimeRequest } from "./runtime";
import {
  clearTranslationsIn,
  collectParagraphTextSegments,
  findTranslatableParagraph,
  hasPageTranslations,
  hasTranslationsIn,
  renderTranslationPlaceholders,
  renderTranslations
} from "./dom";
import { clearPageTranslation, startPageTranslation } from "./page-translation";

const FLOATING_ID = "wupage-floating-ball";
const FLOATING_HITBOX_ID = "wupage-floating-hitbox";
const DEBUG_PANEL_ID = "wupage-debug-panel";
const ACTIVE_CLASS = "wupage-paragraph-active";
const HIGHLIGHT_ID = "wupage-paragraph-highlight";
const POSITION_KEY = "wupage.floating.position";
const PARAGRAPH_HINT_KEY = "wupage.paragraphMode.hintSeen";
const EDGE_MARGIN = 8;
const EDGE_VISIBLE = 22;
const SNAP_THRESHOLD = 56;
const HITBOX_PADDING = 16;
const TARGET_LANGUAGES = [
  { code: "zh-CN", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" }
];
const SOURCE_LANGUAGES = [
  { code: "auto", label: "自动检测" },
  ...TARGET_LANGUAGES
];

let activeParagraph: Element | null = null;
let translating = false;
let dragging = false;
let movedDuringDrag = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let paragraphMode = false;
let floatingBallEnabled = true;
let debugRefreshTimer: number | undefined;
let debugDragging = false;
let debugDragOffsetX = 0;
let debugDragOffsetY = 0;
const expandedDebugTaskIds = new Set<number>();

export function initFloatingBall(): void {
  if (document.getElementById(FLOATING_ID)) return;

  const hitbox = document.createElement("div");
  hitbox.id = FLOATING_HITBOX_ID;
  const button = document.createElement("button");
  button.id = FLOATING_ID;
  button.type = "button";
  button.title = "Translate paragraph";
  button.textContent = "译";
  button.addEventListener("click", (event) => {
    if (movedDuringDrag) {
      event.preventDefault();
      movedDuringDrag = false;
      return;
    }
    toggleMenu();
  });
  button.addEventListener("pointerdown", startDrag);

  hitbox.append(button);
  document.documentElement.append(hitbox);
  createHighlight();
  createMenu();
  void restorePosition(button);
  void syncFloatingBallFromSettings();
  document.addEventListener("mousemove", handleParagraphPreview, { passive: true });
  document.addEventListener("click", handleDocumentClick, true);
  window.addEventListener("resize", () => snapToEdge(button));
  window.addEventListener("scroll", updateHighlight, { passive: true });
  document.addEventListener("click", closeMenuOnOutsideClick, true);
}

function handleParagraphPreview(event: MouseEvent): void {
  if (!paragraphMode) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(`#${FLOATING_ID}, #${FLOATING_HITBOX_ID}, #wupage-floating-menu, .wupage-translation`)) {
    return;
  }

  const paragraph = findTranslatableParagraph(target);
  if (paragraph === activeParagraph) return;

  setActiveParagraph(paragraph);
}

async function translateActiveParagraph(): Promise<void> {
  if (!activeParagraph || translating) return;
  translating = true;
  const button = document.getElementById(FLOATING_ID);
  button?.classList.add("is-loading");

  try {
    const target = activeParagraph;
    if (hasTranslationsIn(target)) {
      clearTranslationsIn(target);
      setActiveParagraph(target);
      return;
    }

    const segments = collectParagraphTextSegments(target);
    if (!segments.length) return;
    renderTranslationPlaceholders(segments);

    const settings = await getSettings();
    try {
      const data = await translateSegments(settings, segments.map((segment) => segment.text));
      renderTranslations(
        segments.map((segment, index) => ({
          id: segment.id,
          text: data.translations[index]
        }))
      );
      setActiveParagraph(target);
    } catch (error) {
      clearTranslationsIn(target);
      throw error;
    }
  } finally {
    translating = false;
    button?.classList.remove("is-loading");
  }
}

function handleDocumentClick(event: MouseEvent): void {
  if (!paragraphMode || !event.ctrlKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(`#${FLOATING_ID}, #${FLOATING_HITBOX_ID}, .wupage-translation`)) return;
  if (target.closest("#wupage-floating-menu")) return;

  const paragraph = findTranslatableParagraph(target);
  if (!paragraph) return;
  event.preventDefault();
  event.stopPropagation();
  setActiveParagraph(paragraph);
  void translateActiveParagraph();
}

function startDrag(event: PointerEvent): void {
  const button = event.currentTarget as HTMLElement;
  dragging = true;
  movedDuringDrag = false;
  const rect = button.getBoundingClientRect();
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  button.classList.add("is-dragging");
  button.setPointerCapture(event.pointerId);
  button.addEventListener("pointermove", drag);
  button.addEventListener("pointerup", stopDrag);
  button.addEventListener("pointercancel", stopDrag);
}

function drag(event: PointerEvent): void {
  if (!dragging) return;
  const button = event.currentTarget as HTMLElement;
  const size = button.offsetWidth;
  const nextLeft = clamp(event.clientX - dragOffsetX, 0, window.innerWidth - size);
  const nextTop = clamp(event.clientY - dragOffsetY, 0, window.innerHeight - size);
  const rect = button.getBoundingClientRect();
  if (Math.abs(nextLeft - rect.left) > 2 || Math.abs(nextTop - rect.top) > 2) {
    movedDuringDrag = true;
  }
  setButtonPosition(button, nextLeft, nextTop);
}

function stopDrag(event: PointerEvent): void {
  const button = event.currentTarget as HTMLElement;
  dragging = false;
  button.classList.remove("is-dragging");
  button.releasePointerCapture(event.pointerId);
  button.removeEventListener("pointermove", drag);
  button.removeEventListener("pointerup", stopDrag);
  button.removeEventListener("pointercancel", stopDrag);
  settlePosition(button);
}

function createMenu(): void {
  if (document.getElementById("wupage-floating-menu")) return;
  const menu = document.createElement("div");
  menu.id = "wupage-floating-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <div class="wupage-menu-section">
      <div class="wupage-language-pair">
        <label class="wupage-language-select">
          <span class="wupage-visually-hidden">源语言</span>
          <select data-role="source-lang">
            ${SOURCE_LANGUAGES.map((language) =>
              `<option value="${language.code}">${language.label}</option>`
            ).join("")}
          </select>
          <span class="wupage-language-chevron" aria-hidden="true"></span>
        </label>
        <span class="wupage-language-direction" aria-hidden="true">→</span>
        <label class="wupage-language-select">
          <span class="wupage-visually-hidden">目标语言</span>
          <select data-role="target-lang">
            ${TARGET_LANGUAGES.map((language) =>
              `<option value="${language.code}">${language.label}</option>`
            ).join("")}
          </select>
          <span class="wupage-language-chevron" aria-hidden="true"></span>
        </label>
      </div>
    </div>
    <div class="wupage-menu-divider"></div>
    <button type="button" data-action="page-toggle">翻译全文</button>
    <button type="button" data-action="paragraph-mode" class="wupage-switch-row">
      <span>段落模式</span>
      <span class="wupage-switch" aria-hidden="true"><span></span></span>
    </button>
    <div class="wupage-menu-divider"></div>
    <button type="button" data-action="close">关闭悬浮球</button>
  `;
  menu.addEventListener("change", (event) => {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!target || (target.dataset.role !== "source-lang" && target.dataset.role !== "target-lang")) return;
    void updateLanguages(menu);
  });
  menu.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("button") : null;
    if (!target) return;
    event.preventDefault();

    const action = target.dataset.action;
    if (action === "close") {
      void setFloatingBallEnabled(false);
      return;
    }
    if (action === "paragraph-mode") void setParagraphMode(!paragraphMode);
    if (action === "page-toggle") void togglePageTranslationFromFloating(menu);
  });
  document.documentElement.append(menu);
}

function createHighlight(): void {
  if (document.getElementById(HIGHLIGHT_ID)) return;
  const highlight = document.createElement("div");
  highlight.id = HIGHLIGHT_ID;
  highlight.hidden = true;
  document.documentElement.append(highlight);
}

function setActiveParagraph(paragraph: Element | null): void {
  activeParagraph?.classList.remove(ACTIVE_CLASS);
  activeParagraph = paragraph;
  activeParagraph?.classList.add(ACTIVE_CLASS);
  updateHighlight();
}

function updateHighlight(): void {
  const highlight = document.getElementById(HIGHLIGHT_ID);
  if (!highlight) return;

  if (!paragraphMode || !activeParagraph || !document.documentElement.contains(activeParagraph)) {
    highlight.hidden = true;
    return;
  }

  const rect = activeParagraph.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    highlight.hidden = true;
    return;
  }

  highlight.hidden = false;
  highlight.style.left = `${Math.max(0, rect.left - 4)}px`;
  highlight.style.top = `${Math.max(0, rect.top - 4)}px`;
  highlight.style.width = `${rect.width + 8}px`;
  highlight.style.height = `${rect.height + 8}px`;
}

function toggleMenu(): void {
  const menu = document.getElementById("wupage-floating-menu");
  const button = document.getElementById(FLOATING_ID);
  if (!menu || !button) return;
  setMenuOpen(menu, !isMenuOpen(menu));
  if (!menu.hidden) {
    positionMenu(menu, button);
    void updateMenuState(menu);
  }
}

function positionMenu(menu: HTMLElement, button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 246;
  const left = clamp(rect.left + rect.width / 2 - menuWidth / 2, EDGE_MARGIN, window.innerWidth - menuWidth - EDGE_MARGIN);
  const top =
    rect.top > menuHeight + EDGE_MARGIN * 2
      ? rect.top - menuHeight - EDGE_MARGIN
      : Math.min(window.innerHeight - menuHeight - EDGE_MARGIN, rect.bottom + EDGE_MARGIN);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(EDGE_MARGIN, top)}px`;
}

function closeMenuOnOutsideClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest(`#${FLOATING_ID}, #${FLOATING_HITBOX_ID}, #wupage-floating-menu`)) return;
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) setMenuOpen(menu, false);
}

async function updateMenuState(menu: HTMLElement): Promise<void> {
  const paragraphModeButton = menu.querySelector<HTMLButtonElement>("[data-action='paragraph-mode']");
  if (paragraphModeButton) {
    paragraphModeButton.setAttribute("aria-pressed", String(paragraphMode));
  }
  updatePageToggleButton(menu);

  const settings = await getSettings();
  const sourceLangSelect = menu.querySelector<HTMLSelectElement>("[data-role='source-lang']");
  if (sourceLangSelect) {
    ensureLanguageOption(sourceLangSelect, settings.sourceLang);
    sourceLangSelect.value = settings.sourceLang;
  }
  const targetLangSelect = menu.querySelector<HTMLSelectElement>("[data-role='target-lang']");
  if (targetLangSelect) {
    ensureLanguageOption(targetLangSelect, settings.targetLang);
    targetLangSelect.value = settings.targetLang;
  }
}

function updatePageToggleButton(menu: HTMLElement): void {
  const pageToggleButton = menu.querySelector<HTMLButtonElement>("[data-action='page-toggle']");
  if (!pageToggleButton) return;
  pageToggleButton.textContent = hasPageTranslations() ? "显示全文" : "翻译全文";
}

function ensureLanguageOption(select: HTMLSelectElement, language: string): void {
  if (Array.from(select.options).some((option) => option.value === language)) return;
  const option = document.createElement("option");
  option.value = language;
  option.textContent = language;
  select.prepend(option);
}

async function restorePosition(button: HTMLElement): Promise<void> {
  if (!chrome?.runtime?.id) return;
  const result = await chrome.storage.local.get(POSITION_KEY);
  const position = result[POSITION_KEY] as FloatingPosition | undefined;
  if (isFloatingPosition(position)) {
    setButtonPosition(
      button,
      clamp(position.left, 0, window.innerWidth - button.offsetWidth),
      clamp(position.top, 0, window.innerHeight - button.offsetHeight)
    );
    if (position.edge) {
      button.dataset.edge = position.edge;
    } else {
      delete button.dataset.edge;
    }
    return;
  }
  snapToEdge(button);
}

function snapToEdge(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const size = button.offsetWidth;
  const edge = rect.left + size / 2 < window.innerWidth / 2 ? "left" : "right";
  const left = edge === "left" ? EDGE_VISIBLE - size : window.innerWidth - EDGE_VISIBLE;
  const top = clamp(rect.top, EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN);
  setButtonPosition(button, left, top);
  button.dataset.edge = edge;
  void saveLocal({
    [POSITION_KEY]: { left, top, edge } satisfies FloatingPosition
  });
}

function settlePosition(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const nearLeft = rect.left <= SNAP_THRESHOLD;
  const nearRight = window.innerWidth - rect.right <= SNAP_THRESHOLD;
  if (nearLeft || nearRight) {
    snapToEdge(button);
    return;
  }

  const left = clamp(rect.left, EDGE_MARGIN, window.innerWidth - button.offsetWidth - EDGE_MARGIN);
  const top = clamp(rect.top, EDGE_MARGIN, window.innerHeight - button.offsetHeight - EDGE_MARGIN);
  setButtonPosition(button, left, top);
  delete button.dataset.edge;
  void saveLocal({
    [POSITION_KEY]: { left, top, edge: null } satisfies FloatingPosition
  });
}

function setButtonPosition(button: HTMLElement, left: number, top: number): void {
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  const target = hitbox ?? button;
  const offset = hitbox ? HITBOX_PADDING : 0;
  target.style.left = `${left - offset}px`;
  target.style.top = `${top - offset}px`;
  target.style.right = "auto";
  target.style.bottom = "auto";
}

function setMenuOpen(menu: HTMLElement, open: boolean): void {
  menu.hidden = !open;
  document.getElementById(FLOATING_ID)?.classList.toggle("is-menu-open", open);
}

function isMenuOpen(menu: HTMLElement): boolean {
  return !menu.hidden;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFloatingPosition(value: unknown): value is FloatingPosition {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as FloatingPosition).left === "number" &&
    typeof (value as FloatingPosition).top === "number" &&
    ((value as FloatingPosition).edge === "left" ||
      (value as FloatingPosition).edge === "right" ||
      (value as FloatingPosition).edge === null)
  );
}

interface FloatingPosition {
  left: number;
  top: number;
  edge: "left" | "right" | null;
}

async function translatePageFromFloating(): Promise<void> {
  const settings = await getSettings();
  const result = await startPageTranslation(settings);
  if (result.failed > 0 && result.translated === 0) {
    throw new Error(result.error ?? "翻译失败。");
  }
}

async function togglePageTranslationFromFloating(menu: HTMLElement): Promise<void> {
  if (hasPageTranslations()) {
    clearPageFromFloating();
    updatePageToggleButton(menu);
    return;
  }

  try {
    await translatePageFromFloating();
  } finally {
    updatePageToggleButton(menu);
  }
}

function clearPageFromFloating(): void {
  clearPageTranslation();
  setActiveParagraph(null);
}

export async function openDebugPanel(): Promise<void> {
  const existing = document.getElementById(DEBUG_PANEL_ID);
  if (existing) {
    existing.hidden = false;
    await refreshDebugPanel(existing);
    return;
  }

  const panel = document.createElement("section");
  panel.id = DEBUG_PANEL_ID;
  panel.innerHTML = `
    <header>
      <strong>Debug</strong>
      <button type="button" data-action="close-debug" title="关闭">×</button>
    </header>
    <div class="wupage-debug-summary">正在读取任务...</div>
    <div class="wupage-debug-list"></div>
  `;
  const header = panel.querySelector("header");
  header?.addEventListener("pointerdown", startDebugDrag);
  panel.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.dataset.action !== "close-debug") return;
    panel.hidden = true;
    stopDebugRefresh();
  });
  document.documentElement.append(panel);
  startDebugRefresh(panel);
  await refreshDebugPanel(panel);
}

function startDebugDrag(event: PointerEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("button")) return;
  const panel = document.getElementById(DEBUG_PANEL_ID);
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  debugDragging = true;
  debugDragOffsetX = event.clientX - rect.left;
  debugDragOffsetY = event.clientY - rect.top;
  panel.classList.add("is-dragging");
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  window.addEventListener("pointermove", dragDebugPanel);
  window.addEventListener("pointerup", stopDebugDrag);
  window.addEventListener("pointercancel", stopDebugDrag);
}

function dragDebugPanel(event: PointerEvent): void {
  if (!debugDragging) return;
  const panel = document.getElementById(DEBUG_PANEL_ID);
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const left = clamp(event.clientX - debugDragOffsetX, 8, window.innerWidth - rect.width - 8);
  const top = clamp(event.clientY - debugDragOffsetY, 8, window.innerHeight - rect.height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function stopDebugDrag(): void {
  const panel = document.getElementById(DEBUG_PANEL_ID);
  debugDragging = false;
  if (!panel) return;
  panel.classList.remove("is-dragging");
  window.removeEventListener("pointermove", dragDebugPanel);
  window.removeEventListener("pointerup", stopDebugDrag);
  window.removeEventListener("pointercancel", stopDebugDrag);
}

function startDebugRefresh(panel: HTMLElement): void {
  stopDebugRefresh();
  debugRefreshTimer = window.setInterval(() => {
    void refreshDebugPanel(panel);
  }, 1000);
}

function stopDebugRefresh(): void {
  if (debugRefreshTimer === undefined) return;
  window.clearInterval(debugRefreshTimer);
  debugRefreshTimer = undefined;
}

async function refreshDebugPanel(panel: HTMLElement): Promise<void> {
  if (panel.hidden) return;
  const summary = panel.querySelector<HTMLElement>(".wupage-debug-summary");
  const list = panel.querySelector<HTMLElement>(".wupage-debug-list");
  if (!summary || !list) return;

  try {
    const snapshot = await sendRuntimeRequest<TranslationDebugSnapshot>({
      type: "GET_TRANSLATION_DEBUG"
    } satisfies RuntimeRequest);
    summary.textContent = `执行中 ${snapshot.activeCount} · 排队 ${snapshot.queuedCount} · 最近 ${snapshot.tasks.length}`;
    list.replaceChildren(...snapshot.tasks.slice(0, 30).map(renderDebugTask));
    if (!snapshot.tasks.length) {
      const empty = document.createElement("div");
      empty.className = "wupage-debug-empty";
      empty.textContent = "暂无任务";
      list.append(empty);
    }
  } catch (error) {
    summary.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderDebugTask(task: TranslationDebugTask): HTMLElement {
  const item = document.createElement("details");
  item.className = "wupage-debug-task";
  item.dataset.status = task.status;
  item.open = expandedDebugTaskIds.has(task.id);
  item.addEventListener("toggle", () => {
    if (item.open) {
      expandedDebugTaskIds.add(task.id);
    } else {
      expandedDebugTaskIds.delete(task.id);
    }
  });

  const title = document.createElement("summary");
  title.className = "wupage-debug-task-title";
  const name = document.createElement("strong");
  name.textContent = `#${task.id} ${task.providerLabel}`;
  const status = document.createElement("span");
  status.textContent = formatTaskStatus(task);
  title.append(name, status);

  const meta = document.createElement("div");
  meta.className = "wupage-debug-task-meta";
  meta.textContent =
    `${task.textCount} 段 · ${task.charCount} 字符 · ${task.sourceLang ?? "auto"} -> ${task.targetLang ?? "-"} · ${formatTaskTime(task)}`;

  item.append(title, meta);
  item.append(renderDebugDetails(task));
  return item;
}

function renderDebugDetails(task: TranslationDebugTask): HTMLElement {
  const details = document.createElement("div");
  details.className = "wupage-debug-task-detail";
  if (task.chunkSize || task.concurrency) {
    const performance = document.createElement("p");
    performance.textContent = `性能：分块 ${task.chunkSize ?? "-"} · 并发 ${task.concurrency ?? "-"} · ${task.performanceMode === "custom" ? "服务商覆盖" : "继承通用"}`;
    details.append(performance);
  }
  details.append(renderDebugTextBlock("请求文本", task.sourceTexts));
  if (task.translatedTexts?.length) {
    details.append(renderDebugTextBlock("翻译结果", task.translatedTexts));
  }
  if (task.error) {
    const error = document.createElement("div");
    error.className = "wupage-debug-task-error";
    error.textContent = task.error;
    details.append(error);
  }
  return details;
}

function renderDebugTextBlock(label: string, values: string[] | undefined): HTMLElement {
  const block = document.createElement("section");
  block.className = "wupage-debug-text-block";
  const title = document.createElement("h4");
  title.textContent = `${label}${values?.length ? ` (${values.length})` : ""}`;
  block.append(title);

  if (!values?.length) {
    const empty = document.createElement("p");
    empty.textContent = "无";
    block.append(empty);
    return block;
  }

  values.forEach((value, index) => {
    const pre = document.createElement("pre");
    pre.textContent = `${index + 1}. ${value}`;
    block.append(pre);
  });
  return block;
}

function formatTaskStatus(task: TranslationDebugTask): string {
  if (task.status === "waiting" && task.waitUntil) {
    return `等待 ${Math.max(0, Math.ceil((task.waitUntil - Date.now()) / 1000))}s`;
  }
  const labels: Record<TranslationDebugTask["status"], string> = {
    queued: "排队",
    waiting: "等待",
    running: "执行中",
    succeeded: "完成",
    failed: "失败"
  };
  return labels[task.status];
}

function formatTaskTime(task: TranslationDebugTask): string {
  const start = task.startedAt ?? task.createdAt;
  const end = task.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - start) / 1000))}s`;
}

export function getParagraphMode(): boolean {
  return paragraphMode;
}

export function getFloatingBallEnabled(): boolean {
  return floatingBallEnabled;
}

export async function setFloatingBallEnabled(enabled: boolean): Promise<void> {
  floatingBallEnabled = enabled;
  applyFloatingBallVisibility();
  const settings = await getSettings();
  if (settings.floatingBallEnabled !== enabled) {
    await sendRuntimeRequest({
      type: "SAVE_SETTINGS",
      settings: {
        ...settings,
        floatingBallEnabled: enabled
      }
    } satisfies RuntimeRequest);
  }
}

export async function setParagraphMode(enabled: boolean): Promise<void> {
  paragraphMode = enabled;
  document.documentElement.classList.toggle("wupage-paragraph-mode", paragraphMode);
  setActiveParagraph(null);
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) void updateMenuState(menu);

  if (!paragraphMode) return;
  if (!chrome?.runtime?.id) return;
  const result = await chrome.storage.local.get(PARAGRAPH_HINT_KEY);
  if (result[PARAGRAPH_HINT_KEY]) return;
  window.alert("段落模式已开启。\n\n用法：按住 Ctrl，然后鼠标点击要翻译的段落。");
  await saveLocal({ [PARAGRAPH_HINT_KEY]: true });
}

async function syncFloatingBallFromSettings(): Promise<void> {
  const settings = await getSettings();
  floatingBallEnabled = settings.floatingBallEnabled;
  applyFloatingBallVisibility();
}

function applyFloatingBallVisibility(): void {
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  const menu = document.getElementById("wupage-floating-menu");
  if (hitbox) hitbox.hidden = !floatingBallEnabled;
  if (!floatingBallEnabled) {
    if (menu) setMenuOpen(menu, false);
    setActiveParagraph(null);
  }
}

async function updateLanguages(menu: HTMLElement): Promise<void> {
  const sourceLang = menu.querySelector<HTMLSelectElement>("[data-role='source-lang']")?.value;
  const targetLang = menu.querySelector<HTMLSelectElement>("[data-role='target-lang']")?.value;
  if (!sourceLang || !targetLang) return;
  const settings = await getSettings();
  if (settings.sourceLang !== sourceLang || settings.targetLang !== targetLang) {
    await sendRuntimeRequest({
      type: "SAVE_SETTINGS",
      settings: {
        ...settings,
        sourceLang,
        targetLang
      }
    } satisfies RuntimeRequest);
  }
  await updateMenuState(menu);
}

async function saveLocal(items: Record<string, unknown>): Promise<void> {
  if (!chrome?.runtime?.id) return;
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Extension context invalidated")) return;
    throw error;
  }
}

async function getSettings(): Promise<ExtensionSettings> {
  return sendRuntimeRequest<ExtensionSettings>({
    type: "GET_SETTINGS"
  } satisfies RuntimeRequest);
}

async function translateSegments(
  settings: ExtensionSettings,
  texts: string[]
): Promise<TranslateBatchResponse> {
  return sendRuntimeRequest<TranslateBatchResponse>({
    type: "TRANSLATE_BATCH",
    texts,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    providerId: settings.activeProviderId
  } satisfies RuntimeRequest);
}
