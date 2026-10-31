import { TARGET_LANGUAGES } from "../shared/languages";
import type { ExtensionSettings } from "../shared/types";
import { normalizeVideoTranslation, type VideoTranslationSettings } from "../shared/video";
import { uiIconMarkup } from "../shared/ui-icons";

let nextView = 0;
export interface VideoViewActions {
  toggle: () => void;
  retry: () => void;
  source: (id: string) => void;
  settings: (patch: Partial<ExtensionSettings>) => void;
  preferences: (patch: Partial<VideoTranslationSettings>) => void;
  import: (file: File) => void;
  offset: (seconds: number) => void;
}

const styles = `
  :host { all: initial !important; position: absolute !important; top: var(--wp-layer-top,0px) !important; left: var(--wp-layer-left,0px) !important; width: var(--wp-layer-width,100%) !important; height: var(--wp-layer-height,100%) !important; z-index: 2147483600 !important; pointer-events: none !important; container-type: inline-size !important; color-scheme: dark !important; direction: ltr; } :host([hidden]) { display: none !important; }
  * { box-sizing: border-box; } [hidden] { display: none !important; }
  .toolbar { position: absolute; right: 14px; top: 14px; display: flex; gap: 1px; align-items: center; color: #fff; background: #172024eb; border: 1px solid #ffffff29; border-radius: 9px; box-shadow: 0 3px 12px #0003; opacity: 0; transform: translateY(-3px); transition: opacity .16s,transform .16s; pointer-events: none; }
  :host([data-controls]) .toolbar, .toolbar:hover, .toolbar:focus-within, :host([data-panel]) .toolbar, :host([data-error]) .toolbar, :host([data-waiting]) .toolbar { opacity: 1; transform: none; pointer-events: auto; }
  button, select, input { font: inherit; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
  .toolbar button { border: 0; color: inherit; background: transparent; min-height: 34px; padding: 7px 10px; font: 500 12px/20px system-ui,sans-serif; }
  .toolbar button:hover { background: #ffffff18; } .toggle { display: flex; gap: 7px; align-items: center; border-radius: 8px 0 0 8px; }
  .mark { display: grid; place-items: center; width: 20px; height: 18px; border: 1px solid #ffffffa8; border-radius: 4px; font-size: 12px; }
  :host([data-enabled]) .mark { color: #172024; background: #a9ead3; border-color: #a9ead3; }
  .settings { display: grid; place-items: center; border-left: 1px solid #ffffff1c !important; border-radius: 0 8px 8px 0; } .settings svg { width: 15px; height: 15px; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #a9ead3; outline-offset: 2px; }
  .captions { position: absolute; left: 50%; bottom: max(10%, 46px); transform: translateX(-50%); width: 90%; text-align: center; color: #fff; font: 600 clamp(14px,3cqw,var(--wp-video-font,22px))/1.4 system-ui,sans-serif; text-shadow: 0 1px 3px #000,0 0 2px #000; }
  .source,.translation { white-space: pre-line; overflow-wrap: anywhere; } .source { font-size: .78em; font-weight: 500; margin-bottom: 5px; color: #f1f4f3; }
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
  .import { margin-top: 10px; color: #e8f1ee; background: #233135; border: 1px solid #50615e; border-radius: 6px; padding: 6px 10px; }
  .offset { width: 100%; height: 32px; border: 1px solid #50615e; border-radius: 6px; background: #233135; color: #fff; padding: 5px 8px; }
  .notice { position: absolute; top: 58px; right: 14px; max-width: min(300px,calc(100% - 28px)); padding: 9px 12px; background: #172024ed; border: 1px solid #ffffff29; border-radius: 8px; color: #e4eeea; font: 12px/1.5 system-ui,sans-serif; pointer-events: auto; }
  @media (prefers-reduced-motion: reduce) { .toolbar { transition: none; } }
  @media (pointer: coarse) { .toolbar button { min-width: 44px; min-height: 44px; } }
`;

export class VideoView {
  readonly host = document.createElement("div");
  readonly root = this.host.attachShadow({ mode: "open" });
  readonly id = `wupage-player-${++nextView}`;
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly source: HTMLElement;
  private readonly translation: HTMLElement;
  private readonly status: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private cleanups: Array<() => void> = [];

