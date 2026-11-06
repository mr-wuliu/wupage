import { uiIconMarkup } from "../shared/ui-icons";
import { setHtmlContent } from "../shared/html";
import type {
  ExtensionSettings,
  RuntimeRequest,
  TranslationDisplayMode,
  TranslationDebugSnapshot,
  TranslationDebugTask
} from "../shared/types";
import { sendRuntimeRequest } from "./runtime";
import { refreshPageContextState } from "./page-context";
import { localProviderNotice, renderLocalModelNotice } from "../shared/local-notice";
import { enhanceProviderSelect } from "../shared/provider-picker";
import { addAutoTranslationWebsite, currentWebsitePattern, excludeAutoTranslationWebsite, hasAutoTranslationWebsite, normalizeAutoTranslation, setAutoTranslationEnabled } from "../shared/auto-translation";
import { normalizeSelectionTranslation } from "../shared/dictionary";
import { setImageTranslationToggle, setupOcrControl } from "../shared/ocr-control-core";
import { doubaoProviderNotice, isDoubaoProviderUnavailable, syncDoubaoTargetControls } from "../shared/doubao-ui";
import { ProviderError } from "../shared/errors";
import {
  findTranslatableParagraph,
  hasPageTranslations
} from "./dom";
import {
  hidePageTranslation,
  getPageTranslationState,
  loadPageTranslationSettings,
  setPageTranslationDisplayMode,
  startPageTranslation,
  subscribePageTranslationState
} from "./page-translation";
import { SETTINGS_KEY } from "../shared/defaults";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import { translateParagraph } from "./paragraph-translation";
import { matchesLocalShortcut, matchesParagraphClick, normalizeLocalShortcuts, paragraphClickHint } from "../shared/local-shortcuts";
import { normalizeShortcutEnabled } from "../shared/shortcuts";
import { createSettingsSnapshot } from "../shared/settings-snapshot";
import { isLikelyPdfUrl } from "../pdf/launch";
import { observeParagraphMode } from "../shared/paragraph-mode";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { hasTouchInput, TOUCH_INPUT_QUERY, visibleViewport } from "../shared/touch";
import { startTouchParagraph } from "./touch-paragraph";
import { showTouchHint } from "./touch-hint";

const FLOATING_ID = "wupage-floating-ball";
const FLOATING_HITBOX_ID = "wupage-floating-hitbox";
const DEBUG_PANEL_ID = "wupage-debug-panel";
// Transient extension state must not change page-owned attributes such as class.
const ACTIVE_ATTRIBUTE = "data-wupage-paragraph-active";
const HIGHLIGHT_ID = "wupage-paragraph-highlight";
const POSITION_KEY = "wupage.floating.position";
const EDGE_MARGIN = 8;
const EDGE_VISIBLE = 22;
const SNAP_THRESHOLD = 56;
const HITBOX_PADDING = 16;
const FLOATING_SIZE = 42;
const DEFAULT_BOTTOM = 146;
const MENU_OPEN_DELAY = 500;
const MENU_CLOSE_DELAY = 240;
const DRAG_THRESHOLD = 4;
const TOUCH_DRAG_THRESHOLD = 8;
let activeParagraph: Element | null = null;
let translating = false;
let dragging = false;
let movedDuringDrag = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
let menuOpenTimer: number | undefined;
let menuCloseTimer: number | undefined;
let longPressTimer: number | undefined;
let activePointerId: number | undefined;
let longPressTriggered = false;
let touchInteraction = false;
let pageActionPending = false;
let pageActionVersion = 0;
let menuError: string | null = null;
let menuErrorCode: string | undefined;
let menuRetryAt: number | undefined;
let retryStatusTimer: ReturnType<typeof setTimeout> | undefined;
let settingsSave: Promise<void> = Promise.resolve();
let menuOcr: ReturnType<typeof setupOcrControl> | undefined;
let unsubscribeTranslationState: (() => void) | undefined;
let paragraphMode = false;
let paragraphModeRevision = 0;
let unsubscribeParagraphMode: (() => void) | undefined;
let floatingBallEnabled = true;
let shortcutEnabled = normalizeShortcutEnabled(undefined);
let localShortcuts = normalizeLocalShortcuts(undefined);
let settingsSnapshot = createSettingsSnapshot(readSettings);
let debugRefreshTimer: number | undefined;
let debugDragging = false;
let debugDragOffsetX = 0;
let debugDragOffsetY = 0;
let debugResizing = false;
let debugResizeStartX = 0;
let debugResizeStartY = 0;
let debugResizeStartWidth = 0;
let debugResizeStartHeight = 0;
const expandedDebugTaskIds = new Set<number>();

export function initFloatingBall(): void {
  if (document.getElementById(FLOATING_ID)) return;
  cancelMenuOpen();
  cancelMenuClose();
  cancelLongPress();
  activePointerId = undefined;
  dragging = movedDuringDrag = longPressTriggered = touchInteraction = false;
  menuError = null;
  menuErrorCode = undefined;
  menuRetryAt = undefined;
  clearTimeout(retryStatusTimer);
  settingsSave = Promise.resolve();
  settingsSnapshot = createSettingsSnapshot(readSettings);
  menuOcr?.dispose();
  menuOcr = undefined;

  const hitbox = document.createElement("div");
  hitbox.id = FLOATING_HITBOX_ID;
  const button = document.createElement("button");
  button.id = FLOATING_ID;
  button.type = "button";
  button.title = floatingBallTitle("翻译全文");
  button.setAttribute("aria-label", "翻译全文");
  button.setAttribute("aria-controls", "wupage-floating-menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "dialog");
  const label = document.createElement("span");
  label.className = "wupage-floating-label";
  label.textContent = "译";
  button.append(label);
  button.addEventListener("selectstart", event => event.preventDefault());
  button.addEventListener("click", (event) => {
    cancelMenuOpen();
    cancelLongPress();
    if (movedDuringDrag) {
      event.preventDefault();
      movedDuringDrag = false;
      return;
    }
    void togglePageTranslationFromFloating();
  });
  button.addEventListener("pointerdown", startDrag);
  button.addEventListener("contextmenu", (event) => {
    if ("pointerType" in event && event.pointerType === "mouse") return;
    if (touchInteraction) event.preventDefault();
  });
  button.addEventListener("focus", () => {
    if (shortcutEnabled["floating-controls"] && button.matches(":focus-visible")) openMenu();
  });
  button.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const activate = shortcutEnabled["floating-controls"] && matchesLocalShortcut(event, localShortcuts["floating-activate"]);
    const menu = shortcutEnabled["floating-controls"] && matchesLocalShortcut(event, localShortcuts["floating-menu"]);
    // Suppress native button activation after changing or disabling its keyboard binding.
    if (["Enter", " ", "ArrowDown"].includes(event.key) || activate || menu) event.preventDefault();
    if (event.repeat) return;
    if (activate) { event.stopPropagation(); void togglePageTranslationFromFloating(); }
    else if (menu) {
      event.stopPropagation(); openMenu();
      document.querySelector<HTMLSelectElement>("#wupage-floating-menu select")?.focus();
    }
  });
  hitbox.addEventListener("pointerenter", (event) => {
    touchInteraction = event.pointerType === "touch";
    if (touchInteraction) cancelMenuClose();
    else scheduleMenuOpen();
  });
  hitbox.addEventListener("pointerleave", scheduleMenuClose);
  hitbox.addEventListener("focusout", scheduleMenuClose);

  hitbox.append(button);
  document.documentElement.append(hitbox);
  createHighlight();
  createMenu();
  unsubscribeTranslationState?.();
  unsubscribeTranslationState = subscribePageTranslationState(refreshTranslationState);
  refreshTranslationState();
  hitbox.hidden = true;
  void initializeFloatingBall(button);
  unsubscribeParagraphMode?.();
  unsubscribeParagraphMode = observeParagraphMode(enabled => {
    if (paragraphMode !== enabled || document.documentElement.classList.contains("wupage-paragraph-mode") !== enabled) {
      void setParagraphMode(enabled, false);
    }
  });
  subscribeToPositionChanges(button);
  document.addEventListener("mousemove", handleParagraphPreview, { passive: true });
  document.addEventListener("click", handleDocumentClick, true);
  window.addEventListener("resize", () => keepPositionInViewport(button));
  const positionVisibleMenu = () => {
    const menu = document.getElementById("wupage-floating-menu");
    if (menu && !menu.hidden) positionMenu(menu, button);
  };
  window.visualViewport?.addEventListener("resize", positionVisibleMenu);
  window.visualViewport?.addEventListener("scroll", positionVisibleMenu);
  window.addEventListener("scroll", updateHighlight, { passive: true });
  document.addEventListener("fullscreenchange", applyFloatingBallVisibility);
  document.addEventListener("click", closeMenuOnOutsideClick, true);
  document.addEventListener("keydown", (event) => {
    if (!shortcutEnabled["dismiss-overlays"] || !matchesLocalShortcut(event, localShortcuts["dismiss-overlays"])) return;
    cancelMenuOpen();
    cancelLongPress();
    const menu = document.getElementById("wupage-floating-menu");
    if (!menu || menu.hidden) return;
    event.preventDefault();
    if (menu.contains(document.activeElement)) button.focus({ preventScroll: true });
    setMenuOpen(menu, false);
  });
  window.addEventListener("pagehide", () => {
    cancelLongPress();
    cancelMenuOpen();
    cancelMenuClose();
    window.visualViewport?.removeEventListener("resize", positionVisibleMenu);
    window.visualViewport?.removeEventListener("scroll", positionVisibleMenu);
  }, { once: true });
}

