import { initializeInterfaceLanguage, localizeDocument, t, htmlMessage } from "../shared/i18n";
import { sendRuntimeMessage, sendTabMessage } from "../shared/messaging";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { TRANSLATION_DISPLAY_MODES } from "../shared/display-modes";
import type { ExtensionSettings } from "../shared/types";
import type { DocumentTranslationState } from "../shared/frame-session";
import "./styles.css";
import "../shared/appearance.css";
import { setupAppearance } from "../shared/appearance-runtime";
import { setImageTranslationToggle, setupOcrControl } from "../shared/ocr-control";
import { getExtensionDetailsUrl, isLikelyPdfUrl, openPdfWorkspaceInNewTab } from "../pdf/launch";
import { localProviderNotice, renderLocalModelNotice } from "../shared/local-notice";
import { enhanceProviderSelect } from "../shared/provider-picker";
import { addAutoTranslationWebsite, currentWebsitePattern, excludeAutoTranslationWebsite, hasAutoTranslationWebsite, normalizeAutoTranslation, setAutoTranslationEnabled } from "../shared/auto-translation";
import { normalizeSelectionTranslation } from "../shared/dictionary";
import { SETTINGS_KEY } from "../shared/defaults";
import { doubaoProviderNotice, isDoubaoProviderUnavailable, syncDoubaoTargetControls } from "../shared/doubao-ui";
import { renderUiIcons, uiIconMarkup } from "../shared/ui-icons";
import { createSettingsSnapshot } from "../shared/settings-snapshot";
import { observeParagraphMode } from "../shared/paragraph-mode";
import { normalizeVideoTranslation } from "../shared/video";
import { normalizeAppearance } from "../shared/appearance";
import { applyPopupMenuLayout } from "../shared/popup-menu";
import { paragraphClickHint } from "../shared/local-shortcuts";
import { hasTouchInput, TOUCH_INPUT_QUERY } from "../shared/touch";

await initializeInterfaceLanguage();
localizeDocument(document);
renderUiIcons();

const targetLang = query<HTMLSelectElement>("#targetLang");
const sourceLang = query<HTMLSelectElement>("#sourceLang");
const provider = query<HTMLSelectElement>("#provider");
const translationDisplayMode = query<HTMLSelectElement>("#translationDisplayMode");
const status = query<HTMLParagraphElement>("#status");
const pageToggleButton = query<HTMLButtonElement>("#pageToggle");
const openPdfWorkspaceButton = query<HTMLButtonElement>("#openPdfWorkspace");
const videoTranslationButton = query<HTMLButtonElement>("#videoTranslation");
const fileAccessHelp = query<HTMLDivElement>("#fileAccessHelp");
const openFileAccessSettingsButton = query<HTMLButtonElement>("#openFileAccessSettings");
const paragraphModeButton = query<HTMLButtonElement>("#paragraphMode");
const paragraphModeHint = query<HTMLSpanElement>("#paragraphModeHint");
const contextMenuTranslationButton = query<HTMLButtonElement>("#contextMenuTranslation");
const autoTranslationButton = query<HTMLButtonElement>("#autoTranslation");
const addAutoTranslationSiteButton = query<HTMLButtonElement>("#addAutoTranslationSite");
const selectionTranslationButton = query<HTMLButtonElement>("#selectionTranslation");
const floatingBallButton = query<HTMLButtonElement>("#floatingBall");
const imageTranslationButton = query<HTMLButtonElement>("#imageTranslation");
const debugButton = query<HTMLButtonElement>("#debug");
const clearCacheButton = query<HTMLButtonElement>("#clearCache");
const optionsButton = query<HTMLButtonElement>("#openOptions");
const githubButton = query<HTMLButtonElement>("#openGithub");
const websiteButton = query<HTMLButtonElement>("#openWebsite");
const moreFeaturesButton = query<HTMLButtonElement>("#moreFeatures");
const GITHUB_URL = "https://github.com/mr-wuliu/wupage";
const WEBSITE_URL = "https://wupage.mrwuliu.top/";

