import type { ExtensionSettings } from "../shared/types";
import type { TranslationShortcut } from "../shared/shortcuts";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import { hasPageTranslations } from "./dom";
import { getParagraphMode, refreshTranslationState, setParagraphMode } from "./floating";
import { getPageTranslationState, hidePageTranslation, setPageTranslationDisplayMode, startPageTranslation } from "./page-translation";
import { sendRuntimeRequest } from "./runtime";
import { translateShortcutParagraphs } from "./paragraph-shortcut";

let pageRevision = 0;
let startingPage = false;
let modeUpdate = Promise.resolve();
let noticeTimer: number | undefined;

/** Shared actions for configurable page shortcuts and internal extension messages. */
export async function executeTranslationShortcut(command: TranslationShortcut): Promise<void> {
  try {
    if (command === "toggle-page-translation") await togglePage();
    else if (command === "translate-selection") {
      await translateShortcutParagraphs();
      refreshTranslationState();
    }
    else if (command === "toggle-paragraph-mode") {
      const enabled = !getParagraphMode();
      await setParagraphMode(enabled);
      showShortcutNotice(enabled ? "段落模式已开启，按配置的修饰键点击段落即可翻译。" : "段落模式已关闭。");
    } else if (command === "cycle-display-mode") {
      // Rapid presses should advance from the last saved mode, not the same stale value.
      modeUpdate = modeUpdate.catch(() => undefined).then(cycleDisplayMode);
      await modeUpdate;
    }
  } catch (error) {
    showShortcutNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function togglePage(): Promise<void> {
  const revision = ++pageRevision;
  if (startingPage || getPageTranslationState().active || hasPageTranslations()) {
    startingPage = false;
    hidePageTranslation();
    refreshTranslationState();
    showShortcutNotice("已停止翻译并恢复原文。");
    return;
  }
  startingPage = true;
  try {
    const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
    if (revision !== pageRevision) return;
    // The popup or floating control may have started translation while settings loaded.
    if (getPageTranslationState().active) return;
    showShortcutNotice("正在翻译全文，再次操作可恢复原文。");
    const result = await startPageTranslation(settings);
    const state = getPageTranslationState();
    if (revision !== pageRevision || result.cancelled || !state.active) return;
    if (result.failed) showShortcutNotice(`部分段落翻译失败：${result.error ?? "请检查翻译服务设置。"}`, true);
    else if (result.error) showShortcutNotice(`翻译未完成：${result.error}`, true);
    else if (state.pending) showShortcutNotice("正在翻译当前区域，后续内容将自动继续翻译。");
    else if (result.translated) showShortcutNotice(`已翻译 ${result.translated} 段${result.remaining ? "，滚动页面继续翻译" : ""}。`);
    else showShortcutNotice("当前区域暂无可翻译内容，新内容加载或滚动页面后将自动翻译。");
    refreshTranslationState();
  } catch (error) {
    if (revision === pageRevision) throw error;
  } finally {
    if (revision === pageRevision) startingPage = false;
  }
}

async function cycleDisplayMode(): Promise<void> {
  const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
  const index = TRANSLATION_DISPLAY_MODES.findIndex(mode => mode.value === settings.translationDisplayMode);
  const mode = TRANSLATION_DISPLAY_MODES[(index + 1) % TRANSLATION_DISPLAY_MODES.length];
  await sendRuntimeRequest({ type: "SAVE_SETTINGS", settings: { ...settings, translationDisplayMode: mode.value }, previousSettings: settings });
  await setParagraphMode(false);
  setPageTranslationDisplayMode(mode.value);
  refreshTranslationState();
  showShortcutNotice(`译文显示：${mode.label}`);
}

function showShortcutNotice(message: string, error = false): void {
  window.clearTimeout(noticeTimer);
  let host = document.getElementById("wupage-shortcut-notice");
  if (!host) {
    host = document.createElement("div");
    host.id = "wupage-shortcut-notice";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto 16px 24px!important;z-index:2147483647!important;pointer-events:none!important;display:flex!important;justify-content:center!important;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{font:14px/1.6 system-ui}p{margin:0;padding:10px 16px;max-width:520px;border:1px solid #637570;border-radius:10px;background:#20352f;color:#fff;box-shadow:0 4px 20px #0002;overflow-wrap:anywhere}p[data-error=true]{background:#78322d;border-color:#a56560}";
    const notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    root.append(style, notice);
    document.documentElement.append(host);
  }
  const notice = host.shadowRoot!.querySelector("p")!;
  notice.textContent = message;
  notice.dataset.error = String(error);
  noticeTimer = window.setTimeout(() => host.remove(), error ? 6000 : 3500);
}