async function initializeFloatingBall(button: HTMLElement): Promise<void> {
  await Promise.allSettled([
    restorePosition(button),
    syncFloatingBallFromSettings()
  ]);
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  if (!hitbox) return;
  hitbox.dataset.positionReady = "true";
  applyFloatingBallVisibility();
  if (hasTouchInput()) void showTouchHint(button);
}

function subscribeToPositionChanges(button: HTMLElement): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (settings) {
      settingsSnapshot.receive(settings);
      localShortcuts = normalizeLocalShortcuts(settings.localShortcuts);
      shortcutEnabled = normalizeShortcutEnabled(settings.shortcutEnabled, settings.shortcuts, localShortcuts);
      if (!shortcutEnabled["paragraph-click"]) setActiveParagraph(null);
      floatingBallEnabled = settings.floatingBallEnabled;
      applyFloatingBallVisibility();
      const menu = document.getElementById("wupage-floating-menu");
      if (menu) applyMenuSettings(menu, settings);
    }
    if (dragging) return;
    const position = changes[POSITION_KEY]?.newValue;
    if (isFloatingPosition(position)) applyFloatingPosition(button, position);
  });
}

function handleParagraphPreview(event: MouseEvent): void {
  if (!paragraphMode || !shortcutEnabled["paragraph-click"]) return;
  const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
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
  button?.classList.add("wupage-is-loading");

  try {
    const target = activeParagraph;
    await translateParagraph(target);
    setActiveParagraph(target);
  } finally {
    translating = false;
    refreshTranslationState();
  }
}

function handleDocumentClick(event: MouseEvent): void {
  if (!paragraphMode || !shortcutEnabled["paragraph-click"] || !matchesParagraphClick(event, localShortcuts["paragraph-click"])) return;
  const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
  if (!target || target.closest(`#${FLOATING_ID}, #${FLOATING_HITBOX_ID}, .wupage-translation`)) return;
  if (target.closest("#wupage-floating-menu")) return;

  const paragraph = findTranslatableParagraph(target);
  if (!paragraph) return;
  event.preventDefault();
  event.stopPropagation();
  setActiveParagraph(paragraph);
  void translateActiveParagraph().catch(showMenuError);
}

function startDrag(event: PointerEvent): void {
  if ((event.button !== 0 && event.button !== undefined) || event.isPrimary === false
    || activePointerId !== undefined) return;
  const button = event.currentTarget as HTMLElement;
  activePointerId = event.pointerId;
  touchInteraction = event.pointerType === "touch";
  if (touchInteraction) void showTouchHint(button);
  longPressTriggered = false;
  dragging = true;
  movedDuringDrag = false;
  const rect = button.getBoundingClientRect();
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) setMenuOpen(menu, false);
  button.setPointerCapture(event.pointerId);
  button.addEventListener("pointermove", drag);
  button.addEventListener("pointerup", stopDrag);
  button.addEventListener("pointercancel", stopDrag);
  button.addEventListener("lostpointercapture", stopDrag);
  if (touchInteraction) {
    longPressTimer = window.setTimeout(() => {
      longPressTimer = undefined;
      if (!dragging || movedDuringDrag) return;
      longPressTriggered = true;
      dragging = false;
      openMenu();
    }, MENU_OPEN_DELAY);
  }
}

function drag(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointerId) return;
  const button = event.currentTarget as HTMLElement;
  const threshold = touchInteraction ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
  if (!movedDuringDrag && Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < threshold) return;
  cancelLongPress();
  movedDuringDrag = true;
  button.classList.add("is-dragging");
  delete button.dataset.edge;
  const size = getFloatingSize(button);
  const nextLeft = clamp(event.clientX - dragOffsetX, 0, window.innerWidth - size);
  const nextTop = clamp(event.clientY - dragOffsetY, 0, window.innerHeight - size);
  setButtonPosition(button, nextLeft, nextTop);
}

function stopDrag(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  activePointerId = undefined;
  cancelLongPress();
  const button = event.currentTarget as HTMLElement;
  dragging = false;
  button.classList.remove("is-dragging");
  button.removeEventListener("pointermove", drag);
  button.removeEventListener("pointerup", stopDrag);
  button.removeEventListener("pointercancel", stopDrag);
  button.removeEventListener("lostpointercapture", stopDrag);
  if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
  if (movedDuringDrag) settlePosition(button);
  // Consume the click synthesized on release after dragging, cancellation or a long press.
  if (longPressTriggered || event.type !== "pointerup") movedDuringDrag = true;
  longPressTriggered = false;
}

function cancelLongPress(): void {
  window.clearTimeout(longPressTimer);
  longPressTimer = undefined;
}

