import { t } from "../shared/i18n";
import { getImageRasterSize } from "./image-rendering";
import { topVideoFrameArea } from "./frame-visibility";
import { sendRuntimeRequest } from "./runtime";

export interface CapturedVideoFrame {
  source: HTMLCanvasElement | HTMLImageElement;
  dataUrl: string;
  width: number;
  height: number;
  objectFit: string;
  objectPosition: string;
}

export async function capturePausedVideo(video: HTMLVideoElement, signal: AbortSignal,
  hideTools: (hidden: boolean) => void): Promise<CapturedVideoFrame> {
  signal.throwIfAborted();
  if (!video.paused || video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error(t("theVideoFrameIsNotReadyWaitUntil"));
  }
  if (video.mediaKeys) throw new Error(t("thisVideoIsProtectedItsFramesCannotBe"));
  const rect = video.getBoundingClientRect(), style = getComputedStyle(video);
  const size = getImageRasterSize(video.videoWidth, video.videoHeight, rect.width, rect.height, devicePixelRatio || 1);
  const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("theBrowserCouldNotReadTheVideoFrame"));
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { source: canvas, dataUrl: canvas.toDataURL("image/png"), ...size,
      objectFit: style.objectFit || "contain", objectPosition: style.objectPosition || "50% 50%" };
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "SecurityError") throw error;
  }
  // Cross-origin media cannot be read with canvas. Crop a visible-tab capture,
  // resolving iframe coordinates without sending screenshot pixels to the page.
  hideTools(true);
  try {
    const locate = () => {
      const bounds = video.getBoundingClientRect();
      return topVideoFrameArea({ rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        viewport: { width: innerWidth, height: innerHeight } }, signal);
    };
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const cleanup = () => { clearTimeout(timer); cancelAnimationFrame(frame); signal.removeEventListener("abort", cancel); };
      const done = () => { cleanup(); resolve(); };
      const cancel = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(done, 120);
      signal.addEventListener("abort", cancel, { once: true });
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
    });
    signal.throwIfAborted();
    if (document.visibilityState === "hidden") throw new Error(t("returnToTheVideoPageToTranslateA"));
    const area = await locate();
    signal.throwIfAborted();
    const { dataUrl } = await sendRuntimeRequest<{ dataUrl: string }>({ type: "CAPTURE_VIDEO_FRAME", ...area });
    signal.throwIfAborted();
    const after = await locate();
    if (JSON.stringify(area) !== JSON.stringify(after)) throw new Error(t("theVideoMovedStopScrollingOrResizingAnd"));
    const source = new Image(); source.src = dataUrl; await source.decode();
    signal.throwIfAborted();
    return { source, dataUrl, width: source.naturalWidth, height: source.naturalHeight, objectFit: "fill", objectPosition: "50% 50%" };
  } finally { hideTools(false); }
}
