import { VideoView } from "./video-view";
import { VideoRequests } from "./video-requests";
import { sendRuntimeRequest } from "./runtime";
import { SETTINGS_KEY } from "../shared/defaults";
import { TARGET_LANGUAGES } from "../shared/languages";
import { createSettingsSnapshot } from "../shared/settings-snapshot";
import type { ExtensionSettings } from "../shared/types";
import { normalizeVideoTranslation, sameVideoLanguage, type VideoTranslationSettings } from "../shared/video";
import { loadPageSubtitles, pageSubtitleCatalogue } from "../video/bridge-client";
import { captionElements, mediaKey, renderedCaption, selectedNativeTrack, type VideoPlatform } from "../video/platforms";
import type { PageSubtitleCatalogue } from "../video/site-cues";
import { MAX_SUBTITLE_FILE_BYTES, parseSubtitles, SubtitleTranslator, subtitleText, type SubtitleCue } from "../video/subtitles";
import { LiveSubtitleTranslator } from "../video/live-subtitles";

export class PlayerSubtitleController {
  readonly view: VideoView;
  enabled = false;
  private resumeOnReplacement = false;
  private disposed = false;
  private settings?: ExtensionSettings;
  private readonly settingsSnapshot = createSettingsSnapshot(() => sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }));
  private preferences = normalizeVideoTranslation(undefined);
  private timeline?: SubtitleTranslator;
  private nativeTrack?: TextTrack;
  private timelineHasCues = false;
  private live?: LiveSubtitleTranslator;
  private requests?: VideoRequests;
  private phase: "idle" | "loading" | "active" | "waiting" | "error" = "idle";
  private reportedError = "";
  private sourceError = "";
  private controller?: AbortController;
  private epoch = 0;
  private key = mediaKey();
  private source = "auto";
  private sourceLanguage = "auto";
  private loadedPageTrack = "";
  private catalogue?: PageSubtitleCatalogue;
  private imported?: { name: string; cues: SubtitleCue[] };
  private offset = 0;
  private clock?: ReturnType<typeof setInterval>;
  private controlsTimer?: ReturnType<typeof setTimeout>;
  private started = 0;
  private suppressUntil = 0;
  private lastCatalogue = 0;
  private catalogueEpoch = 0;
  private originalModes: Array<{ track: TextTrack; mode: TextTrackMode }> = [];
  private nativeToggled = false;
  private nativeAttempts = 0;
  private lastNativeAttempt = 0;
  private nativeFullscreenTrack?: TextTrack;
  private nativeFullscreenCue?: VTTCue;
  private hiddenCaptions = new Map<HTMLElement, string | null>();
  private readonly nativeStyle = document.createElement("style");
  private readonly cleanups: Array<() => void> = [];
  private saveQueue: Promise<void> = Promise.resolve();
  private settingsRevision = 0;
  private originalPosition: { value: string; priority: string } | undefined;

  constructor(readonly video: HTMLVideoElement, readonly container: HTMLElement, readonly platform?: VideoPlatform, private autoStart = true) {
    this.view = new VideoView({
      toggle: () => { if (this.enabled) this.stop(); else void this.start(); },
      retry: () => { void this.start(); },
      source: id => { this.source = id; if (this.enabled) void this.start(); },
      settings: patch => this.save(patch),
      preferences: patch => {
        this.save({}, patch);
      },
      import: file => { void this.importFile(file); },
      offset: value => { this.offset = value; this.live?.reset(); this.tick(); }
    }, this.site);
    if (getComputedStyle(container).position === "static") {
      this.originalPosition = { value: container.style.getPropertyValue("position"), priority: container.style.getPropertyPriority("position") };
      container.style.setProperty("position", "relative");
    }
    this.nativeStyle.dataset.wupageVideoStyle = this.view.id;
    this.nativeStyle.textContent = `[data-wupage-video-native="${this.view.id}"] { opacity: 0 !important; }
      video[data-wupage-video-cues="${this.view.id}"]::cue { color: transparent; background-color: transparent; text-shadow: none; }`;
    container.append(this.nativeStyle, this.view.host);
    this.on(container, "pointermove", () => this.showControls());
    this.on(container, "pointerenter", () => this.showControls());
    this.on(container, "pointerdown", () => this.showControls(), true);
    this.on(container, "pointerleave", event => {
      if ((event as PointerEvent).pointerType !== "touch" && !this.view.panelOpen) this.view.setControls(false);
    });
    this.on(video, "timeupdate", () => this.tick()); this.on(video, "pause", () => this.tick()); this.on(video, "playing", () => this.tick());
    this.on(video, "seeking", () => { this.suppressUntil = Date.now() + 160; this.live?.reset(); this.clearCaption(); this.timeline?.update(video.currentTime - this.offset); });
    this.on(video, "seeked", () => { this.suppressUntil = Date.now() + 100; this.clearCaption(); });
    this.on(video, "emptied", () => this.changedVideo());
    this.on(video, "loadedmetadata", () => this.changedVideo());
    this.on(video, "enterpictureinpicture", () => { this.clearCaption(); this.view.tell("画中画中可在原播放器查看双语字幕。"); });
    this.on(document, "fullscreenchange", () => { this.position(); this.showControls(); this.tick(); });
    this.on(window, "resize", () => this.position());
    this.on(container, "click", event => {
      const target = event.target;
      if (!(target instanceof Element) || !event.isTrusted) return;
      if (target.closest(this.platform?.toggle || ".wupage-no-caption-toggle")) this.nativeToggled = false;
      if (this.platform?.id === "youtube" && target.closest(".ytp-subtitles-button")?.getAttribute("aria-pressed") === "false") this.stop();
      if (this.enabled && target.closest("[class*='subtitle'],[class*='caption']")) this.lastCatalogue = 0;
    });
    chrome.storage?.onChanged?.addListener(this.settingsChanged);
    this.cleanups.push(() => chrome.storage?.onChanged?.removeListener?.(this.settingsChanged));
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.position()) : undefined;
    resize?.observe(video); resize?.observe(container); this.cleanups.push(() => resize?.disconnect());
    this.position(); this.showControls();
    void this.settingsSnapshot.read().then(settings => {
      if (this.disposed) return;
      this.applySettings(settings);
      if (this.preferences.enabled && !this.enabled && this.autoStart && this.preferences.enabledSites.includes(this.site) && (window === window.top || !this.video.paused)) void this.start();
    }).catch(() => undefined);
  }

  get site(): string { return this.platform?.id ?? location.hostname; }
  get wantsTranslation(): boolean { return this.enabled || this.resumeOnReplacement; }
  get connected(): boolean {
    if (this.disposed || !this.video.isConnected || !this.container.isConnected || !this.view.host.isConnected) return false;
    let node: Node | null = this.video;
    while (node) {
      if (node === this.container) return true;
      node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    }
    return false;
  }
  open(): void { this.showControls(); if (!this.enabled) void this.start(); else this.view.setPanel(true); }

  private on(target: EventTarget, type: string, callback: EventListener, capture = false): void {
    target.addEventListener(type, callback, capture); this.cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  private showControls(): void {
    clearTimeout(this.controlsTimer); this.view.setControls(true);
    this.controlsTimer = setTimeout(() => { if (!this.view.panelOpen) this.view.setControls(false); }, 2600);
  }

  async start(): Promise<void> {
    if (this.disposed || !this.video.isConnected) return;
    this.clearSession(false); this.enabled = true; this.phase = "loading"; this.started = Date.now();
    const epoch = ++this.epoch;
    const controller = new AbortController(); this.controller = controller;
    this.key = mediaKey(); this.catalogue = undefined; this.loadedPageTrack = ""; this.nativeAttempts = 0;
    this.view.setState(true, "loading", "正在读取播放器字幕…"); this.showControls();
    try {
      const settings = await this.settingsSnapshot.read();
      if (!this.valid(epoch)) return;
      this.applySettings(settings);
      if (!this.preferences.enabled) { this.stop(); return; }
      const provider = settings.providers.find(entry => entry.id === settings.activeProviderId);
      if (!provider || provider.enabled === false) throw new Error("请先选择可用的翻译服务。");
      this.clock = setInterval(() => this.tick(), 120);
      if (this.imported && this.source === "file") this.useTimeline(() => this.imported?.cues ?? [], settings.sourceLang);
      else {
        const tracks = this.nativeTracks();
        const track = this.source.startsWith("native:") ? tracks[Number(this.source.slice(7))]
          : this.source.startsWith("page:") ? undefined : this.chooseNative(tracks);
        if (track) this.useNative(track);
        else if (!this.source.startsWith("page:")) this.useRendered();
      }
      this.populateTracks(); this.tick();
      if (this.platform?.bridge && !this.source.startsWith("native:") && this.source !== "file") {
        await this.readPageTrack(epoch);
      }
      if (this.valid(epoch)) { this.phase = "active"; this.tick(); }
    } catch (error) {
      if (!this.valid(epoch) || controller.signal.aborted) return;
      this.phase = "error"; this.state(error instanceof Error ? error.message : String(error)); this.view.setPanel(true);
    }
  }

  private nativeTracks(): TextTrack[] { return Array.from(this.video.textTracks).filter(track => ["subtitles", "captions"].includes(track.kind) && track !== this.nativeFullscreenTrack); }
  private chooseNative(tracks: TextTrack[]): TextTrack | undefined {
    const preferred = this.preferences.preferredSource !== "auto" ? this.preferences.preferredSource : this.settings?.sourceLang;
    return selectedNativeTrack(this.container, this.platform, tracks) || tracks.find(track => track.mode === "showing") || tracks.find(track => track.mode === "hidden" && (track.cues?.length ?? 0) > 0)
      || tracks.find(track => preferred && preferred !== "auto" && track.language.startsWith(preferred.split("-")[0]))
      || tracks.find(track => track.language.startsWith("en")) || tracks[0];
  }

  private useNative(track: TextTrack): void {
    for (const entry of this.nativeTracks().filter(candidate => candidate === track || candidate.mode === "showing")) {
      const original = this.originalModes.find(candidate => candidate.track === entry);
      if (!original) this.originalModes.push({ track: entry, mode: entry.mode });
      else if (entry.mode !== "hidden") original.mode = entry.mode;
      entry.mode = "hidden";
    }
    let list: TextTrackCueList | null = null; let length = -1; let cues: SubtitleCue[] = [];
    this.useTimeline(() => {
      const current = track.cues;
      if (current !== list || (current?.length ?? 0) !== length) {
        list = current; length = current?.length ?? 0;
        cues = current ? Array.from(current).slice(0, 20_000).map(cue => ({ start: cue.startTime, end: cue.endTime,
          text: subtitleText("text" in cue ? String(cue.text) : "") })).filter(cue => cue.text && cue.text.length <= 4000) : [];
      }
      return cues;
    }, track.language || this.settings!.sourceLang);
    this.nativeTrack = track;
  }

  private useTimeline(cues: () => SubtitleCue[], language: string): void {
    this.nativeTrack = undefined;
    this.view.host.dataset.subtitleSource = "timeline";
    this.timeline?.dispose(); this.live?.dispose(); this.requests?.cancel();
    this.live = undefined; this.sourceLanguage = language;
    this.requests = new VideoRequests(this.settings!, language);
    const requests = this.requests;
    this.timeline = new SubtitleTranslator(() => {
      const value = cues(); this.timelineHasCues = value.length > 0; return value;
    }, (texts, signal) => requests.translate(texts, signal), () => this.paint());
  }

  private useRendered(): void {
    this.nativeTrack = undefined;
    this.view.host.dataset.subtitleSource = "live";
    this.sourceLanguage = this.settings!.sourceLang;
    this.requests = new VideoRequests(this.settings!, this.sourceLanguage);
    const requests = this.requests;
    this.live = new LiveSubtitleTranslator((texts, signal) => requests.translate(texts, signal), () => this.paint());
    this.enableRenderedCaptions();
  }

  private enableRenderedCaptions(): void {
    if (this.nativeAttempts >= 2 || this.advertising() || Date.now() - this.lastNativeAttempt < 3000) return;
    const button = this.platform?.id === "youtube" ? this.container.querySelector<HTMLElement>(".ytp-subtitles-button") : null;
    if (button?.getAttribute("aria-pressed") === "false") {
      this.nativeAttempts++; this.lastNativeAttempt = Date.now(); button.click(); this.nativeToggled = true;
    }
  }

  private async readPageTrack(epoch: number): Promise<void> {
    if (!this.valid(epoch) || this.catalogueEpoch === epoch) return;
    this.catalogueEpoch = epoch; this.lastCatalogue = Date.now();
    try {
      const catalogue = await pageSubtitleCatalogue(this.controller?.signal);
      if (!this.valid(epoch)) return;
      if (catalogue?.key !== this.key || !catalogue.tracks.length) {
        if (this.source.startsWith("page:")) throw new Error("字幕目录已变化。");
        return;
      }
      this.catalogue = catalogue; this.populateTracks();
      const preferred = this.preferences.preferredSource !== "auto" ? this.preferences.preferredSource : this.settings!.sourceLang;
      const selected = this.source.startsWith("page:") ? catalogue.tracks.find(track => track.id === this.source.slice(5)) :
        catalogue.tracks.find(track => track.id === catalogue.selected) || catalogue.tracks.find(track => preferred !== "auto" && track.language.startsWith(preferred.split("-")[0]))
        || catalogue.tracks.find(track => sameVideoLanguage(track.language, "en") && !track.automatic)
        || catalogue.tracks.find(track => sameVideoLanguage(track.language, "en")) || catalogue.tracks[0];
      if (!selected) {
        if (this.source.startsWith("page:")) throw new Error("所选字幕已移除。");
        return;
      }
      if (this.loadedPageTrack === selected.id) return;
      const payload = await loadPageSubtitles(selected.id, this.controller?.signal);
      if (!this.valid(epoch)) return;
      if (payload.key !== this.key || !payload.cues.length) throw new Error("所选字幕没有返回内容。");
      this.loadedPageTrack = selected.id; this.useTimeline(() => payload.cues, selected.language); this.phase = "active"; this.tick();
    } catch {
      if (this.valid(epoch) && this.source.startsWith("page:")) {
        this.sourceError = "未能读取所选原字幕。请在网站播放器开启对应语言，或选择「跟随播放器」后重试。";
        this.clearCaption(); throw new Error(this.sourceError);
      }
      // The rendered source continues translating when full tracks need site authorization.
    } finally { if (this.catalogueEpoch === epoch) this.catalogueEpoch = 0; }
  }

  private populateTracks(): void {
    this.view.tracks([
      ...this.nativeTracks().map((track, index) => ({ id: `native:${index}`, label: track.label || track.language || `字幕 ${index + 1}` })),
      ...(this.catalogue?.tracks.map(track => ({ id: `page:${track.id}`, label: track.label })) ?? []),
      ...(this.imported ? [{ id: "file", label: this.imported.name }] : [])
    ], this.source);
  }

  private advertising(): boolean { return this.platform?.id === "youtube" && this.container.classList.contains("ad-showing"); }

  private tick(): void {
    if (!this.enabled || this.disposed) return;
    if (!this.connected) { this.dispose(true); return; }
    if (mediaKey() !== this.key) { this.changedVideo(); return; }
    this.position();
    if (this.video.seeking || Date.now() < this.suppressUntil || this.advertising()) { this.live?.reset(); this.clearCaption(); return; }
    try {
      if (this.source === "auto") {
        const tracks = this.nativeTracks(), current = this.nativeTrack;
        const selected = selectedNativeTrack(this.container, this.platform, tracks);
        if (selected === current && current?.mode === "disabled") current.mode = "hidden";
        const changed = current && (current.mode === "disabled" || !tracks.includes(current)
          || (current.language || this.settings!.sourceLang) !== this.sourceLanguage
          || (selected && selected !== current)
          || tracks.some(track => track !== current && track.mode === "showing"));
        if (!this.timeline || changed) {
          const track = this.chooseNative(tracks);
          if (track && (track !== current || (track.language || this.settings!.sourceLang) !== this.sourceLanguage)) {
            this.live?.reset(); this.useNative(track); this.populateTracks();
          }
        }
      }
      if (this.timeline) this.timeline.update(this.video.currentTime - this.offset);
      else { this.enableRenderedCaptions(); this.live?.update(renderedCaption(this.container, this.platform)); }
      if (this.platform?.bridge && this.source === "auto" && !this.imported && !this.advertising()
        && Date.now() - this.lastCatalogue > (this.platform.id === "youtube" ? 3500 : 20_000)) void this.readPageTrack(this.epoch);
      this.paint();
    } catch (error) {
      this.phase = "error"; this.state(error instanceof Error ? error.message : "字幕暂不可用，请重试。");
    }
  }

  private paint(): void {
    if (!this.enabled || this.disposed) return;
    const value = this.timeline?.current() ?? this.live?.current() ?? { source: "", translation: "" };
    const error = this.sourceError || this.timeline?.error || this.live?.error;
    if (this.advertising() || this.video.seeking || Date.now() < this.suppressUntil) { this.clearCaption(); return; }
    this.view.render(value.source, value.translation, this.preferences);
    this.hideNative(!!value.translation);
    this.renderNativeFullscreen(value.source, value.translation);
    if (error) { this.phase = "error"; this.state(`翻译暂不可用：${error}`); }
    else if (!value.source && Date.now() - this.started > 2500 && !this.loadedPageTrack && (!this.timeline || !this.timelineHasCues)) {
      const message = this.timeline ? "原字幕尚未就绪，请先在播放器开启字幕，或选择其他原字幕语言。"
        : this.platform?.id === "bilibili" ? "请先在播放器开启字幕。部分字幕需要登录后才能使用。" : "请先开启播放器的 CC / 字幕，播放后会自动翻译。";
      if (this.phase !== "waiting") this.view.tell(message);
      this.phase = "waiting"; this.state(message);
    } else if (this.phase !== "loading") {
      this.phase = "active";
      const target = TARGET_LANGUAGES.find(language => language.code === this.settings?.targetLang)?.label ?? this.settings?.targetLang;
      this.state(`${this.platform?.label ?? "视频字幕"} · ${target} · ${this.video.paused ? "已暂停" : "翻译中"}`);
    }
  }

  private renderNativeFullscreen(source: string, translation: string): void {
    if (document.fullscreenElement !== this.video) {
      if (this.nativeFullscreenTrack) this.nativeFullscreenTrack.mode = "disabled";
      return;
    }
    if (!this.nativeFullscreenTrack) this.nativeFullscreenTrack = this.video.addTextTrack("subtitles", "WuPage 双语", this.settings?.targetLang);
    const track = this.nativeFullscreenTrack;
    const text = translation ? `${this.preferences.showOriginal && source !== translation ? `${source}\n` : ""}${translation}` : "";
    if (this.nativeFullscreenCue?.text === text && this.nativeFullscreenCue.endTime > this.video.currentTime) return;
    if (this.nativeFullscreenCue) { try { track.removeCue(this.nativeFullscreenCue); } catch { /* Media source replacement clears cues. */ } }
    this.nativeFullscreenCue = undefined;
    if (text) {
      const cue = new VTTCue(Math.max(0, this.video.currentTime - .05), this.video.currentTime + 1, text);
      track.addCue(cue); this.nativeFullscreenCue = cue; track.mode = "showing";
    }
  }

  private hideNative(hide: boolean): void {
    if (hide && document.fullscreenElement !== this.video) this.video.setAttribute("data-wupage-video-cues", this.view.id);
    else if (this.video.getAttribute("data-wupage-video-cues") === this.view.id) this.video.removeAttribute("data-wupage-video-cues");
    const elements = hide ? captionElements(this.container, this.platform) : [];
    for (const [element, before] of this.hiddenCaptions) if (!elements.includes(element)) {
      if (before === null) element.removeAttribute("data-wupage-video-native"); else element.setAttribute("data-wupage-video-native", before);
      this.hiddenCaptions.delete(element);
    }
    for (const element of elements) if (!this.hiddenCaptions.has(element)) {
      this.hiddenCaptions.set(element, element.getAttribute("data-wupage-video-native")); element.setAttribute("data-wupage-video-native", this.view.id);
    }
  }

  private clearCaption(): void { this.view.render("", "", this.preferences); this.hideNative(false); this.renderNativeFullscreen("", ""); }
  private state(message: string): void {
    if (message.includes("API key is required")) message = "当前服务需要 API 密钥。请在 WuPage 设置中填写，或选择已配置的翻译服务。";
    else if (message.includes("Extension context invalidated")) message = "扩展已更新或重新加载，请刷新视频页后继续。";
    else if (/message (?:channel|port) closed|Receiving end does not exist|No response from extension runtime/u.test(message)) {
      message = "扩展连接已中断，请点击「重试读取」；如果刚更新过扩展，请刷新视频页。";
    }
    this.view.setState(this.enabled, this.phase, message);
    if (this.phase === "error" && this.reportedError !== message) { this.reportedError = message; this.view.setPanel(true); }
    else if (this.phase !== "error") this.reportedError = "";
  }
  private valid(epoch: number): boolean { return !this.disposed && this.enabled && epoch === this.epoch && mediaKey() === this.key; }

  private changedVideo(): void {
    if (!this.enabled) return;
    this.imported = undefined; this.source = "auto"; this.suppressUntil = Date.now() + 500;
    void this.start();
  }

  private readonly settingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !settings || this.disposed) return;
    this.settingsRevision++;
    this.settingsSnapshot.receive(settings);
    this.receiveSettings(settings);
  };

  private receiveSettings(settings: ExtensionSettings): void {
    const previous = this.settings;
    this.applySettings(settings);
    const signature = (value: ExtensionSettings) => JSON.stringify([value.sourceLang, value.targetLang, value.activeProviderId,
      value.providers.find(provider => provider.id === value.activeProviderId), normalizeVideoTranslation(value.videoTranslation).preferredSource]);
    if (this.enabled && previous && signature(previous) !== signature(settings)) void this.start();
    else this.paint();
  }

  private applySettings(settings: ExtensionSettings): void {
    this.settings = settings; this.preferences = normalizeVideoTranslation(settings.videoTranslation); this.view.settings(settings, this.site);
  }

  private save(patch: Partial<ExtensionSettings>, preferences?: Partial<VideoTranslationSettings>): void {
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      const latest = await this.settingsSnapshot.read();
      if (this.disposed) return;
      const videoSettings = normalizeVideoTranslation(latest.videoTranslation);
      const settings = { ...latest, ...patch,
        ...(preferences ? { videoTranslation: { ...videoSettings, ...preferences, ...(preferences.enabledSites ? {
          enabledSites: preferences.enabledSites.includes(this.site) ? [...videoSettings.enabledSites.filter(site => site !== this.site), this.site]
            : videoSettings.enabledSites.filter(site => site !== this.site)
        } : {}) } } : {}) };
      const revision = this.settingsRevision;
      await sendRuntimeRequest({ type: "SAVE_SETTINGS", settings });
      if (!this.disposed && revision === this.settingsRevision) { this.settingsSnapshot.receive(settings); this.receiveSettings(settings); }
    }).catch(error => { this.view.tell(`设置未保存：${error instanceof Error ? error.message : String(error)}`); });
  }

  private async importFile(file: File): Promise<void> {
    const key = mediaKey();
    try {
      if (file.size > MAX_SUBTITLE_FILE_BYTES) throw new Error("字幕文件不能超过 2 MiB。");
      const cues = parseSubtitles(await file.text());
      if (this.disposed || key !== mediaKey()) return;
      this.imported = { name: file.name, cues }; this.source = "file"; this.populateTracks();
      this.view.setPanel(false); this.view.tell(`已载入 ${cues.length} 条字幕`); await this.start();
    } catch (error) { this.view.tell(error instanceof Error ? error.message : String(error)); }
  }

  position(): void {
    if (this.disposed) return;
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen instanceof HTMLElement && fullscreen !== this.video && fullscreen.contains(this.video) ? fullscreen : this.container;
    if (this.view.host.parentElement !== parent) parent.append(this.view.host);
    // Full-page players can keep all content fixed, leaving the HTML box height zero.
    const bounds = parent === fullscreen && (parent === document.documentElement || parent === document.body)
      ? new DOMRect(0, 0, innerWidth, innerHeight) : parent.getBoundingClientRect();
    let rect = this.video.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) rect = bounds;
    const scaleX = parent.clientWidth ? bounds.width / parent.clientWidth : 1;
    const scaleY = parent.clientHeight ? bounds.height / parent.clientHeight : 1;
    this.view.host.style.setProperty("--wp-layer-left", `${(rect.left - bounds.left) / (scaleX || 1) + parent.scrollLeft}px`);
    this.view.host.style.setProperty("--wp-layer-top", `${(rect.top - bounds.top) / (scaleY || 1) + parent.scrollTop}px`);
    this.view.host.style.setProperty("--wp-layer-width", `${rect.width / (scaleX || 1)}px`);
    this.view.host.style.setProperty("--wp-layer-height", `${rect.height / (scaleY || 1)}px`);
    this.view.host.hidden = fullscreen === this.video || rect.width < 160 || rect.height < 90;
    if (this.view.panelOpen) this.view.positionPanel();
  }

  stop(): void {
    this.resumeOnReplacement = false; this.enabled = false; this.epoch++; this.clearSession(); this.phase = "idle";
    this.state("点击播放器上的「字幕翻译」即可开启。"); this.showControls();
  }

  private clearSession(restoreNative = true): void {
    this.nativeTrack = undefined;
    this.sourceError = "";
    this.view.host.dataset.subtitleSource = "none";
    this.controller?.abort(); this.timeline?.dispose(); this.live?.dispose(); this.requests?.cancel();
    this.timeline = undefined; this.timelineHasCues = false; this.live = undefined; this.requests = undefined;
    clearInterval(this.clock); this.clock = undefined; this.catalogueEpoch = 0;
    for (const entry of this.originalModes) if (entry.track.mode === "hidden") entry.track.mode = entry.mode;
    this.originalModes = [];
    if (this.nativeToggled && restoreNative) {
      const button = this.container.querySelector<HTMLElement>(".ytp-subtitles-button");
      if (button?.getAttribute("aria-pressed") === "true") button.click();
      this.nativeToggled = false;
    }
    this.clearCaption();
  }

  dispose(preserveTranslation = false): void {
    if (this.disposed) return;
    const resume = preserveTranslation && this.enabled;
    this.stop(); this.disposed = true; clearTimeout(this.controlsTimer);
    this.resumeOnReplacement = resume;
    for (const cleanup of this.cleanups) cleanup(); this.cleanups.length = 0;
    if (this.originalPosition && this.container.style.position === "relative") {
      if (this.originalPosition.value) this.container.style.setProperty("position", this.originalPosition.value, this.originalPosition.priority);
      else this.container.style.removeProperty("position");
    }
    this.imported = undefined; this.catalogue = undefined; this.view.dispose(); this.nativeStyle.remove();
  }
}
