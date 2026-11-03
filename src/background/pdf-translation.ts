import { runtimeErrorResponse } from "../shared/errors";
import {
  PDF_TRANSLATION_PORT, PDF_TRANSLATION_TIMEOUT_MS, PDF_TRANSLATION_HEARTBEAT_MS,
  pdfTranslationTimeout, type PdfTranslationMessage
} from "../shared/pdf-translation";
import type { RuntimeResponse, TranslateBatchRequest, TranslateBatchResponse } from "../shared/types";

type Translate = (request: TranslateBatchRequest, sender: chrome.runtime.MessageSender, signal: AbortSignal) => Promise<TranslateBatchResponse>;

export function installPdfTranslation(translate: Translate): void {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PDF_TRANSLATION_PORT) return;
    const sender = port.sender;
    if (sender?.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("pdf.html")) {
      port.disconnect(); return;
    }
    const controller = new AbortController();
    let started = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearTimeout(timer); clearInterval(heartbeat);
      controller.signal.removeEventListener("abort", onAbort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    const send = (message: PdfTranslationMessage) => {
      try { port.postMessage(message); }
      catch { onDisconnect(); }
    };
    const complete = (response: RuntimeResponse) => {
      if (finished) return;
      finished = true;
      cleanup();
      send({ type: "result", response });
      // A failed group must not leave sibling groups or recovery requests alive.
      controller.abort();
    };
    const onAbort = () => complete(runtimeErrorResponse(controller.signal.reason));
    const onDisconnect = () => {
      finished = true;
      cleanup();
      controller.abort();
    };
    const onMessage = (message: PdfTranslationMessage) => {
      if (message.type !== "translate" || started || finished) return;
      started = true;
      timer = setTimeout(() => controller.abort(pdfTranslationTimeout(message.pageNumber)), PDF_TRANSLATION_TIMEOUT_MS);
      // Only an active, bounded translation keeps the worker awake. Opening a
      // port alone does not reset Chromium's service-worker idle timer.
      heartbeat = setInterval(() => send({ type: "heartbeat" }), PDF_TRANSLATION_HEARTBEAT_MS);
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return translate(message.request, sender, controller.signal);
      }).then(data => complete({ ok: true, data }), error => complete(runtimeErrorResponse(error)));
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  });
}
