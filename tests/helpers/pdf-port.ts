import type { PdfTranslationMessage } from "../../src/shared/pdf-translation";
import type { RuntimeRequest, RuntimeResponse } from "../../src/shared/types";

/** Workspace tests keep their response fixtures; transport lifetime is tested separately. */
export function pdfPortFixture(send: (request: RuntimeRequest) => Promise<RuntimeResponse>) {
  return () => {
    let closed = false;
    const listeners = new Set<(message: PdfTranslationMessage) => void>();
    return {
      onMessage: {
        addListener: (listener: (message: PdfTranslationMessage) => void) => { listeners.add(listener); },
        removeListener: (listener: (message: PdfTranslationMessage) => void) => { listeners.delete(listener); }
      },
      onDisconnect: { addListener() {}, removeListener() {} },
      disconnect: () => { closed = true; },
      postMessage(message: PdfTranslationMessage) {
        if (message.type !== "translate") return;
        void send({ type: "TRANSLATE_BATCH", ...message.request }).then(response => {
          if (!closed) for (const listener of listeners) listener({ type: "result", response });
        });
      }
    };
  };
}