let settings: ExtensionSettings;
let paragraphMode = false;
let paragraphModeRevision = 0;
let paragraphModeAvailable = true;
let paragraphModeError: string | undefined;
let autoTranslationNotice: string | undefined;
let pageTranslated = false;
let followingPageProgress = false;
let pageActionVersion = 0;
let floatingBallEnabled = true;
let activeTabIsPdf = false;
let activePageURL: string | undefined;
let pageTranslationAvailable = true;
let settingsReady = false;
let settingsSave: Promise<unknown> = Promise.resolve();
let touchControls = hasTouchInput();
let lastPointerTouch = touchControls;
const settingsSnapshot = createSettingsSnapshot(() => sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" }));

void init().catch((error: unknown) => {
  pageTranslationAvailable = false;
  updatePageActionAvailability();

  setStatus(error instanceof Error ? error.message : String(error));
});

async function init(): Promise<void> {
  const stopParagraphMode = observeParagraphMode(enabled => {
    paragraphModeRevision++;
    paragraphMode = enabled;
    updateParagraphModeButton();
  });
  window.addEventListener("pagehide", stopParagraphMode, { once: true });
  chrome.storage?.onChanged?.addListener(settingsChanged);
  window.addEventListener("pagehide", () => chrome.storage?.onChanged?.removeListener?.(settingsChanged), { once: true });
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
  settings = await settingsSnapshot.read();
  setupAppearance(settings.appearance);
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  provider.innerHTML = settings.providers
    .filter((entry) => entry.enabled !== false)
    .map((entry) => `<option value="${escapeHtml(entry.id)}" ${isDoubaoProviderUnavailable(entry) ? `disabled title="${htmlMessage("doubaoTranslationIsUnavailableInThisBrowser")}"` : ""}>${escapeHtml(entry.label)}</option>`)
    .join("");
  provider.value = settings.activeProviderId;
  enhanceProviderSelect(provider, settings.providers);
  syncDoubaoTargetControls(settings, targetLang);
  updateLocalNotice();
  translationDisplayMode.innerHTML = TRANSLATION_DISPLAY_MODES
    .map((mode) => `<option value="${mode.value}">${mode.label}</option>`)
    .join("");
  const pointerMedia = window.matchMedia?.(TOUCH_INPUT_QUERY);
  const updateTouchControls = () => {
    touchControls = hasTouchInput();
    lastPointerTouch = touchControls;
    refreshMenuLayout();
    updateParagraphModeButton();
  };
  updateTouchControls();
  pointerMedia?.addEventListener("change", updateTouchControls);
  moreFeaturesButton.addEventListener("click", () => {
    const expanded = document.querySelector(".popup")!.toggleAttribute("data-more-open");
    moreFeaturesButton.setAttribute("aria-expanded", String(expanded));
    moreFeaturesButton.querySelector("span")!.textContent = expanded ? t("showLess") : t("moreFeatures");
  });
  const detectTouch = (event: PointerEvent) => {
    if (event.pointerType) lastPointerTouch = event.pointerType === "touch";
    if (event.pointerType !== "touch" || touchControls) return;
    // Wait until activation completes, so reordering cannot move a control under the finger.
    window.setTimeout(() => { touchControls = true; refreshMenuLayout(); updateParagraphModeButton(); }, 0);
  };
  document.addEventListener("pointerup", detectTouch);
  window.addEventListener("pagehide", () => {
    pointerMedia?.removeEventListener("change", updateTouchControls);
    document.removeEventListener("pointerup", detectTouch);
  }, { once: true });
  translationDisplayMode.value = settings.translationDisplayMode;
  updateAutoTranslationButton();
  autoTranslationButton.addEventListener("click", toggleAutoTranslation);
  addAutoTranslationSiteButton.addEventListener("click", toggleCurrentAutoTranslationSite);
  updateSelectionTranslationButton();
  selectionTranslationButton.addEventListener("click", toggleSelectionTranslation);
  selectionTranslationButton.disabled = false;
  floatingBallEnabled = settings.floatingBallEnabled;
  updateFloatingBallButton();
  setImageTranslationToggle(imageTranslationButton, settings.imageTranslationEnabled === true);
  setupOcrControl(imageTranslationButton, () => { settings.imageTranslationEnabled = false; setImageTranslationToggle(imageTranslationButton, false); });
  settingsReady = true;
  applyPopupSettings(settingsSnapshot.current() ?? settings);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activePageURL = activeTab?.url;
  updateAutoTranslationSiteButton();
  fileAccessHelp.hidden = Boolean(activeTab?.url);
  activeTabIsPdf = isLikelyPdfUrl(activeTab?.url);
  pageTranslationAvailable = activeTabIsPdf || isSupportedPageUrl(activeTab?.url);
  if (pageTranslationAvailable && !activeTabIsPdf) {
    await loadParagraphMode();
    await loadTranslationState();
  } else if (!pageTranslationAvailable) {
    paragraphModeAvailable = false;
    paragraphModeButton.title = t("paragraphModeIsUnavailableOnBrowserSettingsAnd");
    pageToggleButton.title = t("popupSwitchToWebPage");
    debugButton.title = t("switchToARegularWebPageToOpen");
    setStatus(activeTab?.url
      ? t("switchToAWebPageOrPdfTo")
      : t("couldNotReadTheCurrentPageAddressFor"));
  }
  if (activeTabIsPdf) {
    paragraphModeAvailable = false;
    paragraphModeButton.title = t("pdfsOpenInASeparateSideBySide");
    updatePageToggleButton();
  }
  updatePageActionAvailability();

  const saveSelection = () => { void savePopupSettings().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error))); };
  targetLang.addEventListener("change", saveSelection);
  sourceLang.addEventListener("change", saveSelection);
  provider.addEventListener("change", saveSelection);
  pageToggleButton.addEventListener("click", togglePageTranslation);
  videoTranslationButton.addEventListener("click", toggleVideoTranslation);
  videoTranslationButton.disabled = false;
  translationDisplayMode.addEventListener("change", saveSelection);
  paragraphModeButton.addEventListener("click", toggleParagraphMode);
  contextMenuTranslationButton.addEventListener("click", toggleContextMenuTranslation);
  updateContextMenuTranslationButton();
  translationDisplayMode.disabled = false;
  contextMenuTranslationButton.disabled = false;
  floatingBallButton.addEventListener("click", toggleFloatingBall);
  floatingBallButton.disabled = false;
  imageTranslationButton.addEventListener("click", async () => {
    setButtonBusy(imageTranslationButton, true);
    const previous = settings.imageTranslationEnabled === true;
    try {
      await updatePopupSettings({ imageTranslationEnabled: !previous });
      setStatus(!previous ? t("imageTranslationEnabledClickTrBesideAnImage") : t("imageTranslationDisabledOriginalImagesRestored"));
    } catch (error) {
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
  let syncing = false;
  const timer = !activeTabIsPdf && pageTranslationAvailable && activeTab?.id
    ? window.setInterval(() => {
      if (syncing || pageToggleButton.getAttribute("aria-busy") === "true") return;
      syncing = true;
      const version = pageActionVersion;
      void sendTabMessage<PageStatus>(activeTab.id!, { type: "GET_TRANSLATION_STATE", includeProgress: followingPageProgress }).then(result => {
        if (version !== pageActionVersion || pageToggleButton.getAttribute("aria-busy") === "true") return;
        if (pageTranslated !== result.translated) { pageTranslated = result.translated; updatePageToggleButton(); }
        if (followingPageProgress && result.progress) {
          if (result.progress.active) showPageTranslationStatus(result.progress);
          else setStatus(t("originalTextRestored"));
        }
      }).catch(() => {}).finally(() => { syncing = false; });
    }, 500) : undefined;
  window.addEventListener("pagehide", () => {
    if (timer !== undefined) clearInterval(timer);
  }, { once: true });
}

async function savePopupSettings(): Promise<void> {
  syncLanguageValue(sourceLang);
  syncLanguageValue(targetLang);
  const patch: Partial<ExtensionSettings> = {};
  if (sourceLang.value !== settings.sourceLang) patch.sourceLang = sourceLang.value || "auto";
  if (targetLang.value !== settings.targetLang) patch.targetLang = targetLang.value || "zh-CN";
  if (provider.value !== settings.activeProviderId) patch.activeProviderId = provider.value;
  if (translationDisplayMode.value !== settings.translationDisplayMode) {
    patch.translationDisplayMode = translationDisplayMode.value as ExtensionSettings["translationDisplayMode"];
  }
  // Capture the newest control selection while earlier saves are still queued.
  settings = { ...settings, ...patch };
  syncDoubaoTargetControls(settings, targetLang);
  await updatePopupSettings(patch);
}

function settingsChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  const incoming = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
  if (area !== "local" || !incoming) return;
  settingsSnapshot.receive(incoming);
  if (settingsReady) applyPopupSettings(incoming);
}

function applyPopupSettings(incoming: ExtensionSettings): void {
  settings = incoming;
  refreshMenuLayout();
  if (sourceLang.value !== settings.sourceLang) renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  if (targetLang.value !== settings.targetLang) renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  const providers = settings.providers.filter(entry => entry.enabled !== false);
  const signature = JSON.stringify(providers.map(({ id, label, type }) => [id, label, type]));
  if (provider.dataset.options !== signature || provider.value !== settings.activeProviderId) {
    provider.replaceChildren(...providers.map(entry => {
      const option = new Option(entry.label, entry.id);
      option.disabled = isDoubaoProviderUnavailable(entry);
      return option;
    }));
    if (!providers.some(entry => entry.id === settings.activeProviderId)) {
      const unavailable = new Option(t("currentServiceUnavailableChooseAnotherService"), settings.activeProviderId);
      unavailable.disabled = true;
      provider.prepend(unavailable);
    }
    provider.dataset.options = signature;
    provider.value = settings.activeProviderId;
    enhanceProviderSelect(provider, settings.providers);
  }
  if (translationDisplayMode.value !== settings.translationDisplayMode) translationDisplayMode.value = settings.translationDisplayMode;
  if (paragraphModeButton.getAttribute("aria-busy") !== "true") updateParagraphModeButton();
  if (videoTranslationButton.getAttribute("aria-busy") !== "true") updateVideoTranslationButton();
  if (contextMenuTranslationButton.getAttribute("aria-busy") !== "true") updateContextMenuTranslationButton();
  if (autoTranslationButton.getAttribute("aria-busy") !== "true") updateAutoTranslationButton();
  if (selectionTranslationButton.getAttribute("aria-busy") !== "true") updateSelectionTranslationButton();
  if (floatingBallButton.getAttribute("aria-busy") !== "true") {
    floatingBallEnabled = settings.floatingBallEnabled;
    updateFloatingBallButton();
  }
  if (imageTranslationButton.getAttribute("aria-busy") !== "true") setImageTranslationToggle(imageTranslationButton, settings.imageTranslationEnabled === true);
  syncDoubaoTargetControls(settings, targetLang);
  updateLocalNotice();
}

function updatePopupSettings(change: Partial<ExtensionSettings> | ((previous: ExtensionSettings) => Partial<ExtensionSettings>)): Promise<void> {
  const save = settingsSave.catch(() => undefined).then(async () => {
    const previous = await settingsSnapshot.read();
    const patch = typeof change === "function" ? change(previous) : change;
    try {
      await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings: { ...previous, ...patch }, previousSettings: previous });
      applyPopupSettings(await settingsSnapshot.read());
    } catch (error) {
      applyPopupSettings(settingsSnapshot.current() ?? previous);
      throw error;
    }
  });
  settingsSave = save;
  return save;
}

