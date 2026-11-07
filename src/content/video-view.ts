import { t, htmlMessage } from "../shared/i18n";
import { TARGET_LANGUAGES } from "../shared/languages";
import type { ExtensionSettings } from "../shared/types";
import { normalizeVideoTranslation, type VideoSubtitleLayout, type VideoTranslationSettings } from "../shared/video";
import { VideoLayoutEditor, VIDEO_LAYOUT_STYLES } from "./video-layout";
import { uiIconMarkup } from "../shared/ui-icons";
import { setHtmlContent } from "../shared/html";
import { SubtitlePresentation } from "./subtitle-presentation";

let nextView = 0;
const NOTICE_DURATION_MS = 5000;
export interface VideoViewActions {
  toggle: () => void;
  frame: () => void;
  retry: () => void;
  source: (id: string) => void;
  settings: (patch: Partial<ExtensionSettings>) => void;
  preferences: (patch: Partial<VideoTranslationSettings>) => void;
  layout: (layout: VideoSubtitleLayout) => Promise<void>;
  import: (file: File) => void;
  offset: (seconds: number) => void;
}

const styles = `
  :host { all: initial !important; position: absolute !important; top: var(--wp-layer-top,0px) !important; left: var(--wp-layer-left,0px) !important; width: var(--wp-layer-width,100%) !important; height: var(--wp-layer-height,100%) !important; z-index: 2147483600 !important; pointer-events: none !important; container-type: inline-size !important; color-scheme: dark !important; direction: ltr; } :host([hidden]) { display: none !important; }
  * { box-sizing: border-box; } [hidden] { display: none !important; }
  .toolbar { position: absolute; right: 14px; top: var(--wp-toolbar-top,14px); display: flex; gap: 1px; align-items: center; color: #fff; background: #172024eb; border: 1px solid #ffffff29; border-radius: 9px; box-shadow: 0 3px 12px #0003; opacity: 0; transform: translateY(-3px); transition: opacity .16s,transform .16s; pointer-events: none; }
  :host([data-controls]) .toolbar, .toolbar:hover, .toolbar:focus-within, :host([data-panel]) .toolbar, :host([data-error]) .toolbar, :host([data-waiting]) .toolbar { opacity: 1; transform: none; pointer-events: auto; }
  button, select, input { font: inherit; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
  .toolbar button { border: 0; color: inherit; background: transparent; min-height: 34px; padding: 7px 10px; font: 500 12px/20px system-ui,sans-serif; }
  .toolbar button:hover { background: #ffffff18; } .toggle { display: flex; gap: 7px; align-items: center; border-radius: 8px 0 0 8px; }
  .mark { display: grid; place-items: center; width: 20px; height: 18px; border: 1px solid #ffffffa8; border-radius: 4px; font-size: 12px; }
  :host([data-enabled]) .mark { color: #172024; background: #a9ead3; border-color: #a9ead3; }
  .settings { display: grid; place-items: center; border-left: 1px solid #ffffff1c !important; border-radius: 0 8px 8px 0; } .settings svg { width: 15px; height: 15px; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #a9ead3; outline-offset: 2px; }
  .captions,.layout-preview { position: absolute; left: 50%; bottom: max(10%, 46px); transform: translateX(-50%); width: 90%; text-align: center; color: #fff; font: 600 clamp(14px,3cqw,var(--wp-video-font,22px))/1.4 system-ui,sans-serif; text-shadow: 0 1px 3px #000,0 0 2px #000; }
  .captions,.layout-preview { display: flex; flex-direction: column; gap: 5px; }
  :host([data-original-below]) .source { order: 1; }
  .source,.translation { white-space: pre-line; overflow-wrap: anywhere; line-height: 1.4; }
  .source { font-size: min(var(--wp-source-size,.78em),var(--wp-caption-font-cap,48px)); font-family: var(--wp-source-family,system-ui,sans-serif); font-weight: var(--wp-source-weight,500); color: #f1f4f3; }
  .translation { font-size: min(var(--wp-translation-size,1em),var(--wp-caption-font-cap,48px)); font-family: var(--wp-translation-family,system-ui,sans-serif); font-weight: var(--wp-translation-weight,600); }
  .captions > .source,.captions > .translation { max-height: calc(var(--wp-caption-lines,2) * 1.4em); overflow: hidden; padding: 3px 0; box-sizing: content-box; }
  .source span,.translation span { background: var(--wp-video-bg,#101718bf); box-decoration-break: clone; -webkit-box-decoration-break: clone; padding: 3px 8px; border-radius: 4px; }
  .source:has(span:empty),.translation:has(span:empty) { display: none; }
  .panel { position: fixed; inset: auto; left: var(--wp-panel-left,12px); top: var(--wp-panel-top,60px); margin: 0; width: min(304px,calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; padding: 16px; border: 1px solid #ffffff26; border-radius: 12px; color: #f3f6f5; background: #172024f7; box-shadow: 0 12px 40px #0006; font: 13px/1.5 system-ui,sans-serif; pointer-events: auto; }
  .panel::backdrop { background: transparent; } .panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; } h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .close { color: #c7d2cf; background: none; border: 0; border-radius: 4px; padding: 0 5px; font-size: 21px; line-height: 24px; }
  .field { display: grid; gap: 5px; margin: 12px 0; color: #bacac5; font-size: 12px; }
  select { width: 100%; min-width: 0; height: 33px; color: #f3f6f5; background: #233135; border: 1px solid #50615e; border-radius: 6px; padding: 5px 8px; font-size: 13px; }
  .row { display: flex; gap: 12px; } .row > .field { flex: 1; min-width: 0; margin: 0; }
  .check { display: flex; align-items: center; gap: 8px; margin: 12px 0; font-size: 12px; } input[type=checkbox] { accent-color: #a9ead3; margin: 0; width: 14px; height: 14px; }
  .status { color: #bcd0c8; font-size: 12px; margin: 12px 0 0; overflow-wrap: anywhere; } :host([data-error]) .status { color: #ffcfaa; }
  .help { margin: 5px 0 0; color: #93a6a0; font-size: 11px; }
  .retry { margin-top: 10px; padding: 6px 12px; color: #15342b; border: 0; border-radius: 6px; background: #a9ead3; }
  details { margin-top: 12px; border-top: 1px solid #ffffff1f; padding-top: 10px; } summary { color: #c4d2cd; cursor: pointer; font-size: 12px; }
  .panel-action { margin-top: 10px; color: #e8f1ee; background: #233135; border: 1px solid #50615e; border-radius: 6px; padding: 6px 10px; }
  .offset { width: 100%; height: 32px; border: 1px solid #50615e; border-radius: 6px; background: #233135; color: #fff; padding: 5px 8px; }
  .notice { position: absolute; top: 58px; right: 14px; max-width: min(300px,calc(100% - 28px)); padding: 9px 12px; background: #172024ed; border: 1px solid #ffffff29; border-radius: 8px; color: #e4eeea; font: 12px/1.5 system-ui,sans-serif; pointer-events: auto; }
  :host([data-docked]) { position: relative !important; inset: auto !important; display: inline-flex !important; vertical-align: top !important; flex: 0 0 auto !important; width: auto !important; height: var(--wp-native-control-height,100%) !important; transform: translateY(var(--wp-native-control-offset,0px)) !important; pointer-events: inherit !important; container-type: normal !important; z-index: auto !important; }
  :host([data-docked]) .toolbar { position: static; height: 100%; background: transparent; border: 0; box-shadow: none; border-radius: 0; opacity: 1; transform: none; transition: none; pointer-events: inherit; }
  :host([data-docked]) .toolbar button { height: 100%; min-height: 0; min-width: 34px; padding: 0 7px; border-radius: 0; }
  :host([data-docked]) .settings { border-left: 0 !important; }
  .frame { display: grid; place-items: center; border-left: 1px solid #ffffff1c !important; } .frame svg { width: 16px; height: 16px; }
  .frame[aria-pressed=true] { color: #a9ead3; } .frame[aria-busy=true] { animation: frame-pulse 1s ease-in-out infinite alternate; }
  @keyframes frame-pulse { to { opacity: .5; } }
  .frame-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; } .frame-layer canvas { width: 100%; height: 100%; display: block; }
  :host([data-frame-visible]) .captions { visibility: hidden; }
  :host([data-capturing]) { visibility: hidden !important; }
  .frame-status { top: auto; bottom: 58px; }
  :host([data-native-hidden]) { pointer-events: none !important; }
  @media (prefers-reduced-motion: reduce) { .toolbar { transition: none; } .frame { animation: none !important; } }
  @media (pointer: coarse) { .toolbar button, :host([data-docked]) .toolbar button { min-width: 44px; min-height: 44px; } }
  ${VIDEO_LAYOUT_STYLES}
`;