  constructor(actions: VideoViewActions, label: string) {
    this.host.id = this.id; this.host.dataset.wupageVideo = ""; this.host.setAttribute("translate", "no");
    this.root.innerHTML = `<style>${styles}</style>
      <div class="toolbar" role="group" aria-label="视频字幕翻译">
        <button class="toggle" type="button" aria-pressed="false" title="翻译视频字幕"><span class="mark" aria-hidden="true">译</span><span class="label">字幕翻译</span></button>
        <button class="settings" type="button" aria-label="字幕设置" title="字幕设置" aria-expanded="false">${uiIconMarkup("settings")}</button>
      </div>
      <div class="captions" role="region" aria-label="双语字幕" hidden><div class="source" dir="auto"><span></span></div><div class="translation" dir="auto"><span></span></div></div>
      <section class="panel" popover="manual" aria-label="字幕设置" hidden>
        <header><h2>视频字幕</h2><button class="close" type="button" aria-label="关闭字幕设置">×</button></header>
        <div class="row"><label class="field">译为<select class="target" aria-label="字幕目标语言"></select></label><label class="field">字号<select class="font" aria-label="字幕字号"><option value="18">小</option><option value="22">中</option><option value="26">大</option></select></label></div>
        <label class="field">翻译服务<select class="provider" aria-label="字幕翻译服务"></select></label>
        <label class="field">原字幕<select class="track" aria-label="原字幕语言"><option value="auto">跟随播放器</option></select></label>
        <label class="check"><input class="original" type="checkbox" checked>显示原文</label>
        <label class="check"><input class="automatic" type="checkbox">在此网站自动开启</label>
        <p class="status" role="status"></p><button class="retry" type="button" hidden>重试读取</button>
        <details><summary>更多选项</summary>
          <label class="field">字幕背景<select class="background" aria-label="字幕背景"><option value="soft">半透明</option><option value="none">透明</option></select></label>
          <label class="field">时间偏移（秒）<input class="offset" type="number" min="-30" max="30" step="0.5" value="0" aria-label="字幕时间偏移"></label>
          <button class="import" type="button">导入 SRT / VTT</button><input class="file" type="file" accept=".srt,.vtt" hidden>
          <p class="help">仅翻译字幕文本，不采集音频。在线翻译使用所选服务的额度。</p>
        </details>
      </section><div class="notice" role="status" hidden></div>`;
    const query = <T extends Element>(selector: string) => this.root.querySelector<T>(selector)!;
    this.panel = query(".panel"); this.toggle = query(".toggle"); this.label = query(".label"); this.caption = query(".captions");
    this.source = query(".source span"); this.translation = query(".translation span"); this.status = query(".status"); this.notice = query(".notice"); this.retry = query(".retry");
    const target = query<HTMLSelectElement>(".target");
    target.replaceChildren(...TARGET_LANGUAGES.map(language => new Option(language.label, language.code)));
    this.on(this.toggle, "click", () => actions.toggle());
    this.on(query(".settings"), "click", () => this.setPanel(this.panel.hidden));
    this.on(query(".close"), "click", () => this.setPanel(false));
    this.on(this.retry, "click", () => actions.retry());
    this.on(target, "change", () => actions.settings({ targetLang: target.value }));
    const provider = query<HTMLSelectElement>(".provider");
    this.on(provider, "change", () => actions.settings({ activeProviderId: provider.value }));
    const track = query<HTMLSelectElement>(".track"); this.on(track, "change", () => actions.source(track.value));
    const font = query<HTMLSelectElement>(".font"); this.on(font, "change", () => actions.preferences({ fontSize: Number(font.value) as 18 | 22 | 26 }));
    const original = query<HTMLInputElement>(".original"); this.on(original, "change", () => actions.preferences({ showOriginal: original.checked }));
    const background = query<HTMLSelectElement>(".background"); this.on(background, "change", () => actions.preferences({ background: background.value as "soft" | "none" }));
    const automatic = query<HTMLInputElement>(".automatic"); this.on(automatic, "change", () => actions.preferences({ enabledSites: automatic.checked ? [label] : [] }));
    const file = query<HTMLInputElement>(".file"); this.on(query(".import"), "click", () => file.click());
    this.on(file, "change", () => { if (file.files?.[0]) actions.import(file.files[0]); file.value = ""; });
    const offset = query<HTMLInputElement>(".offset"); this.on(offset, "change", () => {
      const value = Number(offset.value);
      if (Number.isFinite(value)) { offset.value = String(Math.max(-30, Math.min(30, value))); actions.offset(Number(offset.value)); }
      else offset.value = "0";
    });
    this.on(this.root, "keydown", (event: Event) => { event.stopPropagation(); if ((event as KeyboardEvent).key === "Escape") { this.setPanel(false); this.toggle.focus(); } });
    this.on(this.root, "click", event => event.stopPropagation());
    this.on(document, "pointerdown", event => { if (!this.panel.hidden && !event.composedPath().includes(this.host)) this.setPanel(false); }, true);
  }

