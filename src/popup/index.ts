import { sendRuntimeMessage, sendTabMessage } from "../shared/messaging";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import type { ExtensionSettings } from "../shared/types";
import "./styles.css";
import { setImageTranslationToggle, setupOcrControl } from "../shared/ocr-control";
import { getExtensionDetailsUrl, isLikelyPdfUrl, openPdfWorkspaceInNewTab } from "../pdf/launch";
import { localProviderNotice } from "../shared/local-notice";
import { enhanceProviderSelect } from "../shared/provider-picker";
import { normalizeAutoTranslation, setAutoTranslationEnabled } from "../shared/auto-translation";
import { SETTINGS_KEY } from "../shared/defaults";

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
const provider = query<HTMLSelectElement>("#provider");
const translationDisplayMode = query<HTMLSelectElement>("#translationDisplayMode");
const status = query<HTMLParagraphElement>("#status");
const pageToggleButton = query<HTMLButtonElement>("#pageToggle");
const openPdfWorkspaceButton = query<HTMLButtonElement>("#openPdfWorkspace");
const fileAccessHelp = query<HTMLDivElement>("#fileAccessHelp");
const openFileAccessSettingsButton = query<HTMLButtonElement>("#openFileAccessSettings");
const paragraphModeButton = query<HTMLButtonElement>("#paragraphMode");
const autoTranslationButton = query<HTMLButtonElement>("#autoTranslation");
const floatingBallButton = query<HTMLButtonElement>("#floatingBall");
const imageTranslationButton = query<HTMLButtonElement>("#imageTranslation");
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
let paragraphModeError: string | undefined;
let autoTranslationNotice: string | undefined;
let pageTranslated = false;
let pageActionVersion = 0;
let floatingBallEnabled = true;
let activeTabIsPdf = false;
let pageTranslationAvailable = true;

void init().catch((error: unknown) => {
  pageTranslationAvailable = false;
  updatePageActionAvailability();

  setStatus(error instanceof Error ? error.message : String(error));
});

async function init(): Promise<void> {
  openFileAccessSettingsButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: getExtensionDetailsUrl(chrome.runtime.id, navigator.userAgent) })
      .then(() => window.close()).catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
  });
  // Manual selection works even when file access hides the active tab's URL.
  openPdfWorkspaceButton.addEventListener("click", () => {
    void openPdfWorkspaceInNewTab(
      (properties) => chrome.tabs.create(properties),
      (path) => chrome.runtime.getURL(path)
    ).then(() => window.close()).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  });
  settings = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  provider.innerHTML = settings.providers
    .filter((entry) => entry.enabled !== false)
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  provider.value = settings.activeProviderId;
  enhanceProviderSelect(provider, settings.providers);
  updateLocalNotice();
  translationDisplayMode.innerHTML = TRANSLATION_DISPLAY_MODES
    .map((mode) => `<option value="${mode.value}">${mode.label}</option>`)
    .join("");
  translationDisplayMode.value = settings.translationDisplayMode;
  updateAutoTranslationButton();
  autoTranslationButton.addEventListener("click", toggleAutoTranslation);
  floatingBallEnabled = settings.floatingBallEnabled;
  updateFloatingBallButton();
  setImageTranslationToggle(imageTranslationButton, settings.imageTranslationEnabled === true);
  setupOcrControl(imageTranslationButton, () => { settings.imageTranslationEnabled = false; setImageTranslationToggle(imageTranslationButton, false); });
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  fileAccessHelp.hidden = Boolean(activeTab?.url);
  activeTabIsPdf = isLikelyPdfUrl(activeTab?.url);
  pageTranslationAvailable = activeTabIsPdf || isSupportedPageUrl(activeTab?.url);
  if (pageTranslationAvailable && !activeTabIsPdf) {
    await loadParagraphMode();
    await loadTranslationState();
  } else if (!pageTranslationAvailable) {
    paragraphModeAvailable = false;
    paragraphModeButton.title = "浏览器设置页和扩展内部页面不支持段落模式。";
    pageToggleButton.title = "请切换到普通网页后再翻译。";
    debugButton.title = "请切换到普通网页后再打开 Debug。";
    setStatus(activeTab?.url
      ? "此页面不支持翻译，请切换到网页或 PDF。"
      : "无法读取当前页面地址。若为本地 PDF，请开启扩展的文件访问权限，或点击“打开 PDF”选择文件。");
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
  translationDisplayMode.addEventListener("change", savePopupSettings);
  pageToggleButton.addEventListener("click", togglePageTranslation);
  paragraphModeButton.addEventListener("click", toggleParagraphMode);
  floatingBallButton.addEventListener("click", toggleFloatingBall);
  imageTranslationButton.addEventListener("click", async () => {
    setButtonBusy(imageTranslationButton, true);
    const previous = settings.imageTranslationEnabled === true;
    try {
      settings.imageTranslationEnabled = !previous;
      await savePopupSettings();
      setImageTranslationToggle(imageTranslationButton, !previous);
      setStatus(!previous ? "图片翻译已开启，点击图片旁的“译”按钮即可覆盖翻译。" : "图片翻译已关闭，已恢复原图。");
    } catch (error) {
      settings.imageTranslationEnabled = previous;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setButtonBusy(imageTranslationButton, false);
    }
  });
  debugButton.addEventListener("click", openDebugPanel);
  clearCacheButton.addEventListener("click", clearCache);
  optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  githubButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: GITHUB_URL });
  });
  websiteButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: WEBSITE_URL });
  });
  const settingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const incoming = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !incoming || autoTranslationButton.getAttribute("aria-busy") === "true") return;
    settings.autoTranslation = normalizeAutoTranslation(incoming.autoTranslation);
    updateAutoTranslationButton();
  };
  chrome.storage?.onChanged?.addListener(settingsChanged);
  let syncing = false;
  const timer = !activeTabIsPdf && pageTranslationAvailable && activeTab?.id
    ? window.setInterval(() => {
      if (syncing || pageToggleButton.getAttribute("aria-busy") === "true") return;
      syncing = true;
      const version = pageActionVersion;
      void sendTabMessage<{ translated: boolean }>(activeTab.id!, { type: "GET_TRANSLATION_STATE" }).then(result => {
        if (version !== pageActionVersion || pageToggleButton.getAttribute("aria-busy") === "true") return;
        if (pageTranslated !== result.translated) { pageTranslated = result.translated; updatePageToggleButton(); }
      }).catch(() => {}).finally(() => { syncing = false; });
    }, 500) : undefined;
  window.addEventListener("pagehide", () => {
    if (timer !== undefined) clearInterval(timer);
    chrome.storage?.onChanged?.removeListener?.(settingsChanged);
  }, { once: true });
}

