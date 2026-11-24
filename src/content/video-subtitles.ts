import { PlayerSubtitleController } from "./video-player";
import { playerContainer, queryVideoRoots, videoPlatform } from "../video/platforms";
import { hasCustomPlayer } from "../video/player-controls";
import { sendRuntimeRequest } from "./runtime";
import { normalizeVideoTranslation, videoPriority } from "../shared/video";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../shared/defaults";
import { createSettingsSnapshot } from "../shared/settings-snapshot";
import type { ExtensionSettings } from "../shared/types";
import { initializeInterfaceLanguage, t } from "../shared/i18n";
import { hasExtensionContext } from "../shared/extension-context";
import { currentWebsitePattern } from "../shared/auto-translation";

let current: VideoSubtitleManager | undefined;
let feature: { ready: Promise<void> } | undefined;

const videoObservation: MutationObserverInit = {
  childList: true, subtree: true, attributes: true, attributeFilter: ["src", "controls", "loop", "muted"]
};

export async function initEmbeddedVideoSubtitles(): Promise<void> {
  await initializeInterfaceLanguage();
  initVideoSubtitles();
}

export function initVideoSubtitles(): void {
  if (feature || !hasExtensionContext() || typeof location === "undefined" || typeof document === "undefined" || !/^https?:$/u.test(location.protocol) || !document.documentElement) return;
  const snapshot = createSettingsSnapshot(() => sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }));
  let disposed = false;
  const apply = (settings: ExtensionSettings) => {
    if (disposed || !hasExtensionContext()) return;
    if (!normalizeVideoTranslation(settings?.videoTranslation).enabled) current?.dispose();
    else if (current) current.applySettings(settings);
    else current = new VideoSubtitleManager(settings);
  };
  const refresh = async () => { const settings = await snapshot.read(); apply(settings); };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !settings) return;
    snapshot.receive(settings); apply(settings);
  };
  const restored = () => { if (feature) feature.ready = refresh().catch(() => {}); };
  const leave = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    disposed = true;
    if (hasExtensionContext()) chrome.storage?.onChanged?.removeListener?.(changed);
    window.removeEventListener("pageshow", restored); window.removeEventListener("pagehide", leave);
    current?.dispose(); feature = undefined;
  };
  feature = { ready: Promise.resolve() };
  chrome.storage?.onChanged?.addListener(changed);
  window.addEventListener("pageshow", restored); window.addEventListener("pagehide", leave);
  feature.ready = refresh().catch(() => {});
}

export async function openVideoSubtitles(): Promise<{ opened: boolean }> {
  initVideoSubtitles(); await feature?.ready; return { opened: current?.open() ?? false };
}

export class VideoSubtitleManager {
  private players = new Map<HTMLVideoElement, PlayerSubtitleController>();
  private readonly observer: MutationObserver;
  private readonly timer: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private registered = false;
  private resumePlayback = false;
  private readonly website = currentWebsitePattern(location.href);
  private pendingFloatingHidden?: boolean;
  private readonly pagehide = (event: PageTransitionEvent) => {
    const enabled = [...this.players.values()].filter(player => player.wantsTranslation).map(player => player.video);
    this.dispose();
    if (event.persisted) window.addEventListener("pageshow", () => {
      initVideoSubtitles();
      void feature?.ready.then(() => {
        for (const video of enabled) void current?.players.get(video)?.start();
      });
    }, { once: true });
  };
  private readonly navigate = () => this.schedule();
  private readonly scrolled = () => { if (this.players.size >= 12) this.schedule(); };

