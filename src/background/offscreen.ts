import { t } from "../shared/i18n";
let opening: Promise<void> | undefined;

if (import.meta.env.MODE === "firefox") {
  chrome.runtime.onMessage.addListener((request, sender) => {
    if (request?.target !== "inference-lifetime" || sender.id !== chrome.runtime.id
      || sender.tab) return;
    return Promise.resolve(null);
  });
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (opening) return opening;
  opening = (async () => {
    if (import.meta.env.MODE === "firefox") {
      // Firefox's event background page can host the same runtime document.
      // Keep it out of user tabs and wait for its module listeners to register.
      if (document.getElementById("wupage-local-runtime")) return;
      const frame = document.createElement("iframe");
      frame.id = "wupage-local-runtime";
      frame.hidden = true;
      frame.src = chrome.runtime.getURL("ocr-offscreen.html");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { frame.remove(); reject(new Error(t("localEngineInitializationTimedOutReloadTheExtension"))); }, 30_000);
        frame.onload = () => { clearTimeout(timer); resolve(); };
        frame.onerror = () => { clearTimeout(timer); frame.remove(); reject(new Error(t("couldNotLoadTheLocalEngineReloadThe"))); };
        document.body.append(frame);
      });
      return;
    }
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "ocr-offscreen.html",
      reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING, chrome.offscreen.Reason.WORKERS,
        chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Run local inference, parse dictionary entries and play dictionary pronunciations."
    });
  })();
  try { await opening; } finally { opening = undefined; }
}