function updateLocalNotice(): void {
  let notice = document.getElementById("localProviderNotice");
  const message = localProviderNotice(settings) ?? doubaoProviderNotice(settings);
  if (!notice && message) {
    notice = document.createElement("p"); notice.id = "localProviderNotice";
    notice.setAttribute("role", "status"); notice.className = "wupage-provider-notice";
    provider.closest("label")?.after(notice);
  }
  if (notice) {
    notice.textContent = message ?? ""; notice.hidden = !message;
    renderLocalModelNotice(notice, settings, sendRuntimeMessage, () => { void chrome.runtime.openOptionsPage(); });
  }
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
  syncLanguageValue(select);
}

function syncLanguageValue(select: HTMLSelectElement): void {
  const label = select.parentElement?.querySelector<HTMLElement>(".language-value");
  if (label) label.textContent = select.selectedOptions[0]?.textContent ?? select.value;
}

async function togglePageTranslation(): Promise<void> {
  if (!pageTranslationAvailable) {
    setStatus(t("switchToARegularWebPageToTranslate"));
    return;
  }
  if (activeTabIsPdf) {
    setPageToggleBusy(true);
    setStatus(t("openingPdfAndStartingTranslation"));
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
  setStatus(request.type === "TRANSLATE_PAGE" ? t("popupTranslating") : t("showingOriginal"));
  try {
    // Stop immediately even when the original settings save or page request is
    // still pending. Its late completion must not restart or repaint the action.
    if (request.type === "TRANSLATE_PAGE") await savePopupSettings();
    if (version !== pageActionVersion) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (version !== pageActionVersion) return;
    if (!tab.id) throw new Error(t("noActiveTab"));
    const result = await sendTabMessage<Partial<DocumentTranslationState> & {
      cancelled?: boolean;
      cleared?: boolean;
    }>(
      tab.id,
      request
    );
    if (version !== pageActionVersion) return;
    if (request.type === "CLEAR_TRANSLATION") {
      setStatus(result.cleared ? t("originalTextRestored") : t("noTranslationsToClear"));
    } else if (result.cancelled) {
      setStatus(t("pageOrTranslationStateChangedTranslationCanceled"));
      await loadTranslationState();
    } else showPageTranslationStatus(result);
  } catch (error) {
    if (version !== pageActionVersion) return;
    pageTranslated = previous;
    updatePageToggleButton();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    if (version === pageActionVersion) setPageToggleBusy(false);
  }
}

function setButtonBusy(button: HTMLButtonElement | HTMLSelectElement, value: boolean): void {
  button.disabled = value;
  button.setAttribute("aria-busy", String(value));
  if (!value && settingsReady) applyPopupSettings(settingsSnapshot.current() ?? settings);
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

function setStatus(value: string, followPage = false): void {
  followingPageProgress = followPage;
  if (status.textContent !== value) status.textContent = value;
}

function showPageTranslationStatus(result: Partial<DocumentTranslationState>): void {
  const failed = result.failed ?? 0;
  const success = result.remaining
    ? result.translated ? t("paragraphsTranslatedInThisAreaScrollToContinue", result.translated) : t("noTextToTranslateInThisAreaScroll")
    : result.translated ? t("paragraphsTranslatedCacheHits", result.translated, result.cached ?? 0) : t("noTranslatableTextInThisAreaNewContent");
  setStatus(
    failed > 0 ? t("paragraphsTranslatedFailed", result.translated ?? 0, failed, result.error ?? "")
      : result.error ? t("translationIncomplete", result.error)
        : result.pending ? t("translatingThisAreaNewContentWillBeTranslated") : success,
    Boolean(result.pending)
  );
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
  const revision = paragraphModeRevision;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    const result = await sendTabMessage<{ enabled: boolean }>(tab.id, {
      type: "GET_PARAGRAPH_MODE"
    });
    if (revision === paragraphModeRevision) paragraphMode = result.enabled;
    paragraphModeButton.removeAttribute("title");
    updateParagraphModeButton();
  } catch (error) {
    // A missing/old content script is a connection state, not a capability
    // verdict. Keep the button enabled so a later attempt can reconnect.
    paragraphModeError = error instanceof Error ? error.message : String(error);
    paragraphModeButton.title = paragraphModeError;
    setStatus(paragraphModeError);
  }
}

interface PageStatus {
  translated: boolean;
  progress?: DocumentTranslationState;
}

async function loadTranslationState(): Promise<void> {
  const version = pageActionVersion;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    const result = await sendTabMessage<PageStatus>(tab.id, {
      type: "GET_TRANSLATION_STATE", includeProgress: true
    });
    if (version !== pageActionVersion) return;
    pageTranslated = result.translated;
    updatePageToggleButton();
    if (result.progress?.active && !status.textContent) showPageTranslationStatus(result.progress);
  } catch {
    if (version !== pageActionVersion) return;
    pageTranslated = false;
    updatePageToggleButton();
  }
}

