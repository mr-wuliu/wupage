import type { OcrRecognition, OcrStatus } from "../shared/ocr";
import type { RuntimeResponse } from "../shared/types";

let opening: Promise<void> | undefined;

async function ensureDocument(): Promise<void> {
  if (opening) return opening;
  opening = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "ocr-offscreen.html", reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
      justification: "Manage optional local OCR models and recognize images in an isolated frame."
    });
  })();
  try { await opening; } finally { opening = undefined; }
}

export async function requestOcr<T = OcrStatus>(action: "status" | "install" | "remove" | "recognize", dataUrl?: string): Promise<T> {
  await ensureDocument();
  const response = await chrome.runtime.sendMessage({ target: "ocr-offscreen", action, dataUrl }) as RuntimeResponse;
  if (!response?.ok) throw new Error(response?.error ?? "OCR 未能启动，请重新加载扩展。");
  return response.data as T;
}

export const recognizeImage = (dataUrl: string) => requestOcr<OcrRecognition>("recognize", dataUrl);