export class VideoView {
  readonly host = document.createElement("div");
  readonly root = this.host.attachShadow({ mode: "open" });
  private readonly controlsHost = document.createElement("div");
  private readonly controlsRoot = this.controlsHost.attachShadow({ mode: "open" });
  readonly id = `wupage-player-${++nextView}`;
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly frameButton: HTMLButtonElement;
  private readonly frameLayer: HTMLElement;
  private readonly frameStatus: HTMLElement;
  private readonly mark: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly caption: HTMLElement;
  private readonly source: HTMLElement;
  private readonly translation: HTMLElement;
  private readonly status: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly layoutEditor: VideoLayoutEditor;
  private readonly presentation: SubtitlePresentation;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private frameStatusTimer?: ReturnType<typeof setTimeout>;
  private hasTranslation = false;
  private showOriginal = true;
  private controlOffset = 0;
  private cleanups: Array<() => void> = [];

  constructor(actions: VideoViewActions, label: string) {
    this.host.lang = t("interfaceLanguage");
    this.host.id = this.id; this.host.dataset.wupageVideo = ""; this.host.setAttribute("translate", "no");
    setHtmlContent(this.root, `<style>${styles}</style>
      <div class="frame-layer"></div>
      <div class="toolbar" role="group" aria-label="${htmlMessage("videoTranslation")}">
        <button class="toggle" type="button" aria-label="${htmlMessage("translateVideoSubtitles")}" aria-pressed="false" title="${htmlMessage("translateVideoSubtitles")}"><span class="mark" aria-hidden="true">${htmlMessage("translateBadge")}</span></button>
        <button class="frame" type="button" aria-label="${htmlMessage("pauseAndTranslateFrame")}" aria-pressed="false" title="${htmlMessage("pauseAndTranslateFrame")}">${uiIconMarkup("display")}</button>
        <button class="settings" type="button" aria-label="${htmlMessage("subtitleSettings")}" title="${htmlMessage("subtitleSettings")}" aria-expanded="false">${uiIconMarkup("settings")}</button>
      </div>
      <div class="captions" role="region" aria-label="${htmlMessage("bilingualSubtitles")}" hidden><div class="source" dir="auto"><span></span></div><div class="translation" dir="auto"><span></span></div></div>
      <section class="panel" popover="manual" aria-label="${htmlMessage("subtitleSettings")}" hidden>
        <header><h2>${htmlMessage("videoSubtitles")}</h2><button class="close" type="button" aria-label="${htmlMessage("closeSubtitleSettings")}">${uiIconMarkup("cross")}</button></header>
        <div class="row"><label class="field">${htmlMessage("translateTo")}<select class="target" aria-label="${htmlMessage("subtitleTargetLanguage")}"></select></label><label class="field">${htmlMessage("fontSize")}<select class="font" aria-label="${htmlMessage("subtitleFontSize")}"><option value="18">${htmlMessage("small")}</option><option value="22">${htmlMessage("mediumFontSize")}</option><option value="26">${htmlMessage("large")}</option></select></label></div>
        <label class="field">${htmlMessage("translationService")}<select class="provider" aria-label="${htmlMessage("subtitleTranslationService")}"></select></label>
        <label class="field">${htmlMessage("sourceSubtitles")}<select class="track" aria-label="${htmlMessage("sourceSubtitleLanguage")}"><option value="auto">${htmlMessage("followPlayer")}</option></select></label>
        <label class="check"><input class="original" type="checkbox" checked>${htmlMessage("showOriginal")}</label>
        <details><summary>${htmlMessage("subtitleAppearance")}</summary>
          <label class="field">${htmlMessage("order")}<select class="order" aria-label="${htmlMessage("originalAndTranslationOrder")}"><option value="above">${htmlMessage("originalOnTop")}</option><option value="below">${htmlMessage("translationOnTop")}</option></select></label>
          ${[ ["source", t("original")], ["translation", t("translation")] ].map(([key, label]) => `<div class="row">
            <label class="field">${htmlMessage("namedFontSize", label)}<select class="${key}-size" aria-label="${htmlMessage("namedFontSize", label)}"><option value="auto">${htmlMessage("useOverallFontSize")}</option>${[14,18,22,26,32,40,48].map(size => `<option value="${size}">${size}px</option>`).join("")}</select></label>
            <label class="field">${htmlMessage("font", label)}<select class="${key}-family" aria-label="${htmlMessage("font", label)}"><option value="sans-serif">${htmlMessage("sansSerif")}</option><option value="serif">${htmlMessage("serif")}</option><option value="monospace">${htmlMessage("monospace")}</option></select></label>
            <label class="field">${htmlMessage("fontWeight", label)}<select class="${key}-weight" aria-label="${htmlMessage("fontWeight", label)}"><option value="400">${htmlMessage("regular")}</option><option value="600">${htmlMessage("semibold")}</option><option value="700">${htmlMessage("bold")}</option></select></label>
          </div>`).join("")}
          <p class="help">${htmlMessage("longSubtitlesAdvanceWithPlaybackWithUpTo")}</p>
        </details>
        <label class="check"><input class="automatic" type="checkbox">${htmlMessage("enableAutomaticallyOnThisSite")}</label>
        <button class="layout-open panel-action" type="button">${uiIconMarkup("cursor-move")} ${htmlMessage("adjustSubtitleLayout")}</button>
        <p class="status" role="status"></p><button class="retry" type="button" hidden>${htmlMessage("retrySubtitles")}</button>
        <details><summary>${htmlMessage("moreOptions")}</summary>
          <label class="field">${htmlMessage("subtitleBackground")}<select class="background" aria-label="${htmlMessage("subtitleBackground")}"><option value="soft">${htmlMessage("translucent")}</option><option value="none">${htmlMessage("transparent")}</option></select></label>
          <label class="field">${htmlMessage("timeOffsetSeconds")}<input class="offset" type="number" min="-30" max="30" step="0.5" value="0" aria-label="${htmlMessage("subtitleTimeOffset")}"></label>
          <button class="import panel-action" type="button">${htmlMessage("importSrtVtt")}</button><input class="file" type="file" accept=".srt,.vtt" hidden>
          <p class="help">${htmlMessage("onlySubtitleTextIsTranslatedNoAudioIs")}</p>
        </details>
      </section><div class="notice" role="status" hidden></div><div class="notice frame-status" role="status" hidden></div>`);
    const query = <T extends Element>(selector: string) => this.root.querySelector<T>(selector)!;
    this.panel = query(".panel"); this.toggle = query(".toggle"); this.toolbar = query(".toolbar"); this.settingsButton = query(".settings"); this.caption = query(".captions");
    this.mark = query(".mark");
    this.frameButton = query(".frame"); this.frameLayer = query(".frame-layer"); this.frameStatus = query(".frame-status");
    this.controlsHost.id = `${this.id}-toolbar`; this.controlsHost.dataset.wupageVideoToolbar = this.id;
    this.controlsHost.setAttribute("data-docked", ""); this.controlsHost.setAttribute("translate", "no");
    setHtmlContent(this.controlsRoot, `<style>${styles}</style>`);
    this.source = query(".source span"); this.translation = query(".translation span"); this.status = query(".status"); this.notice = query(".notice"); this.retry = query(".retry");
    this.presentation = new SubtitlePresentation(this.host, this.caption);
    this.layoutEditor = new VideoLayoutEditor(this.host, this.caption, actions.layout, () => {
      this.setControls(true); this.settingsButton.focus();
    });
    this.on(query(".layout-open"), "click", () => { this.setPanel(false); this.layoutEditor.begin(); });
    const target = query<HTMLSelectElement>(".target");
    target.replaceChildren(...TARGET_LANGUAGES.map(language => new Option(language.label, language.code)));
    this.on(this.toggle, "click", () => actions.toggle());
    this.on(this.frameButton, "click", () => { this.layoutEditor.cancel(); actions.frame(); });
    this.on(this.settingsButton, "click", () => this.setPanel(this.panel.hidden));
    this.on(query(".close"), "click", () => this.setPanel(false));
    this.on(this.retry, "click", () => actions.retry());
    this.on(target, "change", () => actions.settings({ targetLang: target.value }));
    const provider = query<HTMLSelectElement>(".provider");
    this.on(provider, "change", () => actions.settings({ activeProviderId: provider.value }));
    const track = query<HTMLSelectElement>(".track"); this.on(track, "change", () => actions.source(track.value));
    const font = query<HTMLSelectElement>(".font"); this.on(font, "change", () => {
      const layout = this.layoutEditor.siteLayout;
      if (layout) void actions.layout({ ...layout, fontSize: Number(font.value) }).catch(() => {});
      else actions.preferences({ fontSize: Number(font.value) as 18 | 22 | 26 });
    });
    const original = query<HTMLInputElement>(".original"); this.on(original, "change", () => actions.preferences({ showOriginal: original.checked }));
    const order = query<HTMLSelectElement>(".order"); this.on(order, "change", () => actions.preferences({ originalPosition: order.value as "above" | "below" }));
    for (const key of ["source", "translation"] as const) {
      const size = query<HTMLSelectElement>(`.${key}-size`), family = query<HTMLSelectElement>(`.${key}-family`), weight = query<HTMLSelectElement>(`.${key}-weight`);
      const update = () => actions.preferences({ [key === "source" ? "sourceStyle" : "translationStyle"]: {
        ...(size.value !== "auto" ? { fontSize: Number(size.value) } : {}), fontFamily: family.value, fontWeight: Number(weight.value)
      } });
      for (const control of [size, family, weight]) this.on(control, "change", update);
    }
    const background = query<HTMLSelectElement>(".background"); this.on(background, "change", () => actions.preferences({ background: background.value as "soft" | "none" }));
    const automatic = query<HTMLInputElement>(".automatic"); this.on(automatic, "change", () => actions.preferences({ enabledSites: automatic.checked ? [label] : [] }));
    const file = query<HTMLInputElement>(".file"); this.on(query(".import"), "click", () => file.click());
    this.on(file, "change", () => { if (file.files?.[0]) actions.import(file.files[0]); file.value = ""; });
    const offset = query<HTMLInputElement>(".offset"); this.on(offset, "change", () => {
      const value = Number(offset.value);
      if (Number.isFinite(value)) { offset.value = String(Math.max(-30, Math.min(30, value))); actions.offset(Number(offset.value)); }
      else offset.value = "0";
    });
    for (const root of [this.root, this.controlsRoot]) {
      this.on(root, "keydown", (event: Event) => { event.stopPropagation(); if ((event as KeyboardEvent).key === "Escape") { this.layoutEditor.cancel(); this.setPanel(false); this.toggle.focus(); } });
      this.on(root, "click", event => event.stopPropagation());
    }
    this.on(document, "pointerdown", event => { if (!this.panel.hidden && !event.composedPath().some(node => node === this.host || node === this.controlsHost)) this.setPanel(false); }, true);
  }