async function toggleAutoTranslation(): Promise<void> {
  if (autoTranslationNotice && status.textContent === autoTranslationNotice) setStatus("");
  autoTranslationNotice = undefined;
  const enabled = autoTranslationButton.getAttribute("aria-pressed") !== "true";
  setButtonBusy(autoTranslationButton, true);
  updateAutoTranslationSiteButton();
  try {
    await updatePopupSettings(latest => ({ autoTranslation: setAutoTranslationEnabled(normalizeAutoTranslation(latest.autoTranslation), enabled) }));
    updateAutoTranslationButton();
    const rules = settings.autoTranslation!;
    if (enabled && !rules.nonTargetLanguage && !rules.presetSites.length && !rules.customSites.some(site => site.enabled)) {
      autoTranslationNotice = t("automaticTranslationIsOnEnableASiteOr");
      setStatus(autoTranslationNotice);
    }
  } catch (error) {
    updateAutoTranslationButton();
    autoTranslationNotice = error instanceof Error ? error.message : String(error);
    setStatus(autoTranslationNotice);
  } finally {
    setButtonBusy(autoTranslationButton, false);
    updateAutoTranslationSiteButton();
  }
}

function updateAutoTranslationButton(): void {
  const rules = normalizeAutoTranslation(settings.autoTranslation);
  if (autoTranslationButton.getAttribute("aria-pressed") !== String(rules.enabled)) autoTranslationButton.setAttribute("aria-pressed", String(rules.enabled));
  const title = rules.nonTargetLanguage ? t("translatePagesInOtherLanguagesAutomaticallyLimitSites") : t("translateAutomaticallyUsingConfiguredSiteRules");
  if (autoTranslationButton.title !== title) autoTranslationButton.title = title;
  if (autoTranslationButton.hasAttribute("data-loading")) {
    void autoTranslationButton.offsetWidth;
    autoTranslationButton.removeAttribute("data-loading");
    autoTranslationButton.disabled = false;
  }
  updateAutoTranslationSiteButton();
}