  private on(target: EventTarget, type: string, callback: EventListener, capture = false): void {
    target.addEventListener(type, callback, capture); this.cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  setControls(show: boolean): void { this.host.toggleAttribute("data-controls", show); }
  focus(): void { this.setControls(true); this.toggle.focus(); }
  get panelOpen(): boolean { return !this.panel.hidden; }

  setPanel(open: boolean): void {
    if (open === !this.panel.hidden) return;
    if (open) {
      this.panel.hidden = false;
      this.positionPanel();
      try { this.panel.showPopover?.(); } catch { /* Fallback works in older embedded viewers. */ }
    } else {
      try { this.panel.hidePopover?.(); } catch { /* The panel may be outside the top layer after navigation. */ }
      this.panel.hidden = true;
    }
    this.host.toggleAttribute("data-panel", open);
    this.root.querySelector(".settings")!.setAttribute("aria-expanded", String(open));
  }

  positionPanel(): void {
    const button = this.toggle.getBoundingClientRect();
    const width = Math.min(304, innerWidth - 24);
    this.panel.style.setProperty("--wp-panel-left", `${Math.max(12, Math.min(innerWidth - width - 12, button.right - width))}px`);
    this.panel.style.setProperty("--wp-panel-top", `${Math.max(12, Math.min(innerHeight - Math.min(this.panel.scrollHeight || 430, innerHeight - 24) - 12, button.bottom + 8))}px`);
  }

  setState(enabled: boolean, phase: "idle" | "loading" | "active" | "waiting" | "error", message: string): void {
    this.host.toggleAttribute("data-enabled", enabled); this.host.toggleAttribute("data-error", phase === "error");
    this.host.toggleAttribute("data-waiting", enabled && phase === "waiting");
    this.toggle.setAttribute("aria-pressed", String(enabled));
    this.toggle.title = enabled ? "停止字幕翻译" : "翻译视频字幕";
    this.setText(this.label, !enabled ? "字幕翻译" : phase === "loading" ? "读取字幕…" : phase === "error" ? "字幕需重试" : phase === "waiting" ? "等待原字幕" : "双语已开");
    this.setText(this.status, message); this.retry.hidden = !enabled || !["waiting", "error"].includes(phase);
  }

  settings(settings: ExtensionSettings, site: string): void {
    const preferences = normalizeVideoTranslation(settings.videoTranslation);
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
    this.root.querySelector<HTMLSelectElement>(".font")!.value = String(preferences.fontSize);
    this.root.querySelector<HTMLSelectElement>(".background")!.value = preferences.background;
    this.root.querySelector<HTMLInputElement>(".original")!.checked = preferences.showOriginal;
    this.root.querySelector<HTMLInputElement>(".automatic")!.checked = preferences.enabledSites.includes(site);
    this.host.style.setProperty("--wp-video-font", `${preferences.fontSize}px`);
    this.host.style.setProperty("--wp-video-bg", preferences.background === "soft" ? "#101718bf" : "transparent");
  }

  tracks(tracks: Array<{ id: string; label: string }>, selected = "auto"): void {
    const select = this.root.querySelector<HTMLSelectElement>(".track")!;
    select.replaceChildren(new Option("跟随播放器", "auto"), ...tracks.map(track => new Option(track.label, track.id)));
    select.value = [...select.options].some(option => option.value === selected) ? selected : "auto";
  }

  render(source: string, translation: string, preferences: VideoTranslationSettings): void {
    this.setText(this.source, preferences.showOriginal && source !== translation ? source : "");
    this.setText(this.translation, translation);
    this.caption.hidden = !translation;
  }

  tell(message: string): void {
    clearTimeout(this.noticeTimer); this.setControls(true); this.notice.hidden = false; this.setText(this.notice, message);
    this.noticeTimer = setTimeout(() => { this.notice.hidden = true; }, 5000);
  }

  private setText(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
  dispose(): void { this.setPanel(false); clearTimeout(this.noticeTimer); for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; this.host.remove(); }
}
