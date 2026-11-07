import { t } from "../shared/i18n";
import type { OcrRecognition, OcrStatus } from "../shared/ocr";
import type { RuntimeResponse } from "../shared/types";
import { ensureOffscreenDocument } from "./offscreen";

export async function requestOcr<T = OcrStatus>(action: "status" | "install" | "remove" | "recognize", dataUrl?: string): Promise<T> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "ocr-offscreen", action, dataUrl }) as RuntimeResponse;
  if (!response?.ok) throw new Error(response?.error ?? t("ocrCouldNotStartReloadTheExtension"));
  return response.data as T;
}

export const recognizeImage = (dataUrl: string) => requestOcr<OcrRecognition>("recognize", dataUrl);
