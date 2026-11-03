import { ProviderError, restoreRuntimeError } from "./errors";
import type { RuntimeResponse, TranslateBatchRequest, TranslateBatchResponse } from "./types";

export const PDF_TRANSLATION_PORT = "wupage-pdf-translation";
export const PDF_TRANSLATION_TIMEOUT_MS = 120_000;
export const PDF_TRANSLATION_HEARTBEAT_MS = 20_000;
export type PdfTranslationMessage =
  | { type: "translate"; request: TranslateBatchRequest; pageNumber: number }
  | { type: "heartbeat" }
  | { type: "result"; response: RuntimeResponse };

export function pdfTranslationTimeout(pageNumber: number): ProviderError {
  return new ProviderError(`第 ${pageNumber} 页翻译超过 120 秒，已取消该页请求，可点击翻译按钮重试。`, "timeout");
}

/** Disconnecting owns the entire page task, including queued work and retries. */
export function requestPdfTranslation(
  request: TranslateBatchRequest, pageNumber: number, signal: AbortSignal
): Promise<TranslateBatchResponse> {
  signal.throwIfAborted();
  const port = chrome.runtime.connect({ name: PDF_TRANSLATION_PORT });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: TranslateBatchResponse, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const onAbort = () => finish(undefined, signal.reason);
    const onDisconnect = () => {
      // Reading lastError also acknowledges Chrome's disconnected-port error.
      const detail = chrome.runtime.lastError?.message;
      finish(undefined, new Error(`翻译连接已中断，请点击翻译按钮重试。${detail ? ` ${detail}` : ""}`));
    };
    const onMessage = (message: PdfTranslationMessage) => {
      if (message.type !== "result") return;
      if (message.response.ok) finish(message.response.data as TranslateBatchResponse);
      else finish(undefined, restoreRuntimeError(message.response));
    };
    const timer = setTimeout(() => finish(undefined, pdfTranslationTimeout(pageNumber)), PDF_TRANSLATION_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try { port.postMessage({ type: "translate", request, pageNumber } satisfies PdfTranslationMessage); }
    catch { onDisconnect(); }
  });
}