function createMenu(): void {
  if (document.getElementById("wupage-floating-menu")) return;
  const menu = document.createElement("div");
  menu.id = "wupage-floating-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "WuPage 翻译");
  setHtmlContent(menu, `
    <div class="wupage-menu-top">
    <div class="wupage-menu-header">
      <strong>WuPage</strong>
      <button type="button" data-action="settings" aria-label="打开设置" title="打开设置">
        ${uiIconMarkup("settings")}
      </button>
    </div>
    <div class="wupage-menu-section">
      <div class="wupage-language-pair">
        <label class="wupage-language-select">
          <span class="wupage-visually-hidden">源语言</span>
          <select data-role="source-lang">
            ${SOURCE_LANGUAGES.map((language) =>
              `<option value="${language.code}">${language.label}</option>`
            ).join("")}
          </select>
          <span class="wupage-language-value" data-role="source-lang-value" aria-hidden="true">自动检测</span>
          <span class="wupage-language-chevron" aria-hidden="true">${uiIconMarkup("arrow-down-03")}</span>
        </label>
        <span class="wupage-language-direction" aria-hidden="true">${uiIconMarkup("arrow-right")}</span>
        <label class="wupage-language-select">
          <span class="wupage-visually-hidden">目标语言</span>
          <select data-role="target-lang">
            ${TARGET_LANGUAGES.map((language) =>
              `<option value="${language.code}">${language.label}</option>`
            ).join("")}
          </select>
          <span class="wupage-language-value" data-role="target-lang-value" aria-hidden="true">中文</span>
          <span class="wupage-language-chevron" aria-hidden="true">${uiIconMarkup("arrow-down-03")}</span>
        </label>
        <div class="wupage-language-automatic">
          <button type="button" data-action="auto-translation" class="wupage-feature-button wupage-language-auto" aria-label="自动翻译" aria-pressed="false" title="按站点或页面语言规则自动翻译">自动</button>
          <button type="button" data-action="add-auto-site" class="wupage-language-add-site" hidden disabled aria-label="将当前网站加入自动翻译列表" title="将当前网站加入自动翻译列表">${uiIconMarkup("plus")}</button>
        </div>
      </div>
    </div>
    <label class="wupage-menu-field">
      <span class="wupage-field-label">翻译服务</span>
      <span class="wupage-provider-select">
        <select data-role="provider" aria-label="翻译服务" hidden></select>
      </span>
    </label>
    </div>
    <label class="wupage-menu-field" data-touch-extra>
      <span class="wupage-field-label" id="wupage-display-mode-label">翻译模式</span>
      <select data-role="display-mode" aria-labelledby="wupage-display-mode-label">
        ${TRANSLATION_DISPLAY_MODES.map((mode) =>
          `<option value="${mode.value}">${mode.label}</option>`
        ).join("")}
      </select>
    </label>
    <div class="wupage-feature-buttons" role="group" aria-label="翻译功能">
      <button type="button" data-action="context-menu-translation" data-touch-extra class="wupage-feature-button" aria-pressed="false" title="右键点击网页，通过菜单翻译全文或恢复原文">
        <span>右键翻译</span>
        <span class="wupage-feature-indicator" aria-hidden="true"></span>
      </button>
      <button type="button" data-action="close" data-touch-extra class="wupage-feature-button" aria-pressed="true" title="隐藏悬浮球，可在扩展弹窗中重新开启">
        <span>悬浮球</span>
        <span class="wupage-feature-indicator" aria-hidden="true"></span>
      </button>
      <button type="button" data-action="selection-translation" class="wupage-feature-button" title="选中文字后显示查词或翻译入口">
        <span>划词翻译</span><span class="wupage-feature-indicator" aria-hidden="true"></span>
      </button>
      <div class="image-feature" data-loading aria-busy="true">
        <div class="image-feature-row">
          <button type="button" data-action="image-translation" class="wupage-feature-button" disabled title="开启后，点击图片旁的按钮翻译并覆盖原文" aria-describedby="wupage-ocr-description wupage-ocr-status"><span>图片翻译</span><span class="wupage-feature-indicator" aria-hidden="true"></span></button>
          <div class="ocr-help-slot"></div>
          <button type="button" class="ocr-model-action" data-role="ocr-action" aria-label="安装 OCR 模型" disabled></button>
        </div>
        <p id="wupage-ocr-description" class="ocr-description"></p>
        <progress data-role="ocr-progress" class="ocr-model-progress" aria-label="OCR 模型下载进度" hidden></progress>
        <p id="wupage-ocr-status" class="ocr-model-status" role="status"></p>
      </div>
    </div>
    <div class="wupage-translation-actions">
      <button type="button" data-action="page-toggle">翻译全文</button>
      <button type="button" data-action="paragraph-mode" class="wupage-feature-button" aria-pressed="false" aria-describedby="wupage-paragraph-mode-hint">
        <span>段落翻译</span><span class="wupage-feature-indicator" aria-hidden="true"></span>
      </button>
    </div>
    <p id="wupage-paragraph-mode-hint" class="wupage-menu-hint" hidden>所有网页生效；按住 Ctrl 点击段落翻译，再次点击恢复原文。</p>
    <button type="button" data-action="more" class="wupage-more-button" aria-expanded="false" hidden><span>更多功能</span>${uiIconMarkup("arrow-down-03")}</button>
    <div class="wupage-translation-feedback">
      <p data-role="translation-status" role="status" aria-live="polite" aria-atomic="true">点击悬浮球即可翻译全文</p>
      <button type="button" data-action="retranslate" hidden>重新翻译</button>
      <button type="button" data-action="doubao-settings" hidden>豆包登录与检测</button>
    </div>
  `);
  const pointerMedia = window.matchMedia?.(TOUCH_INPUT_QUERY);
  const updateTouchControls = () => { touchInteraction = hasTouchInput(); syncTouchMenu(menu); };
  updateTouchControls();
  pointerMedia?.addEventListener("change", updateTouchControls);
  window.addEventListener("pagehide", () => pointerMedia?.removeEventListener("change", updateTouchControls), { once: true });
  menu.addEventListener("pointerenter", (event) => {
    touchInteraction = event.pointerType === "touch";
    cancelMenuClose();
  });
  menu.addEventListener("pointerdown", (event) => {
    touchInteraction = event.pointerType === "touch";
  });
  menu.addEventListener("pointerleave", scheduleMenuClose);
  menu.addEventListener("wupage-provider-close", scheduleMenuClose);
  menu.addEventListener("focusin", cancelMenuClose);
  menu.addEventListener("focusout", scheduleMenuClose);
  menu.addEventListener("change", (event) => {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!target) return;
    if (target.dataset.role === "source-lang" || target.dataset.role === "target-lang") {
      syncSelectValue(target);
      void updateLanguages(menu).catch(showMenuError);
    }
    if (target.dataset.role === "provider") {
      void updateFloatingSettings(menu, { activeProviderId: target.value }).catch(showMenuError);
    }
    if (target.dataset.role === "display-mode") void updateDisplayMode(menu, target).catch(showMenuError);
  });
  menu.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || target.disabled) return;
    event.preventDefault();

    const action = target.dataset.action;
    if (action === "more") {
      const expanded = menu.toggleAttribute("data-more-open");
      target.setAttribute("aria-expanded", String(expanded));
      target.querySelector("span")!.textContent = expanded ? "收起更多" : "更多功能";
      const ball = document.getElementById(FLOATING_ID);
      if (ball) positionMenu(menu, ball);
      return;
    }
    if (action === "settings" || action === "doubao-settings") {
      void sendRuntimeRequest({ type: "OPEN_OPTIONS_PAGE" }).catch(showMenuError);
      return;
    }
    if (action === "close") {
      void setFloatingBallEnabled(false).catch(showMenuError);
      return;
    }
    if (action === "context-menu-translation") void toggleContextMenuTranslation(menu).catch(showMenuError);
    if (action === "auto-translation") void toggleAutoTranslation(menu).catch(showMenuError);
    if (action === "add-auto-site") void toggleCurrentAutoTranslationSite(menu).catch(showMenuError);
    if (action === "selection-translation") void toggleReadingFeature(menu, "selection").catch(showMenuError);
    if (action === "image-translation") void toggleReadingFeature(menu, "image").catch(showMenuError);
    if (action === "page-toggle") void togglePageTranslationFromFloating();
    if (action === "paragraph-mode") void toggleMenuParagraphMode(menu, target).catch(showMenuError);
    if (action === "retranslate") void togglePageTranslationFromFloating(true);
  });
  document.documentElement.append(menu);
  const menuSize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
    const ball = document.getElementById(FLOATING_ID);
    if (!menu.hidden && ball) positionMenu(menu, ball, true);
  });
  menuSize?.observe(menu);
  window.addEventListener("pagehide", () => menuSize?.disconnect(), { once: true });
}

