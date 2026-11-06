import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../shared/types";
import { hasPageTranslations, refreshTranslationColors } from "./dom";
import {
  getFloatingBallEnabled,
  initFloatingBall,
  openDebugPanel,
  setFloatingBallEnabled,
  setParagraphMode
} from "./floating";
import { addRuntimeMessageListener, sendRuntimeRequest } from "./runtime";
import {
  getPageTranslationState,
  hidePageTranslation,
  loadPageTranslationSettings,
  startPageTranslation,
  updatePageTranslationSettings
} from "./page-translation";
import { injectContentStyles } from "./styles";
import { initImageTranslation, translateContextImage } from "./image-translation";
import { SETTINGS_KEY } from "../shared/defaults";
import { initAutoTranslation } from "./auto-translation";
import { initSelectionTranslation } from "./selection-translation";
import { setupAppearance } from "../shared/appearance-runtime";
import { executeTranslationShortcut } from "./shortcuts";
import { initKeyboardShortcuts } from "./keyboard-shortcuts";
import { installFrameRuntime } from "./frame-runtime";
import { createDocumentKey } from "../shared/frame-session";
import { initVideoSubtitles, openVideoSubtitles } from "./video-subtitles";
import { readParagraphMode } from "../shared/paragraph-mode";
import { supportsHtmlContent } from "../shared/html";
import { startTouchParagraph } from "./touch-paragraph";

let pageActionVersion = 0;
const supported = supportsHtmlContent();

addRuntimeMessageListener((request: RuntimeRequest, _sender, sendResponse) => {
  if (request.type.startsWith("FRAME_")) return;
  if (!supported) {
    sendResponse({ ok: false, error: "此页面不支持翻译，请切换到普通网页。" });
    return;
  }
  handleMessage(request)
    .then((data): RuntimeResponse => ({ ok: true, data }))
    .catch((error: unknown): RuntimeResponse => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .then(sendResponse);

  return true;
});

if (supported) initializeContent();

function initializeContent(): void {
  initializeFeature("styles", injectContentStyles);
  if (chrome.runtime?.id && typeof chrome.runtime.onMessage?.addListener === "function") {
    initializeFeature("frames", () => installFrameRuntime(createDocumentKey(), { top: true }));
  }
  let appearance: ReturnType<typeof setupAppearance> | undefined;
  initializeFeature("appearance", () => {
    appearance = setupAppearance(undefined, { extensionPage: false, onChange: scheme => {
      refreshTranslationColors({ light: scheme.colors["translation-light"], dark: scheme.colors["translation-dark"] });
    } });
  });
  // Ignore an older initial read if the user saves a newer appearance while it is pending.
  let appearanceRevision = 0;
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => {
    if (!appearanceRevision) { appearance?.update(settings.appearance); updatePageTranslationSettings(settings); }
  }).catch(() => undefined);
  initializeFeature("floating controls", initFloatingBall);
  initializeFeature("image translation", initImageTranslation);
  initializeFeature("automatic translation", initAutoTranslation);
  initializeFeature("selection translation", initSelectionTranslation);
  initializeFeature("shortcuts", () => initKeyboardShortcuts(executeTranslationShortcut));
  initializeFeature("video subtitles", initVideoSubtitles);

  // One listener for the saved settings: the appearance revision and the page
  // translation settings must observe the same change, in the same order.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    appearanceRevision++;
    const settings = change.newValue as ExtensionSettings | undefined;
    if (settings) updatePageTranslationSettings(settings);
  });
}

function initializeFeature(name: string, initialize: () => unknown): void {
  try { initialize(); }
  catch (error) { console.warn(`WuPage ${name} initialization:`, error); }
}

async function handleMessage(request: RuntimeRequest): Promise<unknown> {
  if (request.type === "START_TOUCH_PARAGRAPH") {
    startTouchParagraph();
    return { started: true };
  }
  if (request.type === "OPEN_VIDEO_SUBTITLES") {
    return openVideoSubtitles();
  }
  if (request.type === "EXECUTE_TRANSLATION_SHORTCUT") {
    await executeTranslationShortcut(request.command);
    return { handled: true };
  }
  if (request.type === "TRANSLATE_CONTEXT_IMAGE") {
    return translateContextImage(request.srcUrl);
  }
  if (request.type === "CLEAR_TRANSLATION") {
    pageActionVersion += 1;
    hidePageTranslation();
    return { cleared: true };
  }

  if (request.type === "GET_TRANSLATION_STATE") {
    return { translated: getPageTranslationState().active || hasPageTranslations() };
  }

  if (request.type === "GET_PARAGRAPH_MODE") {
    return { enabled: await readParagraphMode() };
  }

  if (request.type === "SET_PARAGRAPH_MODE") {
    await setParagraphMode(request.enabled);
    return { enabled: await readParagraphMode() };
  }

  if (request.type === "GET_FLOATING_BALL") {
    return { enabled: getFloatingBallEnabled() };
  }

  if (request.type === "SET_FLOATING_BALL") {
    await setFloatingBallEnabled(request.enabled);
    return { enabled: getFloatingBallEnabled() };
  }

  if (request.type === "OPEN_TRANSLATION_DEBUG") {
    await openDebugPanel();
    return { opened: true };
  }

  if (request.type !== "TRANSLATE_PAGE") {
    return null;
  }

  const actionVersion = ++pageActionVersion;
  const settings = await loadPageTranslationSettings();
  if (actionVersion !== pageActionVersion) return getPageTranslationState();
  return startPageTranslation(settings);
}