function updateAutoTranslationSiteButton(): void {
  const enabled = normalizeAutoTranslation(settings.autoTranslation).enabled;
  const pattern = currentWebsitePattern(activePageURL);
  const added = hasAutoTranslationWebsite(settings.autoTranslation, activePageURL);
  if (addAutoTranslationSiteButton.hidden !== !enabled) addAutoTranslationSiteButton.hidden = !enabled;
  const disabled = !pattern || autoTranslationButton.getAttribute("aria-busy") === "true"
    || addAutoTranslationSiteButton.getAttribute("aria-busy") === "true";
  if (addAutoTranslationSiteButton.disabled !== disabled) addAutoTranslationSiteButton.disabled = disabled;
  const icon = added ? "tick" : "plus";
  if (addAutoTranslationSiteButton.querySelector("svg")?.dataset.icon !== icon) addAutoTranslationSiteButton.innerHTML = uiIconMarkup(icon);
  if (addAutoTranslationSiteButton.getAttribute("aria-pressed") !== String(added)) addAutoTranslationSiteButton.setAttribute("aria-pressed", String(added));
  const label = !pattern ? t("switchToAWebPageToAddA") : added ? t("excludeFromAutomaticTranslation", pattern) : t("addToAutomaticTranslation", pattern);
  if (addAutoTranslationSiteButton.title !== label) addAutoTranslationSiteButton.title = label;
  if (addAutoTranslationSiteButton.getAttribute("aria-label") !== label) addAutoTranslationSiteButton.setAttribute("aria-label", label);
}

