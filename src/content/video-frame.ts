import { t } from "../shared/i18n";
import type { ExtensionSettings, TranslateImageResponse } from "../shared/types";
import { normalizeVideoTranslation } from "../shared/video";
import { mediaKey } from "../video/platforms";
import { sendRuntimeRequest } from "./runtime";
import { renderImageTranslation } from "./image-rendering";
import { capturePausedVideo } from "./video-frame-capture";
import type { VideoView } from "./video-view";

/** A frame translation belongs to one paused media time and one settings version. */
export class PlayerFrameTranslation {
  private generation = 0;
  private controller?: AbortController;
  private canvas?: HTMLCanvasElement;
  private showing = false;
  private disposed = false;
  private time = 0;
  private source = "";
  private key = "";
  private readonly cleanups: Array<() => void> = [];

  constructor(private video: HTMLVideoElement, private view: VideoView, private readSettings: () => Promise<ExtensionSettings>) {
    for (const type of ["play", "playing", "seeking", "emptied", "loadedmetadata"]) this.on(video, type, () => this.reset());
    this.on(video, "timeupdate", () => { if ((this.controller || this.canvas) && !this.sameFrame()) this.reset(); });
    this.on(video, "enterpictureinpicture", () => this.reset());
    this.on(document, "fullscreenchange", () => { if (document.fullscreenElement === video) this.reset(); });
    this.on(window, "popstate", () => this.reset());
    this.on(document, "yt-navigate-finish", () => this.reset());
  }

  private on(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener); this.cleanups.push(() => target.removeEventListener(type, listener));
  }

  private sameFrame(): boolean {
    return this.video.isConnected && this.video.paused && !this.video.seeking
      && this.video.currentTime === this.time && this.video.currentSrc === this.source && mediaKey() === this.key;
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.controller) { this.reset(); return; }
    if (this.canvas && this.sameFrame()) {
      this.showing = !this.showing; this.canvas.hidden = !this.showing;
      this.view.setFrameState(this.showing ? "active" : "original"); return;
    }
    this.reset();
    this.video.pause();
    if (this.video.seeking) { this.view.setFrameState("idle", t("theVideoIsSeekingWaitForTheFrame")); return; }
    this.time = this.video.currentTime; this.source = this.video.currentSrc; this.key = mediaKey();
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    const current = () => !this.disposed && generation === this.generation && this.sameFrame();
    this.view.setFrameState("loading", t("recognizingAndTranslatingVideoFrame"));
    try {
      const settings = await this.readSettings();
      if (!current()) return;
      if (!normalizeVideoTranslation(settings.videoTranslation).enabled) throw new Error(t("enableVideoSubtitlesFirst"));
      if (!settings.imageTranslationEnabled) throw new Error(t("useTheWrenchBesideImageTranslationInWupage"));
      const frame = await capturePausedVideo(this.video, controller.signal, hidden => {
        if (generation === this.generation) this.view.setFrameCapturing(hidden);
      });
      if (!current()) return;
      const result = await sendRuntimeRequest<TranslateImageResponse>({ type: "TRANSLATE_IMAGE",
        dataUrl: frame.dataUrl, width: frame.width, height: frame.height });
      if (!current()) return;
      if (!result.regions.length) {
        this.view.setFrameState("idle", result.warning ?? t("noTranslatableTextFoundInThisFrame")); return;
      }
      const canvas = document.createElement("canvas"); canvas.width = frame.width; canvas.height = frame.height;
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", result.regions.map(region => region.translation).join("\n"));
      renderImageTranslation(canvas, frame.source, result.regions);
      Object.assign(canvas.style, { objectFit: frame.objectFit, objectPosition: frame.objectPosition });
      this.canvas = canvas; this.showing = true; this.view.showFrame(canvas);
      this.view.setFrameState("active", result.warning);
    } catch (error) {
      if (current() && !controller.signal.aborted) this.view.setFrameState("idle", error instanceof Error ? error.message : t("frameTranslationFailedTryAgain"));
    } finally {
      if (generation === this.generation) {
        this.controller = undefined; this.view.setFrameCapturing(false);
        if (!current()) this.reset();
      }
    }
  }

  reset(): void {
    this.generation++; this.controller?.abort(); this.controller = undefined;
    this.canvas?.remove(); this.canvas = undefined; this.showing = false;
    this.view.setFrameCapturing(false); this.view.setFrameState("idle");
  }

  dispose(): void {
    this.disposed = true; this.reset(); for (const cleanup of this.cleanups) cleanup(); this.cleanups.length = 0;
  }
}
