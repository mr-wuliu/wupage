import type {
  ExtensionSettings,
  RuntimeRequest,
  RuntimeResponse,
  TranslateBatchResponse
} from "../shared/types";
import {
  clearTranslations,
  clearTranslationPlaceholders,
  collectTextSegments,
  hasPageTranslations,
  renderTranslationPlaceholders,
  renderTranslations
} from "./dom";
import type { TextSegment } from "./dom";
import {
  getFloatingBallEnabled,
  getParagraphMode,
  initFloatingBall,
  openDebugPanel,
  setFloatingBallEnabled,
  setParagraphMode
} from "./floating";
import { addRuntimeMessageListener, sendRuntimeRequest } from "./runtime";
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
    clearTranslations();
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

  clearTranslations();
  const segments = collectTextSegments();
  if (!segments.length) return { translated: 0, cached: 0 };
  renderTranslationPlaceholders(segments);
  const settings = await sendRuntimeRequest<ExtensionSettings>({
    type: "GET_SETTINGS"
  } satisfies RuntimeRequest);

  const data = await translateAndRenderSegments(segments, settings);
  if (data.failed > 0) {
    return {
      translated: data.translated,
      cached: data.cached,
      failed: data.failed,
      error: data.firstError
    };
  }
  return { translated: data.translated, cached: data.cached };
}

async function translateAndRenderSegments(
  segments: TextSegment[],
  settings: ExtensionSettings
): Promise<{ translated: number; cached: number; failed: number; firstError?: string }> {
  let translated = 0;
  let cached = 0;
  let failed = 0;
  let firstError: string | undefined;
  const groups = groupSegments(segments, getContentChunkSize(settings));
  const concurrency = Math.min(Math.max(1, settings.concurrency), groups.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < groups.length) {
      const group = groups[cursor];
      cursor += 1;
      try {
        const data = await sendRuntimeRequest<TranslateBatchResponse>({
          type: "TRANSLATE_BATCH",
          texts: group.map((segment) => segment.text),
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
          providerId: settings.activeProviderId
        } satisfies RuntimeRequest);
        cached += data.cached;
        translated += group.length;
        renderTranslations(
          group.map((segment, index) => ({
            id: segment.id,
            text: data.translations[index]
          }))
        );
      } catch (error) {
        failed += group.length;
        firstError ??= error instanceof Error ? error.message : String(error);
        clearTranslationPlaceholders(group);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { translated, cached, failed, firstError };
}

function groupSegments(segments: TextSegment[], maxChars: number): TextSegment[][] {
  const groups: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let currentLength = 0;

  for (const segment of segments) {
    if (current.length && currentLength + segment.text.length > maxChars) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(segment);
    currentLength += segment.text.length;
  }

  if (current.length) groups.push(current);
  return groups;
}

function getContentChunkSize(settings: ExtensionSettings): number {
  if (settings.activeProviderId === "openai-compatible" || settings.activeProviderId === "zhipu-glm") {
    return Math.max(settings.chunkSize, 3200);
  }
  return Math.max(200, settings.chunkSize);
}
