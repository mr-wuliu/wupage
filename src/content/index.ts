import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../shared/types";
import { hasPageTranslations } from "./dom";
import {
  getFloatingBallEnabled,
  getParagraphMode,
  initFloatingBall,
  openDebugPanel,
  setFloatingBallEnabled,
  setParagraphMode
} from "./floating";
import { addRuntimeMessageListener, sendRuntimeRequest } from "./runtime";
import { getPageTranslationState, hidePageTranslation, setPageTranslationDisplayMode, startPageTranslation } from "./page-translation";
import { injectContentStyles } from "./styles";
import { initImageTranslation, translateContextImage } from "./image-translation";
import { SETTINGS_KEY } from "../shared/defaults";
import { initAutoTranslation } from "./auto-translation";
import { initSelectionTranslation } from "./selection-translation";

addRuntimeMessageListener((request: RuntimeRequest, _sender, sendResponse) => {
  handleMessage(request)
    .then((data): RuntimeResponse => ({ ok: true, data }))
    .catch((error: unknown): RuntimeResponse => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .then(sendResponse);

  return true;
});

injectContentStyles();
initFloatingBall();
initImageTranslation();
initAutoTranslation();
initSelectionTranslation();

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[SETTINGS_KEY];
  if (area !== "local" || !change) return;
  const { oldValue, newValue } = change;
  const mode = (newValue as Partial<ExtensionSettings> | undefined)?.translationDisplayMode;
  if ((oldValue as Partial<ExtensionSettings> | undefined)?.translationDisplayMode === mode) return;
  if (mode === "replace" || mode === "bilingual" || mode === "bilingual-accent") {
    setPageTranslationDisplayMode(mode);
  }
});

async function handleMessage(request: RuntimeRequest): Promise<unknown> {
  if (request.type === "TRANSLATE_CONTEXT_IMAGE") {
    return translateContextImage(request.srcUrl);
  }
  if (request.type === "CLEAR_TRANSLATION") {
    hidePageTranslation();
    return { cleared: true };
  }

  if (request.type === "GET_TRANSLATION_STATE") {
    return { translated: getPageTranslationState().active || hasPageTranslations() };
  }

  if (request.type === "GET_PARAGRAPH_MODE") {
    return { enabled: getParagraphMode() };
  }

  if (request.type === "SET_PARAGRAPH_MODE") {
    await setParagraphMode(request.enabled);
    return { enabled: getParagraphMode() };
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

  const settings = await sendRuntimeRequest<ExtensionSettings>({
    type: "GET_SETTINGS"
  } satisfies RuntimeRequest);
  return startPageTranslation(settings);
}