async function toggleCurrentAutoTranslationSite(): Promise<void> {
  if (addAutoTranslationSiteButton.disabled) return;
  const include = addAutoTranslationSiteButton.getAttribute("aria-pressed") !== "true";
  if (autoTranslationNotice && status.textContent === autoTranslationNotice) setStatus("");
  autoTranslationNotice = undefined;
  setButtonBusy(addAutoTranslationSiteButton, true);
  setButtonBusy(autoTranslationButton, true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activePageURL = tab?.url;
    await updatePopupSettings(latest => ({ autoTranslation: include ? addAutoTranslationWebsite(latest.autoTranslation, activePageURL) : excludeAutoTranslationWebsite(latest.autoTranslation, activePageURL) }));
    autoTranslationNotice = include ? t("addedToAutomaticTranslation", currentWebsitePattern(activePageURL)) : t("excludedFromAutomaticTranslation", currentWebsitePattern(activePageURL));
  } catch (error) {
    autoTranslationNotice = error instanceof Error ? error.message : String(error);
  } finally {
    setButtonBusy(autoTranslationButton, false);
    setButtonBusy(addAutoTranslationSiteButton, false);
    updateAutoTranslationButton();
    if (autoTranslationNotice) setStatus(autoTranslationNotice);
  }
}

async function toggleSelectionTranslation(): Promise<void> {
  const enabled = selectionTranslationButton.getAttribute("aria-pressed") !== "true";
  setButtonBusy(selectionTranslationButton, true);
  try {
    await updatePopupSettings(latest => ({ selectionTranslation: { ...normalizeSelectionTranslation(latest.selectionTranslation), enabled } }));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    updateSelectionTranslationButton();
    setButtonBusy(selectionTranslationButton, false);
  }
}

