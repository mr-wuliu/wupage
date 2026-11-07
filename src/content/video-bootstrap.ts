import { queryVideoRoots } from "../video/platforms";
import { hasExtensionContext } from "../shared/extension-context";

/** First discovery poll delay: long enough to skip most of the initial paint. */
const FIRST_POLL_MS = 500;
/** Poll backoff ceiling; a page without a player still needs a slow heartbeat. */
const MAX_POLL_MS = 15000;

// Video controls remain independent of whole-page/paragraph translation. A
// video-only module keeps text-only iframes on the lightweight bootstrap.
export function initEmbeddedVideoSubtitles(): void {
  let loading: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let pollDelay = FIRST_POLL_MS;
  let stopped = false;
  const observer = new MutationObserver(() => schedule());

  function stopWatching(): void {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(poll);
    poll = undefined;
    document.removeEventListener("loadedmetadata", schedule, true);
    document.removeEventListener("playing", schedule, true);
  }

  function discover(): void {
    if (stopped || loading) return;
    if (!hasExtensionContext()) { stopWatching(); return; }
    observer.disconnect();
    if (!queryVideoRoots(document, root => observer.observe(root, { childList: true, subtree: true })).length) return;
    // getURL can throw synchronously if the extension is reloaded. Keep it in
    // the promise chain along with module loading and listener registration.
    loading = Promise.resolve().then(() => import(/* @vite-ignore */ chrome.runtime.getURL("video-content.js"))).then(async module => {
      if (!hasExtensionContext()) { stopWatching(); return; }
      await module.initEmbeddedVideoSubtitles();
      chrome.runtime.onMessage.addListener((request, _sender, respond) => {
        if (request.type !== "OPEN_VIDEO_SUBTITLES") return;
        void module.openVideoSubtitles().then((data: { opened: boolean }) => respond({ ok: true, data }),
          (error: unknown) => respond({ ok: false, error: String(error) }));
        return true;
      });
      stopWatching();
    }).catch(() => { loading = undefined; if (!hasExtensionContext()) stopWatching(); else schedulePoll(); });
  }

  function schedule(): void {
    if (stopped || loading || timer) return;
    timer = setTimeout(() => { timer = undefined; discover(); }, 160);
  }

  // Attaching a shadow root to an existing host does not mutate the light DOM,
  // so discovery needs a timer. Poll every 500ms at first and stretch the delay
  // towards 15s: a page that never plays a video would otherwise keep querying
  // the whole document once a second for the lifetime of the tab.
  function schedulePoll(): void {
    if (stopped || loading || poll) return;
    poll = setTimeout(() => {
      poll = undefined;
      if (stopped || loading) return;
      if (!hasExtensionContext()) { stopWatching(); return; }
      // A hidden tab cannot present a player; keep the chain, skip the scan.
      if (document.visibilityState !== "hidden") discover();
      pollDelay = Math.min(MAX_POLL_MS, Math.round(pollDelay * 1.5));
      schedulePoll();
    }, pollDelay);
  }

  document.addEventListener("loadedmetadata", schedule, true);
  document.addEventListener("playing", schedule, true);
  window.addEventListener("pagehide", event => {
    stopWatching();
    if (event.persisted && !loading) window.addEventListener("pageshow", () => initEmbeddedVideoSubtitles(), { once: true });
  }, { once: true });
  discover();
  schedulePoll();
}