function createHighlight(): void {
  if (document.getElementById(HIGHLIGHT_ID)) return;
  const highlight = document.createElement("div");
  highlight.id = HIGHLIGHT_ID;
  highlight.hidden = true;
  document.documentElement.append(highlight);
}

function setActiveParagraph(paragraph: Element | null): void {
  activeParagraph?.removeAttribute(ACTIVE_ATTRIBUTE);
  activeParagraph = paragraph;
  activeParagraph?.setAttribute(ACTIVE_ATTRIBUTE, "true");
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

function openMenu(): void {
  cancelMenuOpen();
  cancelMenuClose();
  if (dragging || !floatingBallEnabled || document.fullscreenElement) return;
  const menu = document.getElementById("wupage-floating-menu");
  const button = document.getElementById(FLOATING_ID);
  if (!menu || !button) return;
  setMenuOpen(menu, true);
  positionMenu(menu, button);
  void settingsSave.then(() => updateMenuState(menu)).catch(showMenuError);
}

function scheduleMenuOpen(): void {
  cancelMenuClose();
  cancelMenuOpen();
  const menu = document.getElementById("wupage-floating-menu");
  if (dragging || !floatingBallEnabled || !menu || !menu.hidden) return;
  menuOpenTimer = window.setTimeout(() => {
    menuOpenTimer = undefined;
    openMenu();
  }, MENU_OPEN_DELAY);
}

function cancelMenuOpen(): void {
  if (menuOpenTimer !== undefined) window.clearTimeout(menuOpenTimer);
  menuOpenTimer = undefined;
}

function cancelMenuClose(): void {
  if (menuCloseTimer !== undefined) window.clearTimeout(menuCloseTimer);
  menuCloseTimer = undefined;
}

function scheduleMenuClose(): void {
  cancelMenuOpen();
  cancelMenuClose();
  if (touchInteraction) return;
  menuCloseTimer = window.setTimeout(() => {
    menuCloseTimer = undefined;
    const menu = document.getElementById("wupage-floating-menu");
    if (menu?.matches(":hover")) return;
    // Keep native language/provider pickers and keyboard navigation usable.
    if (menu?.contains(document.activeElement) &&
      (document.activeElement instanceof HTMLSelectElement || document.activeElement?.matches(":focus-visible"))) return;
    if (menu) setMenuOpen(menu, false);
  }, MENU_CLOSE_DELAY);
}

function positionMenu(menu: HTMLElement, button: HTMLElement, preserveTop = false): void {
  if (menu.dataset.touch === "true" && visibleViewport().width < 640) {
    const view = visibleViewport();
    const width = Math.max(0, view.width - EDGE_MARGIN * 2);
    const maxHeight = Math.max(0, Math.min(560, view.height * 0.8, view.height - EDGE_MARGIN * 2));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.setProperty("left", `${view.left + EDGE_MARGIN}px`, "important");
    const bottomTop = view.bottom - Math.min(menu.offsetHeight || maxHeight, maxHeight) - EDGE_MARGIN;
    const previousTop = preserveTop ? Number.parseFloat(menu.style.top) : NaN;
    menu.style.setProperty("top", `${Number.isFinite(previousTop) ? clamp(previousTop, view.top + EDGE_MARGIN, bottomTop) : bottomTop}px`, "important");
    return;
  }
  const size = getFloatingSize(button);
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  // Use the settled position so the edge reveal animation cannot move the menu.
  const rect = button.getBoundingClientRect();
  const ballLeft = hitbox ? Number.parseFloat(hitbox.style.left) + HITBOX_PADDING : rect.left;
  const ballTop = hitbox ? Number.parseFloat(hitbox.style.top) + HITBOX_PADDING : rect.top;
  const leftAnchor = ballLeft + (button.dataset.edge === "left" ? 20 : button.dataset.edge === "right" ? -20 : 0);
  const availableLeft = leftAnchor - EDGE_MARGIN * 2;
  const availableRight = window.innerWidth - leftAnchor - size - EDGE_MARGIN * 2;
  const availableSide = Math.max(availableLeft, availableRight);
  const viewportWidth = Math.max(0, window.innerWidth - EDGE_MARGIN * 2);
  const beside = availableSide >= Math.min(240, viewportWidth);
  const width = Math.min(296, beside ? availableSide : viewportWidth);
  const availableAbove = Math.max(0, ballTop - EDGE_MARGIN * 2);
  const availableBelow = Math.max(0, window.innerHeight - ballTop - size - EDGE_MARGIN * 2);
  const maxHeight = beside ? window.innerHeight - EDGE_MARGIN * 2 : Math.max(availableAbove, availableBelow);
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(0, maxHeight)}px`;
  const menuWidth = menu.offsetWidth || width;
  const menuHeight = menu.offsetHeight || Math.min(460, maxHeight);
  const preferredLeft = beside
    ? availableLeft >= availableRight ? leftAnchor - menuWidth - EDGE_MARGIN : leftAnchor + size + EDGE_MARGIN
    : leftAnchor + size / 2 - menuWidth / 2;
  const left = clamp(preferredLeft, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - menuWidth - EDGE_MARGIN));
  const previousTop = preserveTop ? Number.parseFloat(menu.style.top) : NaN;
  const preferredTop = Number.isFinite(previousTop) ? previousTop : beside
    ? ballTop + size / 2 - menuHeight / 2
    : availableAbove >= availableBelow ? ballTop - menuHeight - EDGE_MARGIN : ballTop + size + EDGE_MARGIN;
  const top = clamp(preferredTop, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - menuHeight - EDGE_MARGIN));
  menu.style.setProperty("left", `${left}px`, "important");
  menu.style.setProperty("top", `${top}px`, "important");
}

function closeMenuOnOutsideClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest(`#${FLOATING_ID}, #${FLOATING_HITBOX_ID}, #wupage-floating-menu`)) return;
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) setMenuOpen(menu, false);
}

async function updateMenuState(menu: HTMLElement): Promise<void> {
  syncParagraphModeButton(menu);
  refreshTranslationState();

  const settings = await getSettings();
  applyMenuSettings(menu, settings);
}

