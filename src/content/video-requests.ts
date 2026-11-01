import { sendRuntimeRequest } from "./runtime";
import type { ExtensionSettings, TranslateBatchResponse } from "../shared/types";
import { sameVideoLanguage } from "../shared/video";
import { randomId } from "../shared/random-id";

let nextRequest = 0;
export class VideoRequests {
  readonly id = randomId();
  constructor(private settings: ExtensionSettings, private language: string) {}

  async translate(texts: string[], signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    if (sameVideoLanguage(this.language, this.settings.targetLang)) return texts;
    const requestId = `r-${++nextRequest}`;
    const cancel = () => { void sendRuntimeRequest({ type: "CANCEL_VIDEO_SUBTITLES", sessionId: this.id, requestId }).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await sendRuntimeRequest<TranslateBatchResponse>({ type: "TRANSLATE_VIDEO_SUBTITLES", sessionId: this.id, requestId,
        texts, sourceLang: this.language, targetLang: this.settings.targetLang, providerId: this.settings.activeProviderId });
      signal?.throwIfAborted(); return result.translations;
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  cancel(): void { void sendRuntimeRequest({ type: "CANCEL_VIDEO_SUBTITLES", sessionId: this.id }).catch(() => undefined); }
}