  constructor(private settings: ExtensionSettings = DEFAULT_SETTINGS) {
    this.observer = new MutationObserver(records => {
      if (records.some(record => record.target instanceof HTMLVideoElement
        || (record.target instanceof HTMLSourceElement && record.target.parentElement instanceof HTMLVideoElement)
        || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && !node.matches("[data-wupage-video],[data-wupage-video-style]")
          && (node.matches("video,disney-web-player") || !!node.querySelector("video") || !!node.shadowRoot)))) this.schedule();
    });
    this.timer = setInterval(() => {
      if (!hasExtensionContext()) { this.dispose(); return; }
      // attachShadow() does not mutate the light DOM. Revisit connected hosts
      // too, even while another player remains mounted on the page.
      if (document.visibilityState !== "hidden") this.refresh();
      else this.announce();
    }, 6000);
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.navigate);
    window.addEventListener("popstate", this.navigate);
    window.addEventListener("scroll", this.scrolled, { passive: true });
    window.addEventListener("resize", this.navigate);
    document.addEventListener("yt-navigate-finish", this.navigate);
    document.addEventListener("visibilitychange", this.navigate);
    document.addEventListener("loadedmetadata", this.navigate, true);
    document.addEventListener("playing", this.navigate, true);
    document.addEventListener("emptied", this.navigate, true);
    this.refresh();
  }

  applySettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.updateFloatingControls();
  }

  private get floatingControlsHidden(): boolean {
    return this.pendingFloatingHidden ?? (!!this.website && this.settings.videoFloatingExcludedSites?.includes(this.website) === true);
  }

  private updateFloatingControls(): void {
    const hidden = this.floatingControlsHidden;
    for (const player of this.players.values()) player.setFloatingControlsHidden(hidden);
  }

  private async setFloatingControlsHidden(hidden: boolean, player: PlayerSubtitleController): Promise<void> {
    const site = this.website;
    if (!site || this.pendingFloatingHidden !== undefined || this.floatingControlsHidden === hidden) return;
    const previousSettings = this.settings;
    const sites = previousSettings.videoFloatingExcludedSites ?? [];
    const settings = { ...previousSettings, videoFloatingExcludedSites: hidden ? [...sites, site] : sites.filter(value => value !== site) };
    this.pendingFloatingHidden = hidden;
    this.updateFloatingControls();
    await sendRuntimeRequest({ type: "SAVE_SETTINGS", settings, previousSettings }).then(() => {
      if (this.settings === previousSettings) this.settings = settings;
    }).finally(() => {
      this.pendingFloatingHidden = undefined;
      this.updateFloatingControls();
    }).catch(error => {
      if (player.connected) player.view.tell(t("settingsCouldNotBeSaved", error instanceof Error ? error.message : String(error)));
    });
  }

  private schedule(): void {
    if (this.disposed) return;
    clearTimeout(this.pending); this.pending = setTimeout(() => this.refresh(), 160);
  }

  refresh(): void {
    if (this.disposed) return;
    if (!hasExtensionContext()) { this.dispose(); return; }
    const platform = videoPlatform();
    this.observer.disconnect();
    const candidates = queryVideoRoots(document, root => this.observer.observe(root, videoObservation))
      .filter(video => {
        if (video.title === "Advertisement") return false;
        const hasSource = video.currentSrc || video.srcObject || video.getAttribute("src")?.trim()
          || [...video.children].some(child => child instanceof HTMLSourceElement && child.getAttribute("src")?.trim());
        if (!hasSource) return false;
        // Muted loops are often decorative. Keep native controls, caption tracks and recognized custom players.
        return !video.loop || !(video.muted || video.defaultMuted) || video.controls || hasCustomPlayer(video, platform)
          || Array.from(video.textTracks).some(track => track.kind === "subtitles" || track.kind === "captions");
      })
      .map(video => ({ video, rect: video.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 160 && rect.height >= 90)
      .map(({ video, rect }) => ({ video, score: this.rank(video, rect) }))
      .sort((a, b) => Number(!!this.players.get(b.video)?.enabled) - Number(!!this.players.get(a.video)?.enabled) || b.score - a.score)
      .slice(0, 12);
    const selected = new Set(candidates.map(({ video }) => video));
    for (const [video, player] of this.players) if (!selected.has(video) || !player.connected) {
      if (player.wantsTranslation) this.resumePlayback = true;
      player.dispose(); this.players.delete(video);
    }
    for (const { video } of candidates) {
      if (this.players.has(video)) continue;
      const player = new PlayerSubtitleController(video, playerContainer(video, platform), platform, video === candidates[0].video, {
        hidden: this.floatingControlsHidden,
        dismiss: () => { void this.setFloatingControlsHidden(true, player); }
      });
      this.players.set(video, player);
      if (this.resumePlayback) { this.resumePlayback = false; void player.start(); }
    }
    this.announce();
  }

  private rank(video: HTMLVideoElement, rect = video.getBoundingClientRect()): number {
    const visible = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    return videoPriority(rect.width * rect.height, !video.paused) * (visible ? 1 : .5);
  }

  private primary(): PlayerSubtitleController | undefined {
    return [...this.players.values()].filter(player => player.connected).sort((a, b) =>
      Number(b.enabled) - Number(a.enabled) || this.rank(b.video) - this.rank(a.video))[0];
  }

  private announce(): void {
    if (!hasExtensionContext()) return;
    const players = [...this.players.values()].filter(player => player.connected);
    if (!players.length && !this.registered) return;
    this.registered = players.length > 0;
    const primary = this.primary();
    const rect = primary?.video.getBoundingClientRect();
    const area = rect ? rect.width * rect.height : 0;
    void sendRuntimeRequest({ type: "VIDEO_FRAME_STATUS", videos: players.length, area: Math.min(area, 1e8), playing: !!primary && !primary.video.paused }).catch(() => undefined);
  }

  open(): boolean {
    this.refresh();
    const player = this.primary(); if (!player) return false;
    void this.setFloatingControlsHidden(false, player);
    player.video.scrollIntoView?.({ block: "nearest", inline: "nearest" }); player.open(); return true;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    clearTimeout(this.pending); clearInterval(this.timer); this.observer.disconnect();
    window.removeEventListener("pagehide", this.pagehide); window.removeEventListener("pageshow", this.navigate); window.removeEventListener("popstate", this.navigate);
    window.removeEventListener("scroll", this.scrolled); window.removeEventListener("resize", this.navigate);
    document.removeEventListener("yt-navigate-finish", this.navigate);
    document.removeEventListener("visibilitychange", this.navigate);
    document.removeEventListener("loadedmetadata", this.navigate, true);
    document.removeEventListener("playing", this.navigate, true);
    document.removeEventListener("emptied", this.navigate, true);
    for (const player of this.players.values()) player.dispose(); this.players.clear();
    this.announce(); if (current === this) current = undefined;
  }
}