function applyMenuSettings(menu: HTMLElement, settings: ExtensionSettings): void {
  const automatic = menu.querySelector<HTMLButtonElement>("[data-action='auto-translation']");
  if (automatic) automatic.setAttribute("aria-pressed", String(settings.autoTranslation?.enabled === true));
  menu.dataset.doubaoProvider = String(settings.providers.find((provider) => provider.id === settings.activeProviderId)?.type === "doubao-web");
  updateAutoTranslationSiteButton(menu, settings.autoTranslation);
  const contextMenu = menu.querySelector<HTMLButtonElement>("[data-action='context-menu-translation']");
  if (contextMenu) contextMenu.setAttribute("aria-pressed", String(settings.contextMenuTranslationEnabled === true));
  menu.querySelector("[data-action='selection-translation']")?.setAttribute("aria-pressed", String(normalizeSelectionTranslation(settings.selectionTranslation).enabled));
  const imageToggle = menu.querySelector<HTMLButtonElement>("[data-action='image-translation']");
  if (imageToggle) setImageTranslationToggle(imageToggle, settings.imageTranslationEnabled === true);
  void menuOcr?.refresh();
  menu.querySelector("[data-action='close']")?.setAttribute("aria-pressed", String(settings.floatingBallEnabled));
  let localNotice = menu.querySelector<HTMLElement>("[data-role='local-notice']");
  const noticeText = localProviderNotice(settings) ?? doubaoProviderNotice(settings);
  if (!localNotice && noticeText) {
    localNotice = document.createElement("p");
    localNotice.dataset.role = "local-notice";
    localNotice.setAttribute("role", "status");
    localNotice.className = "wupage-provider-notice";
    menu.querySelector("[data-role='provider']")?.closest("label")?.after(localNotice);
  }
  if (localNotice) {
    localNotice.textContent = noticeText ?? ""; localNotice.hidden = !noticeText;
    renderLocalModelNotice(localNotice, settings, sendRuntimeRequest,
      () => { void sendRuntimeRequest({ type: "OPEN_OPTIONS_PAGE" }).catch(showMenuError); }, () => !menu.hidden);
  }
  const sourceLangSelect = menu.querySelector<HTMLSelectElement>("[data-role='source-lang']");
  if (sourceLangSelect) {
    ensureLanguageOption(sourceLangSelect, settings.sourceLang);
    sourceLangSelect.value = settings.sourceLang;
    syncSelectValue(sourceLangSelect);
  }
  const targetLangSelect = menu.querySelector<HTMLSelectElement>("[data-role='target-lang']");
  if (targetLangSelect) {
    ensureLanguageOption(targetLangSelect, settings.targetLang);
    targetLangSelect.value = settings.targetLang;
    syncSelectValue(targetLangSelect);
  }
  if (targetLangSelect) syncDoubaoTargetControls(settings, targetLangSelect);
  const providerSelect = menu.querySelector<HTMLSelectElement>("[data-role='provider']");
  if (providerSelect) {
    const providers = settings.providers.filter((provider) => provider.enabled !== false);
    const signature = JSON.stringify(providers.map(({ id, label }) => [id, label]));
    if (providerSelect.dataset.options !== signature) {
      providerSelect.replaceChildren(...providers.map((provider) => new Option(provider.label, provider.id)));
      providerSelect.dataset.options = signature;
    }
    if (!providers.some((provider) => provider.id === settings.activeProviderId)) {
      const unavailable = new Option("当前服务不可用，请选择其他服务", settings.activeProviderId);
      unavailable.disabled = true;
      providerSelect.prepend(unavailable);
      delete providerSelect.dataset.options;
    }
    providerSelect.value = settings.activeProviderId;
    for (const option of providerSelect.options) {
      const config = providers.find((provider) => provider.id === option.value);
      if (config) option.disabled = isDoubaoProviderUnavailable(config);
    }
    enhanceProviderSelect(providerSelect, settings.providers);
  }
  const mode = menu.querySelector<HTMLSelectElement>("[data-role='display-mode']");
  if (mode) mode.value = settings.translationDisplayMode;
  syncParagraphModeButton(menu);
  const button = document.getElementById(FLOATING_ID);
  if (button && !menu.hidden) positionMenu(menu, button, true);
  refreshTranslationState();
}

function syncSelectValue(select: HTMLSelectElement): void {
  const value = select.parentElement?.querySelector<HTMLElement>(
    `[data-role="${select.dataset.role}-value"]`
  );
  if (!value) return;
  value.textContent = select.selectedOptions[0]?.textContent?.trim() || select.value;
}
function ensureLanguageOption(select: HTMLSelectElement, language: string): void {
  if (Array.from(select.options).some((option) => option.value === language)) return;
  const option = document.createElement("option");
  option.value = language;
  option.textContent = language;
  select.prepend(option);
}

async function restorePosition(button: HTMLElement): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    const result = await chrome.storage.local.get(POSITION_KEY);
    const position = result[POSITION_KEY] as FloatingPosition | undefined;
    if (isFloatingPosition(position)) {
      applyFloatingPosition(button, position);
      return;
    }
  }

  const size = getFloatingSize(button);
  const position: FloatingPosition = {
    left: window.innerWidth - EDGE_VISIBLE,
    top: clamp(window.innerHeight - DEFAULT_BOTTOM, EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN),
    edge: "right"
  };
  applyFloatingPosition(button, position);
  void savePosition(position);
}

function applyFloatingPosition(button: HTMLElement, position: FloatingPosition): void {
  const size = getFloatingSize(button);
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - size - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN);
  const left = position.edge === "left"
    ? EDGE_VISIBLE - size
    : position.edge === "right"
      ? window.innerWidth - EDGE_VISIBLE
      : clamp(position.left, EDGE_MARGIN, maxLeft);
  if (position.edge) button.dataset.edge = position.edge;
  else delete button.dataset.edge;
  setButtonPosition(button, left, clamp(position.top, EDGE_MARGIN, maxTop));
}

function keepPositionInViewport(button: HTMLElement): void {
  if (dragging) return;
  const rect = button.getBoundingClientRect();
  const edge = button.dataset.edge;
  applyFloatingPosition(button, {
    left: rect.left,
    top: rect.top,
    edge: edge === "left" || edge === "right" ? edge : null
  });
}

function getFloatingSize(button: HTMLElement): number {
  return button.offsetWidth || FLOATING_SIZE;
}

function snapToEdge(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const size = getFloatingSize(button);
  const edge = rect.left + size / 2 < window.innerWidth / 2 ? "left" : "right";
  const left = edge === "left" ? EDGE_VISIBLE - size : window.innerWidth - EDGE_VISIBLE;
  const top = clamp(rect.top, EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN);
  setButtonPosition(button, left, top);
  button.dataset.edge = edge;
  void savePosition({ left, top, edge });
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
  void savePosition({ left, top, edge: null });
}

function savePosition(position: FloatingPosition): Promise<void> {
  return saveLocal({ [POSITION_KEY]: position });
}

function setButtonPosition(button: HTMLElement, left: number, top: number): void {
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  const target = hitbox ?? button;
  const offset = hitbox ? HITBOX_PADDING : 0;
  target.style.setProperty("left", `${left - offset}px`, "important");
  target.style.setProperty("top", `${top - offset}px`, "important");
  target.style.setProperty("right", "auto", "important");
  target.style.setProperty("bottom", "auto", "important");

  const menu = document.getElementById("wupage-floating-menu");
  if (menu && isMenuOpen(menu)) positionMenu(menu, button);
}

