import { sendRuntimeMessage, sendTabMessage } from "../shared/messaging";
import { TARGET_LANGUAGES } from "../shared/languages";
import type { ExtensionSettings } from "../shared/types";
import "./styles.css";

const targetLang = query<HTMLSelectElement>("#targetLang");
const provider = query<HTMLSelectElement>("#provider");
const status = query<HTMLParagraphElement>("#status");
const pageToggleButton = query<HTMLButtonElement>("#pageToggle");
const paragraphModeButton = query<HTMLButtonElement>("#paragraphMode");
const floatingBallButton = query<HTMLButtonElement>("#floatingBall");
const debugButton = query<HTMLButtonElement>("#debug");
const clearCacheButton = query<HTMLButtonElement>("#clearCache");
const optionsButton = query<HTMLButtonElement>("#openOptions");
const githubButton = query<HTMLButtonElement>("#openGithub");
const GITHUB_URL = "https://github.com/mr-wuliu/wupage";

let settings: ExtensionSettings;
let paragraphMode = false;
let paragraphModeAvailable = true;
let pageTranslated = false;
let floatingBallEnabled = true;

void init();

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  const languages = TARGET_LANGUAGES.some((entry) => entry.code === settings.targetLang)
    ? TARGET_LANGUAGES
    : [{ code: settings.targetLang, label: settings.targetLang }, ...TARGET_LANGUAGES];
  targetLang.innerHTML = languages
    .map((entry) => `<option value="${escapeHtml(entry.code)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  targetLang.value = settings.targetLang;
  provider.innerHTML = settings.providers
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  provider.value = settings.activeProviderId;
  floatingBallEnabled = settings.floatingBallEnabled;
  updateFloatingBallButton();
  await loadParagraphMode();
  await loadTranslationState();

  targetLang.addEventListener("change", savePopupSettings);
  provider.addEventListener("change", savePopupSettings);
  pageToggleButton.addEventListener("click", togglePageTranslation);
  paragraphModeButton.addEventListener("click", toggleParagraphMode);
  floatingBallButton.addEventListener("click", toggleFloatingBall);
  debugButton.addEventListener("click", openDebugPanel);
  clearCacheButton.addEventListener("click", clearCache);
  optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  githubButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: GITHUB_URL });
  });
}

async function savePopupSettings(): Promise<void> {
  settings = {
    ...settings,
    targetLang: targetLang.value || "zh-CN",
    activeProviderId: provider.value
  };
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
}

async function togglePageTranslation(): Promise<void> {
  const request = { type: pageTranslated ? "CLEAR_TRANSLATION" : "TRANSLATE_PAGE" } as const;
  setPageToggleBusy(true);
  setStatus(request.type === "TRANSLATE_PAGE" ? "正在翻译..." : "正在显示原文...");
  try {
    await savePopupSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error("没有活动标签页。");
    const result = await sendTabMessage<{
      translated?: number;
      cached?: number;
      failed?: number;
      error?: string;
      remaining?: number;
      cleared?: boolean;
    }>(
      tab.id,
      request
    );
    if (request.type === "CLEAR_TRANSLATION") {
      pageTranslated = false;
      updatePageToggleButton();
      setStatus(result.cleared ? "已显示原文。" : "没有可清除的译文。");
    } else {
      pageTranslated = (result.translated ?? 0) > 0;
      updatePageToggleButton();
      const failed = result.failed ?? 0;
      setStatus(
        failed > 0
          ? `已翻译 ${result.translated ?? 0} 段，失败 ${failed} 段：${result.error ?? ""}`
          : result.remaining
            ? `已翻译当前区域 ${result.translated ?? 0} 段，滚动页面将继续翻译。`
            : `已翻译 ${result.translated ?? 0} 段，缓存命中 ${result.cached ?? 0} 段。`
      );
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setPageToggleBusy(false);
  }
}

function setBusy(value: boolean): void {
  document.body.classList.toggle("is-busy", value);
  pageToggleButton.disabled = value;
  paragraphModeButton.disabled = value || !paragraphModeAvailable;
  floatingBallButton.disabled = value;
  debugButton.disabled = value;
  clearCacheButton.disabled = value;
}

function setPageToggleBusy(value: boolean): void {
  pageToggleButton.disabled = value;
  pageToggleButton.classList.toggle("is-loading", value);
}

function setStatus(value: string): void {
  status.textContent = value;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

async function loadParagraphMode(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    const result = await sendTabMessage<{ enabled: boolean }>(tab.id, {
      type: "GET_PARAGRAPH_MODE"
    });
    paragraphMode = result.enabled;
    updateParagraphModeButton();
  } catch {
    paragraphModeAvailable = false;
    paragraphModeButton.disabled = true;
    paragraphModeButton.title = "段落模式需要在普通网页刷新后使用。";
  }
}

async function loadTranslationState(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    const result = await sendTabMessage<{ translated: boolean }>(tab.id, {
      type: "GET_TRANSLATION_STATE"
    });
    pageTranslated = result.translated;
    updatePageToggleButton();
  } catch {
    pageTranslated = false;
    updatePageToggleButton();
  }
}

async function toggleParagraphMode(): Promise<void> {
  setBusy(true);
  setStatus("正在切换段落模式...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error("没有活动标签页。");
    const result = await sendTabMessage<{ enabled: boolean }>(tab.id, {
      type: "SET_PARAGRAPH_MODE",
      enabled: !paragraphMode
    });
    paragraphMode = result.enabled;
    updateParagraphModeButton();
    setStatus(paragraphMode ? "段落模式已开启。" : "段落模式已关闭。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function toggleFloatingBall(): Promise<void> {
  setBusy(true);
  setStatus("正在切换悬浮球...");
  try {
    floatingBallEnabled = !floatingBallEnabled;
    settings = {
      ...settings,
      floatingBallEnabled
    };
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await sendTabMessage<{ enabled: boolean }>(tab.id, {
        type: "SET_FLOATING_BALL",
        enabled: floatingBallEnabled
      }).catch(() => undefined);
    }
    updateFloatingBallButton();
    setStatus(floatingBallEnabled ? "悬浮球已开启。" : "悬浮球已关闭。");
  } catch (error) {
    updateFloatingBallButton();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function openDebugPanel(): Promise<void> {
  setBusy(true);
  setStatus("正在打开 Debug...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error("没有活动标签页。");
    await sendTabMessage<{ opened: boolean }>(tab.id, {
      type: "OPEN_TRANSLATION_DEBUG"
    });
    setStatus("Debug 已打开。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function clearCache(): Promise<void> {
  setBusy(true);
  setStatus("正在清除缓存...");
  try {
    const result = await sendRuntimeMessage<{ removed: number }>({
      type: "CLEAR_CACHE"
    });
    setStatus(`已清除 ${result.removed} 条缓存。`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

function updateParagraphModeButton(): void {
  paragraphModeButton.setAttribute("aria-pressed", String(paragraphMode));
}

function updatePageToggleButton(): void {
  pageToggleButton.textContent = pageTranslated ? "显示全文" : "翻译全文";
}

function updateFloatingBallButton(): void {
  floatingBallButton.setAttribute("aria-pressed", String(floatingBallEnabled));
}