  private on(target: EventTarget, type: string, callback: EventListener, capture = false): void {
    target.addEventListener(type, callback, capture); this.cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  setControls(show: boolean): void { this.host.toggleAttribute("data-controls", show); }
  focus(): void { this.setControls(true); this.toggle.focus(); }
  get panelOpen(): boolean { return !this.panel.hidden || this.layoutEditor.editing; }
  resizeLayout(): void { this.layoutEditor.resize(); }

  setFrameCapturing(hidden: boolean): void {
    this.host.toggleAttribute("data-capturing", hidden); this.controlsHost.toggleAttribute("data-capturing", hidden);
  }

  showFrame(canvas: HTMLCanvasElement): void { this.frameLayer.replaceChildren(canvas); }

  setFrameState(phase: "idle" | "loading" | "active" | "original", message = ""): void {
    clearTimeout(this.frameStatusTimer); this.frameStatusTimer = undefined;
    const active = phase === "active";
    this.host.toggleAttribute("data-frame-visible", active);
    this.frameButton.setAttribute("aria-pressed", String(active));
    this.frameButton.setAttribute("aria-busy", String(phase === "loading"));
    const label = phase === "loading" ? t("cancelFrameTranslation") : active ? t("showOriginalFrame") : phase === "original" ? t("showTranslatedFrame") : t("pauseAndTranslateFrame");
    this.frameButton.title = label; this.frameButton.setAttribute("aria-label", label);
    this.setText(this.frameStatus, message); this.frameStatus.hidden = !message;
    if (message) {
      this.setControls(true);
      if (phase !== "loading") this.frameStatusTimer = setTimeout(() => {
        this.frameStatus.hidden = true; this.setText(this.frameStatus, ""); this.frameStatusTimer = undefined;
      }, NOTICE_DURATION_MS);
    }
  }

  mountControls(container?: HTMLElement, before?: Element, reference?: Element): void {
    if (container) {
      if (this.toolbar.parentNode !== this.controlsRoot) this.controlsRoot.append(this.toolbar);
      if (this.controlsHost.parentElement !== container) container.insertBefore(this.controlsHost, before ?? null);
      this.alignControls(reference);
    } else {
      if (this.toolbar.parentNode !== this.root) this.root.prepend(this.toolbar);
      this.controlsHost.remove();
    }
  }

  avoidControlOverlap(obstacles: readonly DOMRect[]): void {
    const bounds = this.host.getBoundingClientRect();
    const scaleX = bounds.width / (this.host.offsetWidth || bounds.width || 1);
    const scaleY = bounds.height / (this.host.offsetHeight || bounds.height || 1);
    const height = this.toolbar.offsetHeight;
    const right = bounds.right - 14 * scaleX, left = right - this.toolbar.offsetWidth * scaleX;
    let top = 14;
    for (const obstacle of [...obstacles].sort((a, b) => a.top - b.top)) {
      if (left < obstacle.right && right > obstacle.left && bounds.top + top * scaleY < obstacle.bottom
        && bounds.top + (top + height) * scaleY > obstacle.top) top = (obstacle.bottom - bounds.top) / scaleY + 8;
    }
    const value = `${Math.min(top, Math.max(14, bounds.height / (scaleY || 1) - height - 14))}px`;
    if (this.host.style.getPropertyValue("--wp-toolbar-top") !== value) this.host.style.setProperty("--wp-toolbar-top", value);
  }

  private alignControls(reference?: Element): void {
    if (!reference) {
      this.controlsHost.style.removeProperty("--wp-native-control-height");
      this.controlsHost.style.removeProperty("--wp-native-control-offset");
      this.controlOffset = 0;
      return;
    }
    // Match the actual button, not its taller row or popover wrapper. Layout
    // height stays unscaled; the final center correction also handles scaled players.
    const height = reference instanceof HTMLElement ? reference.offsetHeight : 0;
    if (!height) return; // A hidden bar will be measured when it becomes visible.
    const value = `${height}px`;
    if (this.controlsHost.style.getPropertyValue("--wp-native-control-height") !== value) this.controlsHost.style.setProperty("--wp-native-control-height", value);
    const source = reference.getBoundingClientRect(), target = this.controlsHost.getBoundingClientRect();
    if (!source.height || !target.height) return;
    const scale = target.height / (this.controlsHost.offsetHeight || target.height);
    const offset = Math.round((this.controlOffset + (source.top + source.height / 2 - target.top - target.height / 2) / scale) * 1000) / 1000;
    if (offset !== this.controlOffset) {
      this.controlsHost.style.setProperty("--wp-native-control-offset", `${offset}px`);
      this.controlOffset = offset;
    }
  }

  setNativeControlsVisible(visible: boolean): void {
    this.controlsHost.toggleAttribute("data-native-hidden", !visible);
    if (this.controlsHost.inert !== !visible) this.controlsHost.inert = !visible;
  }

  setPanel(open: boolean): void {
    if (open === !this.panel.hidden) return;
    if (open) {
      this.layoutEditor.cancel();
      this.panel.hidden = false;
      this.positionPanel();
      try { this.panel.showPopover?.(); } catch { /* Fallback works in older embedded viewers. */ }
    } else {
      try { this.panel.hidePopover?.(); } catch { /* The panel may be outside the top layer after navigation. */ }
      this.panel.hidden = true;
    }
    this.host.toggleAttribute("data-panel", open);
    this.settingsButton.setAttribute("aria-expanded", String(open));
  }

  positionPanel(): void {
    const button = this.toggle.getBoundingClientRect();
    const width = Math.min(304, innerWidth - 24);
    const height = Math.min(this.panel.scrollHeight || 430, innerHeight - 24);
    const top = this.controlsHost.isConnected ? button.top - height - 8 : button.bottom + 8;
    this.panel.style.setProperty("--wp-panel-left", `${Math.max(12, Math.min(innerWidth - width - 12, button.right - width))}px`);
    this.panel.style.setProperty("--wp-panel-top", `${Math.max(12, Math.min(innerHeight - height - 12, top))}px`);
  }

  setState(enabled: boolean, phase: "idle" | "loading" | "active" | "waiting" | "error", message: string): void {
    this.host.toggleAttribute("data-enabled", enabled); this.host.toggleAttribute("data-error", phase === "error");
    this.host.toggleAttribute("data-waiting", enabled && phase === "waiting");
    this.controlsHost.toggleAttribute("data-enabled", enabled);
    if (!enabled || phase === "loading") this.hasTranslation = false;
    this.updateMark();
    this.toggle.setAttribute("aria-pressed", String(enabled));
    this.toggle.title = !enabled ? t("translateVideoSubtitles") : phase === "loading" ? t("readingSubtitlesClickToStopTranslation") : phase === "error" ? t("subtitlesNeedARetryClickToStopTranslation") : phase === "waiting" ? t("waitingForSourceSubtitlesClickToStopTranslation") : this.hasTranslation ? t("enabledClickToStopSubtitleTranslation", this.showOriginal ? t("bilingualSubtitles") : t("translationOnly")) : t("translatingSubtitlesClickToStop");
    this.toggle.setAttribute("aria-label", this.toggle.title);
    this.setText(this.status, message); this.retry.hidden = !enabled || !["waiting", "error"].includes(phase);
  }

  settings(settings: ExtensionSettings, site: string): void {
    const preferences = normalizeVideoTranslation(settings.videoTranslation);
    this.showOriginal = preferences.showOriginal; this.updateMark();
    const target = this.root.querySelector<HTMLSelectElement>(".target")!;
    if (![...target.options].some(option => option.value === settings.targetLang)) target.add(new Option(settings.targetLang, settings.targetLang));
    target.value = settings.targetLang;
    const provider = this.root.querySelector<HTMLSelectElement>(".provider")!;
    const signature = JSON.stringify(settings.providers.filter(entry => entry.enabled !== false).map(entry => [entry.id, entry.label]));
    if (provider.dataset.options !== signature) {
      provider.replaceChildren(...settings.providers.filter(entry => entry.enabled !== false).map(entry => new Option(entry.label, entry.id)));
      provider.dataset.options = signature;
    }
    provider.value = settings.activeProviderId;
    const fontSize = this.layoutEditor.settings(preferences);
    const font = this.root.querySelector<HTMLSelectElement>(".font")!;
    for (const option of [...font.options]) if (!["18", "22", "26"].includes(option.value)) option.remove();
    if (![...font.options].some(option => option.value === String(fontSize))) font.add(new Option(`${fontSize} px`, String(fontSize)));
    font.value = String(fontSize);
    this.root.querySelector<HTMLSelectElement>(".background")!.value = preferences.background;
    this.root.querySelector<HTMLInputElement>(".original")!.checked = preferences.showOriginal;
    this.root.querySelector<HTMLInputElement>(".automatic")!.checked = preferences.enabledSites.includes(site);
    this.host.style.setProperty("--wp-video-font", `${preferences.fontSize}px`);
    this.host.style.setProperty("--wp-video-bg", preferences.background === "soft" ? "#101718bf" : "transparent");
    this.host.toggleAttribute("data-original-below", preferences.originalPosition === "below");
    for (const key of ["source", "translation"] as const) {
      const style = preferences[key === "source" ? "sourceStyle" : "translationStyle"];
      const size = this.root.querySelector<HTMLSelectElement>(`.${key}-size`)!;
      if (style?.fontSize && ![...size.options].some(option => option.value === String(style.fontSize))) size.add(new Option(`${style.fontSize}px`, String(style.fontSize)));
      size.value = style?.fontSize ? String(style.fontSize) : "auto";
      this.root.querySelector<HTMLSelectElement>(`.${key}-family`)!.value = style?.fontFamily ?? "sans-serif";
      this.root.querySelector<HTMLSelectElement>(`.${key}-weight`)!.value = String(style?.fontWeight ?? (key === "source" ? 400 : 600));
      for (const [name, value] of [["size", style?.fontSize ? `${style.fontSize}px` : ""], ["family", style?.fontFamily ?? ""], ["weight", style ? String(style.fontWeight) : ""]]) {
        if (value) this.host.style.setProperty(`--wp-${key}-${name}`, value);
        else this.host.style.removeProperty(`--wp-${key}-${name}`);
      }
    }
  }

  tracks(tracks: Array<{ id: string; label: string }>, selected = "auto"): void {
    const select = this.root.querySelector<HTMLSelectElement>(".track")!;
    select.replaceChildren(new Option(t("followPlayer"), "auto"), ...tracks.map(track => new Option(track.label, track.id)));
    select.value = [...select.options].some(option => option.value === selected) ? selected : "auto";
  }

  render(source: string, translation: string, preferences: VideoTranslationSettings, progress = 0): { source: string; translation: string } {
    this.showOriginal = preferences.showOriginal;
    if (translation) this.hasTranslation = true;
    this.updateMark();
    // Keep current speech readable while a provider is slow. Never freeze the
    // previous translated page just because the next result has not arrived.
    const page = this.presentation.current((preferences.showOriginal || !translation) && source !== translation ? source : "", translation, progress);
    const shownSource = page.source;
    translation = page.translation;
    const changed = this.source.textContent !== shownSource || this.translation.textContent !== translation;
    this.setText(this.source, shownSource);
    this.setText(this.translation, translation);
    this.caption.hidden = !translation && !shownSource;
    if (changed) this.layoutEditor.refresh();
    return page;
  }

  private updateMark(): void {
    this.setText(this.mark, this.hasTranslation && this.host.hasAttribute("data-enabled") ? (this.showOriginal ? t("bilingualSubtitleBadge") : t("singleSubtitleBadge")) : t("translateBadge"));
    this.caption.setAttribute("aria-label", this.showOriginal ? t("bilingualSubtitles") : t("translatedSubtitles"));
  }

  tell(message: string): void {
    clearTimeout(this.noticeTimer); this.setControls(true); this.notice.hidden = false; this.setText(this.notice, message);
    this.noticeTimer = setTimeout(() => { this.notice.hidden = true; }, NOTICE_DURATION_MS);
  }

  private setText(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
  dispose(): void {
    this.setPanel(false); clearTimeout(this.noticeTimer); clearTimeout(this.frameStatusTimer);
    this.layoutEditor.dispose();
    for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; this.controlsHost.remove(); this.host.remove();
  }
}