function setMenuOpen(menu: HTMLElement, open: boolean): void {
  open = open && floatingBallEnabled && !document.fullscreenElement;
  cancelMenuOpen();
  cancelMenuClose();
  if (!open) cancelLongPress();
  menu.hidden = !open;
  syncTouchMenu(menu);
  if (open) {
    document.getElementById("wupage-touch-hint")?.remove();
    if (menuOcr) void menuOcr.refresh();
    else {
      const toggle = menu.querySelector<HTMLButtonElement>("[data-action='image-translation']")!;
      menuOcr = setupOcrControl(toggle, () => toggle.setAttribute("aria-pressed", "false"), {
        request: sendRuntimeRequest,
        helpId: "wupage-ocr-help",
        shouldPoll: () => menu.isConnected && !menu.hidden && toggle.getAttribute("aria-busy") !== "true",
        elements: {
          action: menu.querySelector<HTMLButtonElement>("[data-role='ocr-action']")!,
          description: menu.querySelector<HTMLElement>("#wupage-ocr-description")!,
          status: menu.querySelector<HTMLElement>("#wupage-ocr-status")!,
          progress: menu.querySelector<HTMLProgressElement>("[data-role='ocr-progress']")!
        }
      });
    }
  } else menuOcr?.pause();
  const button = document.getElementById(FLOATING_ID);
  button?.classList.toggle("is-menu-open", open);
  button?.setAttribute("aria-expanded", String(open));
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
    Number.isFinite((value as FloatingPosition).left) &&
    typeof (value as FloatingPosition).top === "number" &&
    Number.isFinite((value as FloatingPosition).top) &&
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

async function togglePageTranslationFromFloating(force = false): Promise<void> {
  const state = getPageTranslationState();
  const busy = pageActionPending || state.pending > 0;
  if ((force || (!busy && !state.active && !hasPageTranslations()))
    && document.getElementById("wupage-floating-menu")?.dataset.doubaoProvider === "true"
    && Math.max(menuRetryAt ?? 0, state.retryAt ?? 0) > Date.now()) {
    refreshTranslationState();
    revealMenu();
    return;
  }
  menuError = null;
  menuErrorCode = undefined;
  menuRetryAt = Math.max(menuRetryAt ?? 0, state.retryAt ?? 0) || undefined;
  if (!force && (busy || state.active || hasPageTranslations())) {
    pageActionVersion += 1;
    pageActionPending = false;
    clearPageFromFloating();
    refreshTranslationState();
    return;
  }
  if (busy) return;

  const actionVersion = ++pageActionVersion;
  pageActionPending = true;
  refreshTranslationState();
  try {
    await settingsSave;
    if (actionVersion !== pageActionVersion) return;
    const settings = await loadPageTranslationSettings();
    if (actionVersion !== pageActionVersion) return;
    const result = await startPageTranslation(settings, !force);
    if (actionVersion !== pageActionVersion) return;
    if (result.failed > 0) revealMenu();
  } catch (error) {
    if (actionVersion === pageActionVersion) showMenuError(error);
  } finally {
    if (actionVersion === pageActionVersion) {
      pageActionPending = false;
      refreshTranslationState();
    }
  }
}

export function refreshTranslationState(): void {
  clearTimeout(retryStatusTimer);
  const state = getPageTranslationState();
  const busy = pageActionPending || state.pending > 0;
  const translated = hasPageTranslations();
  const translationEnabled = state.active || translated;
  refreshPageContextState(translationEnabled);
  // Incremental batches change progress, but the action remains restoring the original.
  const actionLabel = busy || translationEnabled ? "显示原文" : "翻译全文";
  const ball = document.getElementById(FLOATING_ID);
  ball?.classList.toggle("wupage-is-loading", busy || translating);
  ball?.setAttribute("aria-busy", String(busy));
  ball?.setAttribute("aria-disabled", "false");
  ball?.setAttribute("aria-label", actionLabel);
  if (ball) ball.title = floatingBallTitle(actionLabel);
  const label = ball?.querySelector(".wupage-floating-label");
  const ballLabel = busy || translationEnabled ? "原" : "译";
  if (label && label.textContent !== ballLabel) label.textContent = ballLabel;

  const menu = document.getElementById("wupage-floating-menu");
  if (!menu) return;
  const errorCode = menuErrorCode ?? state.errorCode;
  const retryAt = menu.dataset.doubaoProvider === "true" ? Math.max(menuRetryAt ?? 0, state.retryAt ?? 0) : 0;
  const retrySeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const recovery = menu.querySelector<HTMLButtonElement>("[data-action='doubao-settings']");
  if (recovery) {
    recovery.hidden = menu.dataset.doubaoProvider !== "true";
    recovery.textContent = errorCode === "login-required" ? "去设置登录豆包并检测" : "豆包登录与检测";
  }
  const pageToggle = menu.querySelector<HTMLButtonElement>("[data-action='page-toggle']");
  if (pageToggle) {
    if (pageToggle.textContent !== actionLabel) pageToggle.textContent = actionLabel;
    pageToggle.disabled = retrySeconds > 0 && !translationEnabled && !busy;
  }
  const retry = menu.querySelector<HTMLButtonElement>("[data-action='retranslate']");
  if (retry) {
    retry.hidden = !translationEnabled && state.failed === 0 && !state.error && !menuError;
    retry.disabled = busy || retrySeconds > 0;
    const retryLabel = retrySeconds > 0 ? `等待 ${retrySeconds} 秒后重试` : state.failed > 0 || state.error || menuError ? "重试翻译" : "重新翻译";
    if (retry.textContent !== retryLabel) retry.textContent = retryLabel;
  }
  const status = menu.querySelector<HTMLElement>("[data-role='translation-status']");
  if (status) {
    status.dataset.tone = menuError || state.error || state.failed > 0 ? "error" : "normal";
    let message = menuError
      ?? (busy
        ? `正在翻译当前区域${state.translated ? `，已完成 ${state.translated} 段` : ""}，点击「原」可停止并恢复原文。`
        : state.failed > 0
          ? `已翻译 ${state.translated} 段，失败 ${state.failed} 段。${state.error ?? "请重试。"}`
          : state.error ? `翻译未完成：${state.error}` : state.translated > 0
            ? `已翻译 ${state.translated} 段${state.cached ? ` · 缓存命中 ${state.cached} 段` : ""}。滚动页面继续翻译。`
            : translated
              ? "已显示译文，点击悬浮球可恢复原文。"
              : state.active
                ? "当前区域暂无可翻译内容，滚动页面将继续翻译。"
                : "点击悬浮球即可翻译全文。");
    if (retrySeconds > 0) message += ` 请等待约 ${retrySeconds} 秒后再试。`;
    if (status.textContent !== message) status.textContent = message;
  }
  if (!menu.hidden && retrySeconds > 0) retryStatusTimer = setTimeout(refreshTranslationState, Math.min(retryAt - Date.now() + 10, 1000));
  if (!menu.hidden && ball) positionMenu(menu, ball, true);
}

function floatingBallTitle(action: string): string {
  const touch = touchInteraction || window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
  return `${touch ? "轻点" : "单击"}${action} · ${touch ? "长按" : "悬停"}打开菜单 · 拖动调整位置`;
}

function showMenuError(error: unknown): void {
  menuError = error instanceof Error ? error.message : String(error);
  menuErrorCode = error instanceof ProviderError ? error.errorCode : undefined;
  menuRetryAt = error instanceof ProviderError && error.retryAfterMs !== undefined ? Date.now() + error.retryAfterMs : undefined;
  revealMenu();
  refreshTranslationState();
}

function revealMenu(): void {
  const menu = document.getElementById("wupage-floating-menu");
  const ball = document.getElementById(FLOATING_ID);
  if (menu && ball && floatingBallEnabled && !dragging) {
    const wasOpen = !menu.hidden;
    setMenuOpen(menu, true);
    positionMenu(menu, ball, wasOpen);
  }
}

function clearPageFromFloating(): void {
  hidePageTranslation();
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
  setHtmlContent(panel, `
    <header>
      <strong>Debug</strong>
      <button type="button" data-action="close-debug" title="关闭" aria-label="关闭 Debug 面板">${uiIconMarkup("cross")}</button>
    </header>
    <div class="wupage-debug-summary">正在读取任务...</div>
    <div class="wupage-debug-list"></div>
    <div class="wupage-debug-resize" title="调整窗口大小" aria-label="调整 Debug 窗口大小"></div>
  `);
  const header = panel.querySelector("header");
  const resizeHandle = panel.querySelector<HTMLElement>(".wupage-debug-resize");
  header?.addEventListener("pointerdown", startDebugDrag);
  resizeHandle?.addEventListener("pointerdown", startDebugResize);
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

function startDebugResize(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const panel = document.getElementById(DEBUG_PANEL_ID);
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  debugResizing = true;
  debugResizeStartX = event.clientX;
  debugResizeStartY = event.clientY;
  debugResizeStartWidth = rect.width;
  debugResizeStartHeight = rect.height;
  panel.classList.add("is-resizing");
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.width = `${rect.width}px`;
  panel.style.height = `${rect.height}px`;
  window.addEventListener("pointermove", resizeDebugPanel);
  window.addEventListener("pointerup", stopDebugResize);
  window.addEventListener("pointercancel", stopDebugResize);
}

function resizeDebugPanel(event: PointerEvent): void {
  if (!debugResizing) return;
  const panel = document.getElementById(DEBUG_PANEL_ID);
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const maxWidth = Math.max(1, window.innerWidth - rect.left - 8);
  const maxHeight = Math.max(1, window.innerHeight - rect.top - 8);
  const minWidth = Math.min(280, maxWidth);
  const minHeight = Math.min(200, maxHeight);
  panel.style.width = `${clamp(
    debugResizeStartWidth + event.clientX - debugResizeStartX,
    minWidth,
    maxWidth
  )}px`;
  panel.style.height = `${clamp(
    debugResizeStartHeight + event.clientY - debugResizeStartY,
    minHeight,
    maxHeight
  )}px`;
}

function stopDebugResize(): void {
  const panel = document.getElementById(DEBUG_PANEL_ID);
  debugResizing = false;
  panel?.classList.remove("is-resizing");
  window.removeEventListener("pointermove", resizeDebugPanel);
  window.removeEventListener("pointerup", stopDebugResize);
  window.removeEventListener("pointercancel", stopDebugResize);
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
    if (snapshot.frames?.length) {
      const frames = document.createElement("details");
      frames.className = "wupage-debug-task";
      const title = document.createElement("summary");
      title.textContent = `页面文档 ${snapshot.frames.length}`;
      frames.append(title);
      const labels = { ready: "就绪", loading: "接入中", translating: "翻译中", "waiting-viewport": "等待滚动或显示",
        empty: "没有可翻译正文", excluded: "已排除", unavailable: "无法访问", failed: "翻译失败" };
      for (const frame of snapshot.frames) {
        const row = document.createElement("p");
        row.textContent = `${frame.frameId === 0 ? "主页面" : "嵌入页面"} · ${labels[frame.status]} · ${frame.url.slice(0, 240)}${frame.reason ? ` · ${frame.reason}` : ""}`;
        if (frame.frameId !== 0 && /^https?:/u.test(frame.url) && isLikelyPdfUrl(frame.url)) {
          const open = document.createElement("button");
          open.type = "button"; open.textContent = "翻译此 PDF";
          open.addEventListener("click", () => { void sendRuntimeRequest({ type: "OPEN_EMBEDDED_PDF", url: frame.url }).catch(() => {}); });
          row.append(" ", open);
        }
        frames.append(row);
      }
      list.prepend(frames);
    }
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
  const previous = floatingBallEnabled;
  floatingBallEnabled = enabled;
  applyFloatingBallVisibility();
  try {
    const settings = await getSettings();
    if (settings.floatingBallEnabled !== enabled) {
      await sendRuntimeRequest({ type: "SAVE_SETTINGS", settings: { ...settings, floatingBallEnabled: enabled }, previousSettings: settings } satisfies RuntimeRequest);
    }
  } catch (error) {
    floatingBallEnabled = previous;
    applyFloatingBallVisibility();
    throw error;
  }
}

export async function setParagraphMode(enabled: boolean, broadcast = true): Promise<void> {
  const revision = paragraphModeRevision;
  if (broadcast && chrome.runtime?.id) {
    await sendRuntimeRequest({ type: "SET_PARAGRAPH_MODE", enabled });
    // A storage event may already have applied this or a newer global change.
    if (revision !== paragraphModeRevision) return;
  }
  paragraphModeRevision++;
  paragraphMode = enabled;
  document.documentElement.classList.toggle("wupage-paragraph-mode", paragraphMode);
  setActiveParagraph(null);
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) await updateMenuState(menu);
}

async function syncFloatingBallFromSettings(): Promise<void> {
  const settings = await getSettings();
  localShortcuts = normalizeLocalShortcuts(settings.localShortcuts);
  shortcutEnabled = normalizeShortcutEnabled(settings.shortcutEnabled, settings.shortcuts, localShortcuts);
  floatingBallEnabled = settings.floatingBallEnabled;
  const menu = document.getElementById("wupage-floating-menu");
  if (menu) applyMenuSettings(menu, settings);
  applyFloatingBallVisibility();
}

function applyFloatingBallVisibility(): void {
  const hitbox = document.getElementById(FLOATING_HITBOX_ID);
  const menu = document.getElementById("wupage-floating-menu");
  const visible = floatingBallEnabled && !document.fullscreenElement;
  if (hitbox) {
    hitbox.hidden = !visible || hitbox.dataset.positionReady !== "true";
  }
  if (!visible) {
    cancelMenuOpen();
    cancelLongPress();
    if (menu) setMenuOpen(menu, false);
    setActiveParagraph(null);
  }
}

async function updateLanguages(menu: HTMLElement): Promise<void> {
  const sourceLang = menu.querySelector<HTMLSelectElement>("[data-role='source-lang']")?.value;
  const targetLang = menu.querySelector<HTMLSelectElement>("[data-role='target-lang']")?.value;
  if (!sourceLang || !targetLang) return;
  await updateFloatingSettings(menu, { sourceLang, targetLang });
}

async function toggleAutoTranslation(menu: HTMLElement): Promise<void> {
  const button = menu.querySelector<HTMLButtonElement>("[data-action='auto-translation']")!;
  if (button.disabled) return;
  button.disabled = true; button.setAttribute("aria-busy", "true");
  menu.querySelector<HTMLButtonElement>("[data-action='add-auto-site']")!.disabled = true;
  try {
    const settings = await getSettings();
    const rules = normalizeAutoTranslation(settings.autoTranslation);
    await updateFloatingSettings(menu, { autoTranslation: setAutoTranslationEnabled(rules, !rules.enabled) });
  } finally {
    button.disabled = false; button.setAttribute("aria-busy", "false");
    await getSettings().then(settings => applyMenuSettings(menu, settings)).catch(() => {});
  }
}

function updateAutoTranslationSiteButton(menu: HTMLElement, value: ExtensionSettings["autoTranslation"]): void {
  const add = menu.querySelector<HTMLButtonElement>("[data-action='add-auto-site']")!;
  const automatic = menu.querySelector<HTMLButtonElement>("[data-action='auto-translation']")!;
  const pattern = currentWebsitePattern(window.location.href);
  const added = hasAutoTranslationWebsite(value, window.location.href);
  add.hidden = !normalizeAutoTranslation(value).enabled;
  add.disabled = !pattern || automatic.getAttribute("aria-busy") === "true" || add.getAttribute("aria-busy") === "true";
  setHtmlContent(add, uiIconMarkup(added ? "tick" : "plus"));
  add.setAttribute("aria-pressed", String(added));
  const label = !pattern ? "请切换到普通网页后再添加网站" : added ? `将 ${pattern} 排除自动翻译` : `将 ${pattern} 加入自动翻译列表`;
  add.title = label;
  add.setAttribute("aria-label", label);
}

async function toggleCurrentAutoTranslationSite(menu: HTMLElement): Promise<void> {
  const add = menu.querySelector<HTMLButtonElement>("[data-action='add-auto-site']")!;
  const automatic = menu.querySelector<HTMLButtonElement>("[data-action='auto-translation']")!;
  if (add.disabled || automatic.disabled) return;
  const include = add.getAttribute("aria-pressed") !== "true";
  add.disabled = automatic.disabled = true;
  add.setAttribute("aria-busy", "true"); automatic.setAttribute("aria-busy", "true");
  try {
    await updateFloatingSettings(menu, previous => ({ autoTranslation: include ? addAutoTranslationWebsite(previous.autoTranslation, window.location.href) : excludeAutoTranslationWebsite(previous.autoTranslation, window.location.href) }));
  } finally {
    automatic.disabled = false;
    add.disabled = false;
    add.setAttribute("aria-busy", "false"); automatic.setAttribute("aria-busy", "false");
    await getSettings().then(settings => applyMenuSettings(menu, settings)).catch(() => {});
  }
}

async function toggleContextMenuTranslation(menu: HTMLElement): Promise<void> {
  const button = menu.querySelector<HTMLButtonElement>("[data-action='context-menu-translation']")!;
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const settings = await getSettings();
    await updateFloatingSettings(menu, { contextMenuTranslationEnabled: settings.contextMenuTranslationEnabled !== true });
  } finally {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
  }
}

