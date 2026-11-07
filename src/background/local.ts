import { t } from "../shared/i18n";
import { getLocalRoute, normalizeLocalLanguage } from "../local/models";
import type { RuntimeResponse, TranslateBatchRequest } from "../shared/types";
import { ensureOffscreenDocument } from "./offscreen";
import { detectSourceLanguage } from "./source-language";
import { ensureLocalModelDownloadCompatibility } from "./local-model-compatibility";

export async function requestLocal<T>(action: string, data?: unknown): Promise<T> {
  if (action === "status" || action === "install") {
    try { await ensureLocalModelDownloadCompatibility(); }
    catch (error) {
      // Keep status and offline imports available if the browser rejects rules.
      if (action === "install") throw error;
    }
  }
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "bergamot-offscreen", action, data }) as RuntimeResponse;
  if (!response?.ok) throw new Error(response?.error ?? t("localTranslationCouldNotStartReloadTheExtension"));
  return response.data as T;
}

export async function translateLocally(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (!request.texts.length) return [];
  let source = request.sourceLang ?? "auto";
  if (source === "auto") {
    const detected = await detectSourceLanguage(request.texts, signal);
    if (!detected) {
      throw new Error(t("couldNotReliablyDetectTheSourceLanguageSelect"));
    }
    source = detected;
  }
  const route = getLocalRoute(source, request.targetLang);
  if (!route.length) return [...request.texts];
  signal?.throwIfAborted();
  return requestLocal<string[]>("translate", { ...request, sourceLang: normalizeLocalLanguage(source) });
}
