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
import { clearPageTranslation, startPageTranslation } from "./page-translation";
import { injectContentStyles } from "./styles";

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

async function handleMessage(request: RuntimeRequest): Promise<unknown> {
  if (request.type === "CLEAR_TRANSLATION") {
    clearPageTranslation();
    return { cleared: true };
  }

  if (request.type === "GET_TRANSLATION_STATE") {
    return { translated: hasPageTranslations() };
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