async function toggleReadingFeature(menu: HTMLElement, feature: "selection" | "image"): Promise<void> {
  const button = menu.querySelector<HTMLButtonElement>(`[data-action='${feature}-translation']`)!;
  if (button.disabled) return;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await updateFloatingSettings(menu, previous => feature === "image" ? { imageTranslationEnabled: enabled } : {
      selectionTranslation: { ...normalizeSelectionTranslation(previous.selectionTranslation), enabled }
    });
  } finally {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    if (feature === "image") void menuOcr?.refresh();
  }
}

async function updateDisplayMode(menu: HTMLElement, select: HTMLSelectElement): Promise<void> {
  const requested = select.value;
  select.disabled = true;
  select.setAttribute("aria-busy", "true");
  try {
    await updateFloatingSettings(menu, { translationDisplayMode: requested as TranslationDisplayMode });
  } finally {
    select.disabled = false;
    select.setAttribute("aria-busy", "false");
  }
}

function syncParagraphModeButton(menu: HTMLElement): void {
  const button = menu.querySelector<HTMLButtonElement>('[data-action="paragraph-mode"]');
  const touch = menu.dataset.touch === "true";
  if (button) {
    const pressed = String(!touch && paragraphMode);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const label = button.querySelector("span")!, text = touch ? "点选段落" : "段落翻译";
    if (label.textContent !== text) label.textContent = text;
    const title = touch ? "点选一个正文段落，翻译后自动退出" : "开启段落翻译模式";
    if (button.title !== title) button.title = title;
  }
  const hint = menu.querySelector<HTMLElement>(".wupage-menu-hint");
  if (hint) {
    hint.hidden = touch || !paragraphMode || button?.hidden === true;
    const text = paragraphClickHint(localShortcuts, shortcutEnabled["paragraph-click"]);
    if (hint.textContent !== text) hint.textContent = text;
  }
}

