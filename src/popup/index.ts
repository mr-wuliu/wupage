import { sendRuntimeMessage, sendTabMessage } from "../shared/messaging";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import type { ExtensionSettings } from "../shared/types";
import "./styles.css";

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
const provider = query<HTMLSelectElement>("#provider");
const status = query<HTMLParagraphElement>("#status");
const pageToggleButton = query<HTMLButtonElement>("#pageToggle");
const paragraphModeButton = query<HTMLButtonElement>("#paragraphMode");
const floatingBallButton = query<HTMLButtonElement>("#floatingBall");
const debugButton = query<HTMLButtonElement>("#debug");
const clearCacheButton = query<HTMLButtonElement>("#clearCache");
const optionsButton = query<HTMLButtonElement>("#openOptions");
const githubButton = query<HTMLButtonElement>("#openGithub");
const websiteButton = query<HTMLButtonElement>("#openWebsite");
const GITHUB_URL = "https://github.com/mr-wuliu/wupage";
const WEBSITE_URL = "https://wupage.mrwuliu.top/";

let settings: ExtensionSettings;
let paragraphMode = false;
let paragraphModeAvailable = true;
let pageTranslated = false;
let floatingBallEnabled = true;
let activeTabIsPdf = false;
let pageTranslationAvailable = true;

void init().catch((error: unknown) => {
  pageTranslationAvailable = false;
  updatePageActionAvailability();
  setStatus(error instanceof Error ? error.message : String(error));
});

async function init(): Promise<void> {
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  provider.innerHTML = settings.providers
    .filter((entry) => entry.enabled !== false)
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  provider.value = settings.activeProviderId;
  floatingBallEnabled = settings.floatingBallEnabled;
  updateFloatingBallButton();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabIsPdf = Boolean(activeTab.url && isLikelyPdfUrl(activeTab.url));
  pageTranslationAvailable = activeTabIsPdf || isSupportedPageUrl(activeTab.url);
  if (pageTranslationAvailable && !activeTabIsPdf) {
    await loadParagraphMode();
    await loadTranslationState();
  } else if (!pageTranslationAvailable) {
    paragraphModeAvailable = false;
    paragraphModeButton.title = "浏览器设置页和扩展内部页面不支持段落模式。";
    pageToggleButton.title = "请切换到普通网页后再翻译。";
    debugButton.title = "请切换到普通网页后再打开 Debug。";
    setStatus("此页面不支持翻译，请切换到普通网页。");
  }
  if (activeTabIsPdf) {
    paragraphModeAvailable = false;
    paragraphModeButton.disabled = true;
    paragraphModeButton.title = "PDF 使用独立的双栏翻译页面。";
    updatePageToggleButton();
  }
  updatePageActionAvailability();

  targetLang.addEventListener("change", savePopupSettings);
  sourceLang.addEventListener("change", savePopupSettings);
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
  websiteButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: WEBSITE_URL });
  });
}

async function savePopupSettings(): Promise<void> {
  settings = {
    ...settings,
    sourceLang: sourceLang.value || "auto",
    targetLang: targetLang.value || "zh-CN",
    activeProviderId: provider.value
  };
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
}

function renderLanguageOptions(
  select: HTMLSelectElement,
  value: string,
  languages: ReadonlyArray<{ code: string; label: string }>
): void {
  const options = languages.some((entry) => entry.code === value)
    ? languages
    : [{ code: value, label: value }, ...languages];
  select.innerHTML = options
    .map((entry) => `<option value="${escapeHtml(entry.code)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  select.value = value;
}

async function togglePageTranslation(): Promise<void> {
  if (!pageTranslationAvailable) {
    setStatus("此页面不支持翻译，请切换到普通网页。");
    return;
  }
  if (activeTabIsPdf) {
    setPageToggleBusy(true);
    setStatus("正在打开 PDF 并开始翻译...");
    try {
      await openPdfTranslator();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setPageToggleBusy(false);
    }
    return;
  }
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
  pageToggleButton.disabled = value || !pageTranslationAvailable;
  paragraphModeButton.disabled = value || !paragraphModeAvailable;
  floatingBallButton.disabled = value;
  debugButton.disabled = value || !pageTranslationAvailable || activeTabIsPdf;
  clearCacheButton.disabled = value;
}

async function openPdfTranslator(): Promise<void> {
  await savePopupSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageUrl = new URL(chrome.runtime.getURL("pdf.html"));
  if (tab.url && isLikelyPdfUrl(tab.url)) {
    pageUrl.searchParams.set("url", tab.url);
    pageUrl.searchParams.set("translate", "1");
  }
  await chrome.tabs.create({ url: pageUrl.toString() });
  window.close();
}

function isLikelyPdfUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.pathname.toLowerCase().endsWith(".pdf") || url.search.toLowerCase().includes(".pdf"));
  } catch {
    return false;
  }
}

function isSupportedPageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function setPageToggleBusy(value: boolean): void {
  pageToggleButton.disabled = value || !pageTranslationAvailable;
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
    if (pageTranslationAvailable && !activeTabIsPdf && tab.id) {
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
  if (!pageTranslationAvailable || activeTabIsPdf) {
    setStatus("此页面无法打开 Debug，请切换到普通网页。");
    return;
  }
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
  pageToggleButton.textContent = activeTabIsPdf
    ? "翻译 PDF"
    : pageTranslated ? "显示全文" : "翻译全文";
}

function updateFloatingBallButton(): void {
  floatingBallButton.setAttribute("aria-pressed", String(floatingBallEnabled));
}

function updatePageActionAvailability(): void {
  pageToggleButton.disabled = !pageTranslationAvailable;
  paragraphModeButton.disabled = !paragraphModeAvailable;
  debugButton.disabled = !pageTranslationAvailable || activeTabIsPdf;
}
