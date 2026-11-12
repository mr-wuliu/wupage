import { t } from "../shared/i18n";
import type { OcrRecognition, OcrStatus } from "../shared/ocr";
import type { RuntimeResponse } from "../shared/types";
import { ensureOffscreenDocument } from "./offscreen";
import { normalizeOcrSettings } from "../shared/ocr-service";
import type { ExtensionSettings } from "../shared/types";
import { ocrRevision, recognizeOcrService } from "./ocr-service";

export async function requestOcr<T = OcrStatus>(action: "status" | "install" | "remove" | "recognize", dataUrl?: string): Promise<T> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "ocr-offscreen", action, dataUrl }) as RuntimeResponse;
  if (!response?.ok) throw new Error(response?.error ?? t("ocrCouldNotStartReloadTheExtension"));
  return response.data as T;
}

export function recognizeImage(dataUrl: string, settings: ExtensionSettings, width: number, height: number): Promise<OcrRecognition> {
  const config = normalizeOcrSettings(settings.ocr);
  return config.mode === "http" ? recognizeOcrService(config, { dataUrl, width, height }) : requestOcr<OcrRecognition>("recognize", dataUrl);
}

export async function getOcrStatus(settings: ExtensionSettings): Promise<OcrStatus> {
  if (normalizeOcrSettings(settings.ocr).mode !== "http") return requestOcr("status");
  try {
    const revision = await ocrRevision(settings);
    return { backend: "http", state: "installed", total: 0, downloaded: 0, revision };
  } catch (error) {
    return { backend: "http", state: "error", total: 0, downloaded: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