function updateSelectionTranslationButton(): void {
  const value = String(normalizeSelectionTranslation(settings.selectionTranslation).enabled);
  if (selectionTranslationButton.getAttribute("aria-pressed") !== value) selectionTranslationButton.setAttribute("aria-pressed", value);
}

async function toggleParagraphMode(): Promise<void> {
  const revision = paragraphModeRevision;
  const enabled = !paragraphMode;
  setButtonBusy(paragraphModeButton, true);
  if (paragraphModeError && status.textContent === paragraphModeError) setStatus("");
  paragraphModeError = undefined;
  try {
    if (!paragraphModeAvailable) throw new Error(t("paragraphModeIsUnavailableOnThisPage"));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error(t("noActiveTab"));
    if (touchControls || lastPointerTouch) {
      await sendTabMessage(tab.id, { type: "START_TOUCH_PARAGRAPH" });
      window.close();
      return;
    }
    const result = await sendTabMessage<{ enabled: boolean }>(tab.id, { type: "SET_PARAGRAPH_MODE", enabled });
    if (revision === paragraphModeRevision) paragraphMode = result.enabled;
    paragraphModeButton.removeAttribute("title");
  } catch (error) {
    paragraphModeError = error instanceof Error ? error.message : String(error);
    setStatus(paragraphModeError);
  } finally {
    updateParagraphModeButton();
    setButtonBusy(paragraphModeButton, false);
  }
}

async function toggleContextMenuTranslation(): Promise<void> {
  const previous = settings.contextMenuTranslationEnabled === true;
  setButtonBusy(contextMenuTranslationButton, true);
  try {
    await updatePopupSettings({ contextMenuTranslationEnabled: !previous });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    updateContextMenuTranslationButton();
    setButtonBusy(contextMenuTranslationButton, false);
  }
}

function updateContextMenuTranslationButton(): void {
  const value = String(settings.contextMenuTranslationEnabled === true);
  if (contextMenuTranslationButton.getAttribute("aria-pressed") !== value) contextMenuTranslationButton.setAttribute("aria-pressed", value);
}

async function toggleFloatingBall(): Promise<void> {
  setButtonBusy(floatingBallButton, true);
  setStatus(t("updatingFloatingButton"));
  const previous = floatingBallEnabled;
  let saved = false;
  try {
    floatingBallEnabled = !floatingBallEnabled;
    await updatePopupSettings({ floatingBallEnabled });
    saved = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (pageTranslationAvailable && !activeTabIsPdf && tab.id) {
      await sendTabMessage<{ enabled: boolean }>(tab.id, {
        type: "SET_FLOATING_BALL",
        enabled: floatingBallEnabled
      }).catch(() => undefined);
    }
    updateFloatingBallButton();
    setStatus(floatingBallEnabled ? t("floatingButtonEnabled") : t("floatingButtonDisabled"));
  } catch (error) {
    if (!saved) {
      floatingBallEnabled = previous;
    }
    updateFloatingBallButton();
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonBusy(floatingBallButton, false);
  }
}

async function openDebugPanel(): Promise<void> {
  if (!pageTranslationAvailable || activeTabIsPdf) {
    setStatus(t("switchToARegularWebPageToUse"));
    return;
  }
  setButtonBusy(debugButton, true);
  setStatus(t("openingDebug"));
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) throw new Error(t("noActiveTab"));
    await sendTabMessage<{ opened: boolean }>(tab.id, {
      type: "OPEN_TRANSLATION_DEBUG"
    });
    setStatus(t("debugOpened"));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonBusy(debugButton, false);
  }
}

