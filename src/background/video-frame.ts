import { t } from "../shared/i18n";
import type { VideoFrameArea } from "../shared/video-frame";
import { validVideoFrameArea } from "../shared/video-frame";
import { normalizeVideoTranslation } from "../shared/video";
import { getSettings } from "../shared/settings";

/** The full tab screenshot stays in the background; only video pixels leave it. */
export async function captureVideoFrame(area: VideoFrameArea, sender: chrome.runtime.MessageSender): Promise<{ dataUrl: string }> {
  const tabId = sender.tab?.id, windowId = sender.tab?.windowId;
  if (tabId === undefined || windowId === undefined || !/^https?:\/\//u.test(sender.url ?? "")
    || !validVideoFrameArea(area)) throw new Error(t("cannotLocateTheVideoFrameBringTheEntire"));
  const settings = await getSettings();
  if (!normalizeVideoTranslation(settings.videoTranslation).enabled || !settings.imageTranslationEnabled) {
    throw new Error(t("enableSubtitlesAndImageTranslationAndInstallThe"));
  }
  const checkActive = async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.windowId !== windowId || tab.url !== sender.tab?.url) {
      throw new Error(t("theVideoPageHasChangedReturnToThe"));
    }
  };
  await checkActive();
  let dataUrl: string;
  try { dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }); }
  catch (error) {
    if (String(error).includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) throw new Error(t("tooManyFrameCapturesTryAgainLater"));
    throw new Error(t("theBrowserDeniedScreenAccessClickWupageIn"));
  }
  await checkActive();
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const { rect, viewport } = area;
    const sx = bitmap.width / viewport.width, sy = bitmap.height / viewport.height;
    const width = rect.width * sx, height = rect.height * sy;
    const scale = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("theBrowserCouldNotReadTheVideoFrame"));
    context.drawImage(bitmap, rect.x * sx, rect.y * sy, width, height, 0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { dataUrl: `data:image/png;base64,${btoa(binary)}` };
  } finally { bitmap.close(); }
}