async function toggleMenuParagraphMode(menu: HTMLElement, button: HTMLButtonElement): Promise<void> {
  if (menu.dataset.touch === "true") {
    setMenuOpen(menu, false);
    startTouchParagraph();
    return;
  }
  const previous = paragraphMode;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await setParagraphMode(!previous);
  } catch (error) {
    await setParagraphMode(previous).catch(() => {});
    throw error;
  } finally {
    syncParagraphModeButton(menu);
    button.disabled = button.hidden;
    button.setAttribute("aria-busy", "false");
  }
}

function syncTouchMenu(menu: HTMLElement): void {
  const touch = touchInteraction || hasTouchInput();
  menu.dataset.touch = String(touch);
  const ball = document.getElementById(FLOATING_ID);
  if (ball) ball.dataset.touch = String(touch);
  const more = menu.querySelector<HTMLButtonElement>('[data-action="more"]');
  if (more) more.hidden = !touch;
  syncParagraphModeButton(menu);
}

function updateFloatingSettings(menu: HTMLElement, change: Partial<ExtensionSettings> | ((settings: ExtensionSettings) => Partial<ExtensionSettings>)): Promise<void> {
  const save = settingsSave.catch(() => undefined).then(async () => {
    const previous = await getSettings();
    const patch = typeof change === "function" ? change(previous) : change;
    const settings = { ...previous, ...patch };
    try {
      await sendRuntimeRequest({ type: "SAVE_SETTINGS", settings, previousSettings: previous } satisfies RuntimeRequest);
    } catch (error) {
      applyMenuSettings(menu, settingsSnapshot.current() ?? previous);
      throw error;
    }
    if (patch.translationDisplayMode) setPageTranslationDisplayMode(patch.translationDisplayMode);
    menuError = null;
    menuErrorCode = undefined;
    menuRetryAt = undefined;
    applyMenuSettings(menu, await getSettings());
    refreshTranslationState();
  });
  settingsSave = save;
  void save.catch(() => {
    if (settingsSave === save) settingsSave = Promise.resolve();
  });
  return save;
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
  return settingsSnapshot.read();
}

async function readSettings(): Promise<ExtensionSettings> {
  return sendRuntimeRequest<ExtensionSettings>({
    type: "GET_SETTINGS"
  } satisfies RuntimeRequest);
}