async function savePopupSettings(): Promise<void> {
  settings = {
    ...settings,
    sourceLang: sourceLang.value || "auto",
    targetLang: targetLang.value || "zh-CN",
    activeProviderId: provider.value,
    translationDisplayMode: translationDisplayMode.value as ExtensionSettings["translationDisplayMode"]
  };
  await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
  updateLocalNotice();
}

function updateLocalNotice(): void {
  let notice = document.getElementById("localProviderNotice");
  const message = localProviderNotice(settings);
  if (!notice && message) {
    notice = document.createElement("p"); notice.id = "localProviderNotice";
    notice.setAttribute("role", "status"); notice.style.cssText = "line-height:1.6;font-size:12px;padding:10px;border:1px solid #c7a557;border-radius:8px";
    provider.closest("label")?.after(notice);
  }
  if (notice) { notice.textContent = message ?? ""; notice.hidden = !message; }
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
  const previous = pageTranslated;
  const version = ++pageActionVersion;
  const request = { type: previous ? "CLEAR_TRANSLATION" : "TRANSLATE_PAGE" } as const;
  pageTranslated = !previous;
  updatePageToggleButton();
  setPageToggleBusy(request.type === "TRANSLATE_PAGE", true);
  setStatus(request.type === "TRANSLATE_PAGE" ? "正在翻译..." : "正在显示原文...");
  try {
    // Stop immediately even when the original settings save or page request is
    // still pending. Its late completion must not restart or repaint the action.
    if (request.type === "TRANSLATE_PAGE") await savePopupSettings();
    if (version !== pageActionVersion) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (version !== pageActionVersion) return;
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
    if (version !== pageActionVersion) return;
    if (request.type === "CLEAR_TRANSLATION") {
      setStatus(result.cleared ? "已显示原文。" : "没有可清除的译文。");
    } else {
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
    if (version !== pageActionVersion) return;
    pageTranslated = previous;
    updatePageToggleButton();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    if (version === pageActionVersion) setPageToggleBusy(false);
  }
}

function setButtonBusy(button: HTMLButtonElement, value: boolean): void {
  button.disabled = value;
  button.setAttribute("aria-busy", String(value));
}

async function openPdfTranslator(): Promise<void> {
  await savePopupSettings();
  const pageUrl = new URL(chrome.runtime.getURL("pdf.html"));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && isLikelyPdfUrl(tab.url)) {
    pageUrl.searchParams.set("url", tab.url);
    pageUrl.searchParams.set("translate", "1");
  }
  await chrome.tabs.create({ url: pageUrl.toString() });
  window.close();
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

function setPageToggleBusy(value: boolean, cancellable = false): void {
  pageToggleButton.disabled = (value && !cancellable) || !pageTranslationAvailable;
  pageToggleButton.classList.toggle("is-loading", value);
  pageToggleButton.setAttribute("aria-busy", String(value));
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

async function toggleAutoTranslation(): Promise<void> {
  if (autoTranslationNotice && status.textContent === autoTranslationNotice) setStatus("");
  autoTranslationNotice = undefined;
  const enabled = autoTranslationButton.getAttribute("aria-pressed") !== "true";
  let previous = normalizeAutoTranslation(settings.autoTranslation);
  setButtonBusy(autoTranslationButton, true);
  try {
    const latest = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
    previous = normalizeAutoTranslation(latest.autoTranslation);
    settings = { ...latest, autoTranslation: setAutoTranslationEnabled(previous, enabled) };
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
    updateAutoTranslationButton();
    const rules = settings.autoTranslation!;
    if (enabled && !rules.nonTargetLanguage && !rules.presetSites.length && !rules.customSites.some(site => site.enabled)) {
      autoTranslationNotice = "自动翻译已开启，请在设置中启用站点或语言规则。";
      setStatus(autoTranslationNotice);
    }
  } catch (error) {
    settings = { ...settings, autoTranslation: previous };
    updateAutoTranslationButton();
    autoTranslationNotice = error instanceof Error ? error.message : String(error);
    setStatus(autoTranslationNotice);
  } finally { setButtonBusy(autoTranslationButton, false); }
}

function updateAutoTranslationButton(): void {
  const rules = normalizeAutoTranslation(settings.autoTranslation);
  autoTranslationButton.setAttribute("aria-pressed", String(rules.enabled));
  autoTranslationButton.title = rules.nonTargetLanguage ? "自动翻译非目标语言页面；可在设置中限定站点" : "按已配置的站点规则自动翻译";
  if (autoTranslationButton.hasAttribute("data-loading")) {
    void autoTranslationButton.offsetWidth;
    autoTranslationButton.removeAttribute("data-loading");
    autoTranslationButton.disabled = false;
  }
}

async function toggleParagraphMode(): Promise<void> {
  setButtonBusy(paragraphModeButton, true);
  if (paragraphModeError && status.textContent === paragraphModeError) setStatus("");
  paragraphModeError = undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error("没有活动标签页。");
    const result = await sendTabMessage<{ enabled: boolean }>(tab.id, {
      type: "SET_PARAGRAPH_MODE",
      enabled: !paragraphMode
    });
    paragraphMode = result.enabled;
    updateParagraphModeButton();
  } catch (error) {
    paragraphModeError = error instanceof Error ? error.message : String(error);
    setStatus(paragraphModeError);
  } finally {
    setButtonBusy(paragraphModeButton, false);
  }
}

async function toggleFloatingBall(): Promise<void> {
  setButtonBusy(floatingBallButton, true);
  setStatus("正在切换悬浮球...");
  const previous = floatingBallEnabled;
  let saved = false;
  try {
    floatingBallEnabled = !floatingBallEnabled;
    settings = {
      ...settings,
      floatingBallEnabled
    };
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
    saved = true;
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
    if (!saved) {
      floatingBallEnabled = previous;
      settings = { ...settings, floatingBallEnabled };
    }
    updateFloatingBallButton();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonBusy(floatingBallButton, false);
  }
}

async function openDebugPanel(): Promise<void> {
  if (!pageTranslationAvailable || activeTabIsPdf) {
    setStatus("此页面无法打开 Debug，请切换到普通网页。");
    return;
  }
  setButtonBusy(debugButton, true);
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
    setButtonBusy(debugButton, false);
  }
}

async function clearCache(): Promise<void> {
  setButtonBusy(clearCacheButton, true);
  setStatus("正在清除缓存...");
  try {
    const result = await sendRuntimeMessage<{ removed: number }>({
      type: "CLEAR_CACHE"
    });
    setStatus(`已清除 ${result.removed} 条缓存。`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonBusy(clearCacheButton, false);
  }
}

function updateParagraphModeButton(): void {
  paragraphModeButton.setAttribute("aria-pressed", String(paragraphMode));
}

function updatePageToggleButton(): void {
  const label = activeTabIsPdf
    ? "翻译PDF"
    : pageTranslated ? "显示全文" : "翻译全文";
  if (pageToggleButton.textContent !== label) pageToggleButton.textContent = label;
}

function updateFloatingBallButton(): void {
  floatingBallButton.setAttribute("aria-pressed", String(floatingBallEnabled));
}

function updatePageActionAvailability(): void {
  pageToggleButton.disabled = !pageTranslationAvailable;
  paragraphModeButton.disabled = !paragraphModeAvailable;
  debugButton.disabled = !pageTranslationAvailable || activeTabIsPdf;
}
