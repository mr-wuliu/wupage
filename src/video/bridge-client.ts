import { resolveBridgeMessage, t } from "../shared/i18n";
import { parseCatalogue, validSubtitleCues, VIDEO_BRIDGE_CHANNEL, type PageSubtitleCatalogue } from "./site-cues";
import type { SubtitleCue } from "./subtitles";

let sequence = 0;
async function request(action: "catalogue" | "load", track?: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const id = `wp-${Date.now().toString(36)}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); window.removeEventListener("message", receive); signal?.removeEventListener("abort", abort); };
    const abort = () => { clean(); reject(new DOMException(t("subtitleReadCanceled"), "AbortError")); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== VIDEO_BRIDGE_CHANNEL
        || event.data?.direction !== "response" || event.data?.id !== id) return;
      clean();
      if (event.data.error) reject(new Error(resolveBridgeMessage(String(event.data.error).slice(0, 300))));
      else resolve(event.data.data);
    };
    const timer = setTimeout(() => { clean(); reject(new Error(t("readingPlayerSubtitlesTimedOutEnableNativeSubtitles"))); }, action === "load" ? 10_000 : 4500);
    window.addEventListener("message", receive); signal?.addEventListener("abort", abort, { once: true });
    window.postMessage({ channel: VIDEO_BRIDGE_CHANNEL, direction: "request", id, action, track }, location.origin);
  });
}

export async function pageSubtitleCatalogue(signal?: AbortSignal): Promise<PageSubtitleCatalogue | undefined> {
  return parseCatalogue(await request("catalogue", undefined, signal));
}

export async function loadPageSubtitles(track: string, signal?: AbortSignal): Promise<{ key: string; cues: SubtitleCue[] }> {
  const result = await request("load", track, signal) as { key?: unknown; cues?: unknown };
  if (typeof result?.key !== "string") throw new Error(t("invalidPlayerSubtitleData"));
  return { key: result.key, cues: validSubtitleCues(result.cues) };
}
