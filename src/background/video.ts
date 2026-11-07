import { t } from "../shared/i18n";
import { anySignal } from "../shared/abort";
import type { RuntimeRequest } from "../shared/types";
import { getSettings } from "../shared/settings";
import { translateWithSettings } from "./translation";
import { normalizeVideoTranslation, videoPriority } from "../shared/video";
import { SETTINGS_KEY } from "../shared/defaults";
import type { ExtensionSettings } from "../shared/types";
import { statisticsPageKey } from "./statistics";

const frames = new Map<string, { tab: number; frame: number; area: number; playing: boolean; seen: number }>();
const requests = new Map<string, AbortController>();
export function initVideoSettings(): void {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !settings || normalizeVideoTranslation(settings.videoTranslation).enabled) return;
    for (const controller of requests.values()) controller.abort(new DOMException(t("videoSubtitlesAreOff"), "AbortError"));
    frames.clear();
  });
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/u.test(value);
function owner(sender: chrome.runtime.MessageSender): string {
  if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId)) throw new Error(t("subtitleRequestsMustComeFromAVideoPage"));
  return `${sender.tab!.id}:${sender.frameId}`;
}

export function registerVideoFrame(request: Extract<RuntimeRequest, { type: "VIDEO_FRAME_STATUS" }>, sender: chrome.runtime.MessageSender): void {
  const key = owner(sender);
  for (const [id, frame] of frames) if (Date.now() - frame.seen >= 15_000) frames.delete(id);
  if (!request.videos) { frames.delete(key); return; }
  if (!Number.isInteger(request.videos) || request.videos < 0 || !Number.isFinite(request.area) || request.area < 0 || request.area > 1e8 || request.videos > 100) return;
  frames.set(key, { tab: sender.tab!.id!, frame: sender.frameId!, area: request.area, playing: request.playing === true, seen: Date.now() });
}

export async function openVideoInTab(tabId: number | undefined): Promise<unknown> {
  if (!Number.isInteger(tabId)) throw new Error(t("noActiveVideoPage"));
  if (!normalizeVideoTranslation((await getSettings()).videoTranslation).enabled) throw new Error(t("videoSubtitlesAreOffEnableThemInThe"));
  const candidates = [...frames.values()].filter(frame => frame.tab === tabId && Date.now() - frame.seen < 15_000)
    .sort((a, b) => videoPriority(b.area, b.playing) - videoPriority(a.area, a.playing));
  const ids = [...new Set([...candidates.map(frame => frame.frame), 0])];
  for (const frameId of ids) {
    try {
      const response = await chrome.tabs.sendMessage(tabId!, { type: "OPEN_VIDEO_SUBTITLES" }, { frameId });
      if (response?.ok && response.data?.opened) return response.data;
    } catch { /* An embedded frame may have navigated since discovery. */ }
  }
  throw new Error(t("noPlayableVideoFoundOpenAVideoAnd"));
}

export async function translateVideo(request: Extract<RuntimeRequest, { type: "TRANSLATE_VIDEO_SUBTITLES" }>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const prefix = owner(sender);
  if (!validId(request.sessionId) || !validId(request.requestId) || !Array.isArray(request.texts) || !request.texts.length || request.texts.length > 8
    || request.texts.some(text => typeof text !== "string" || !text.trim() || text.length > 4000)
    || request.texts.reduce((size, text) => size + text.length, 0) > 8000
    || typeof request.targetLang !== "string" || request.targetLang.length > 32) throw new Error(t("invalidSubtitleRequest"));
  const key = `${prefix}:${request.sessionId}:${request.requestId}`;
  if (requests.has(key)) throw new Error(t("aSubtitleRequestIsAlreadyInProgress"));
  if ([...requests.keys()].filter(id => id.startsWith(`${prefix}:`)).length >= 4) throw new Error(t("waitForThePreviousSubtitleTranslationToFinish"));
  const controller = new AbortController(); requests.set(key, controller);
  try {
    const settings = await getSettings();
    if (!normalizeVideoTranslation(settings.videoTranslation).enabled) throw new Error(t("videoSubtitlesAreOff"));
    const signal = anySignal([controller.signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    return await translateWithSettings(settings, { texts: request.texts, sourceLang: request.sourceLang, targetLang: request.targetLang, providerId: request.providerId },
      { signal, priority: true, persistentCache: false, statisticsPageKey: statisticsPageKey(sender) });
  } finally { requests.delete(key); }
}

export function cancelVideo(request: Extract<RuntimeRequest, { type: "CANCEL_VIDEO_SUBTITLES" }>, sender: chrome.runtime.MessageSender): void {
  if (!validId(request.sessionId) || (request.requestId !== undefined && !validId(request.requestId))) return;
  const prefix = `${owner(sender)}:${request.sessionId}:`;
  for (const [key, controller] of requests) if (key.startsWith(prefix) && (!request.requestId || key === `${prefix}${request.requestId}`)) {
    controller.abort(new DOMException(t("subtitleTaskCanceled"), "AbortError"));
  }
}

export function clearVideoTab(tabId: number): void {
  for (const [key, frame] of frames) if (frame.tab === tabId) frames.delete(key);
  for (const [key, controller] of requests) if (key.startsWith(`${tabId}:`)) controller.abort(new DOMException(t("theVideoPageHasClosed"), "AbortError"));
}