async function clearCache(): Promise<void> {
  setButtonBusy(clearCacheButton, true);
  setStatus(t("clearingCache"));
  try {
    const result = await sendRuntimeMessage<{ removed: number }>({
      type: "CLEAR_CACHE"
    });
    setStatus(t("cacheEntriesCleared", result.removed));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonBusy(clearCacheButton, false);
  }
}

function refreshMenuLayout(): void {
  applyPopupMenuLayout(document, normalizeAppearance(settings.appearance).popupMenu);
  const popup = document.querySelector<HTMLElement>(".popup")!;
  popup.dataset.touch = String(touchControls);
  const primary = query<HTMLElement>(".touch-primary");
  primary.hidden = !touchControls;
  if (touchControls) primary.append(pageToggleButton);
  const common = new Set(["pageToggle", "paragraphMode", "selectionTranslation", "imageTranslation"]);
  for (const element of document.querySelectorAll<HTMLElement>("[data-popup-menu-item]")) {
    element.toggleAttribute("data-touch-extra", !common.has(element.dataset.popupMenuItem!));
  }
  const footer = document.querySelector<HTMLElement>("[data-popup-menu-footer]");
  footer?.setAttribute("data-touch-extra", "");
  if (moreFeaturesButton.hidden !== !touchControls) moreFeaturesButton.hidden = !touchControls;
  popup.removeAttribute("data-menu-loading");
}

function updateVideoTranslationButton(): void {
  const value = String(normalizeVideoTranslation(settings.videoTranslation).enabled);
  if (videoTranslationButton.getAttribute("aria-pressed") !== value) videoTranslationButton.setAttribute("aria-pressed", value);
  videoTranslationButton.removeAttribute("data-loading");
}

async function toggleVideoTranslation(): Promise<void> {
  const enabled = !normalizeVideoTranslation(settings.videoTranslation).enabled;
  setButtonBusy(videoTranslationButton, true);
  try {
    await updatePopupSettings(latest => ({ videoTranslation: { ...normalizeVideoTranslation(latest.videoTranslation), enabled } }));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    updateVideoTranslationButton();
    setButtonBusy(videoTranslationButton, false);
  }
}

function updateParagraphModeButton(): void {
  const hint = paragraphClickHint(settings.localShortcuts, settings.shortcutEnabled?.["paragraph-click"] !== false);
  if (paragraphModeHint.textContent !== hint) paragraphModeHint.textContent = hint;
  const label = paragraphModeButton.querySelector("span")!;
  const text = touchControls ? t("tapAParagraph") : t("paragraphTranslation");
  if (label.textContent !== text) label.textContent = text;
  const touchHint = t("tapAParagraphToTranslateItAndExit");
  if (touchControls && paragraphModeButton.title !== touchHint) paragraphModeButton.title = touchHint;
  else if (!touchControls && paragraphModeButton.title === touchHint) paragraphModeButton.removeAttribute("title");
  const value = String(!touchControls && paragraphMode);
  if (paragraphModeButton.getAttribute("aria-pressed") !== value) paragraphModeButton.setAttribute("aria-pressed", value);
  const hideHint = touchControls || !paragraphMode || paragraphModeButton.hidden || paragraphModeButton.hasAttribute("data-popup-menu-hidden");
  if (paragraphModeHint.hidden !== hideHint) paragraphModeHint.hidden = hideHint;
}

function updatePageToggleButton(): void {
  const label = activeTabIsPdf
    ? t("translatePdf")
    : pageTranslated ? t("showOriginalPage") : t("translatePage");
  if (pageToggleButton.textContent !== label) pageToggleButton.textContent = label;
}

function updateFloatingBallButton(): void {
  if (floatingBallButton.getAttribute("aria-pressed") !== String(floatingBallEnabled)) floatingBallButton.setAttribute("aria-pressed", String(floatingBallEnabled));
}

function updatePageActionAvailability(): void {
  pageToggleButton.disabled = !pageTranslationAvailable;
  paragraphModeButton.disabled = !paragraphModeAvailable;
  debugButton.disabled = !pageTranslationAvailable || activeTabIsPdf;
}
