import { DEFAULT_VIDEO_LAYOUT, normalizeVideoLayout, type VideoSubtitleLayout, type VideoTranslationSettings } from "../shared/video";
import { setHtmlContent } from "../shared/html";
import { uiIconMarkup } from "../shared/ui-icons";

export const VIDEO_LAYOUT_STYLES = `
  .layout-editor { position: absolute; inset: 0; pointer-events: none; }
  .layout-preview { outline: 2px solid #a9ead3; border-radius: 5px; background: #17202480; cursor: move; pointer-events: auto; touch-action: none; user-select: none; }
  .layout-preview:focus-visible { outline: 3px solid #fff; }
  .layout-panel { position: fixed; inset: auto; z-index: 2; margin: 0; width: min(340px,calc(100vw - 20px)); max-height: calc(100vh - 20px); overflow: auto; padding: 12px; border: 1px solid #ffffff40; border-radius: 10px; background: #172024f7; color: #f3f6f5; font: 12px/1.5 system-ui,sans-serif; pointer-events: auto; }
  .layout-panel::backdrop { background: transparent; }
  .layout-panel p { margin: 0 0 8px; }
  .layout-panel label { display: grid; grid-template-columns: 34px 1fr 42px; align-items: center; gap: 8px; margin: 8px 0; }
  .layout-panel input { width: 100%; min-width: 0; accent-color: #a9ead3; }
  .layout-panel output { text-align: right; }
  .layout-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .layout-actions button { border: 1px solid #50615e; border-radius: 5px; padding: 6px 10px; background: #233135; color: #fff; min-height: 32px; }
  .layout-actions .layout-done { background: #a9ead3; color: #172024; border-color: #a9ead3; }
  .layout-error { color: #ffcfaa; margin-top: 6px !important; }
  .layout-handle { position: absolute; top: 0; bottom: 0; width: 20px; min-height: 32px; border: 0; padding: 0; background: #a9ead355; color: #fff; cursor: ew-resize; touch-action: none; }
  .layout-left { left: -8px; border-radius: 4px 0 0 4px; } .layout-right { right: -8px; border-radius: 0 4px 4px 0; }
  .layout-preview svg { width: 18px; height: 18px; }
  :host([data-layout-editing]) .captions { visibility: hidden; }
  .captions[data-custom-layout], .layout-preview { font-size: var(--wp-video-font,22px); }
`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
const setStyle = (element: HTMLElement, name: string, value: string) => {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
};

/** Display bounds never replace the saved proportions when a player shrinks. */
export function subtitleLayoutBounds(layout: VideoSubtitleLayout, width: number, height: number, captionHeight: number) {
  const margin = Math.min(8, width * .02, height * .02);
  const captionWidth = width * layout.width / 100;
  return {
    width: captionWidth,
    x: clamp(width * layout.x / 100, margin + captionWidth / 2, width - margin - captionWidth / 2),
    bottom: clamp(height * layout.bottom / 100, margin, height - captionHeight - margin)
  };
}

export class VideoLayoutEditor {
  private readonly editor = document.createElement("div");
  private readonly preview: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly font: HTMLInputElement;
  private readonly width: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly observer?: ResizeObserver;
  private saved?: VideoSubtitleLayout;
  private fontSize = 22;
  private draft?: VideoSubtitleLayout;
  private busy = false;
  private revision = 0;
  private disposed = false;
  private dimensions = "";
  private drag?: { id: number; target: HTMLElement; mode: "move" | "left" | "right"; x: number; y: number;
    left: number; right: number; bottom: number; scaleX: number; scaleY: number; width: number; height: number };
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly host: HTMLElement, private readonly caption: HTMLElement,
    private readonly save: (layout: VideoSubtitleLayout) => Promise<void>, private readonly closed: () => void) {
    this.editor.className = "layout-editor"; this.editor.hidden = true;
    setHtmlContent(this.editor, `
      <div class="layout-preview" role="group" tabindex="0" aria-label="字幕位置，拖动或使用方向键移动，Shift 加速">
        <div class="source" dir="auto"><span></span></div><div class="translation" dir="auto"><span></span></div>
        <button class="layout-handle layout-left" type="button" aria-label="字幕左边界，拖动或使用左右方向键调整宽度">${uiIconMarkup("adjustment")}</button>
        <button class="layout-handle layout-right" type="button" aria-label="字幕右边界，拖动或使用左右方向键调整宽度">${uiIconMarkup("adjustment")}</button>
      </div>
      <section class="layout-panel" popover="manual" role="region" aria-label="调整字幕布局">
        <p><strong>调整字幕布局</strong> · 拖动字幕移动位置</p>
        <label>宽度<input class="layout-width" type="range" min="20" max="96" step="1" aria-label="字幕宽度"><output class="layout-width-value"></output></label>
        <label>字号<input class="layout-font" type="range" min="14" max="48" step="1" aria-label="布局字幕字号"><output class="layout-font-value"></output></label>
        <p class="help">左右手柄调宽；高度随文字换行。完成后记住此网站的布局，Esc 取消。</p>
        <div class="layout-actions"><button class="layout-done" type="button">完成</button><button class="layout-cancel" type="button">取消</button><button class="layout-reset" type="button">恢复默认</button></div>
        <p class="layout-error" role="status" hidden></p>
      </section>`);
    host.shadowRoot!.append(this.editor);
    this.preview = this.editor.querySelector(".layout-preview")!;
    this.panel = this.editor.querySelector(".layout-panel")!;
    this.font = this.editor.querySelector(".layout-font")!;
    this.width = this.editor.querySelector(".layout-width")!;
    this.error = this.editor.querySelector(".layout-error")!;
    this.on(this.font, "input", () => this.change({ fontSize: Number(this.font.value) }));
    this.on(this.width, "input", () => this.change({ width: Number(this.width.value) }));
    this.on(this.editor.querySelector(".layout-reset")!, "click", () => this.change({ ...DEFAULT_VIDEO_LAYOUT }));
    this.on(this.editor.querySelector(".layout-cancel")!, "click", () => this.cancel());
    this.on(this.editor.querySelector(".layout-done")!, "click", () => { void this.finish(); });
    this.on(this.preview, "pointerdown", event => this.pointerDown(event as PointerEvent));
    this.on(this.preview, "pointermove", event => this.pointerMove(event as PointerEvent));
    this.on(this.preview, "pointerup", event => this.pointerEnd(event as PointerEvent));
    this.on(this.preview, "pointercancel", event => this.pointerEnd(event as PointerEvent));
    this.on(this.preview, "lostpointercapture", () => { this.drag = undefined; });
    this.on(this.preview, "keydown", event => this.key(event as KeyboardEvent));
    // Stop player shortcuts and click-to-pause handlers only inside editor controls.
    for (const type of ["pointerdown", "pointermove", "pointerup", "click", "dblclick", "keydown"]) {
      this.on(this.editor, type, event => event.stopPropagation());
    }
    this.on(this.editor, "keydown", event => { if ((event as KeyboardEvent).key === "Escape") { event.preventDefault(); this.cancel(); } });
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.refresh());
      this.observer.observe(host); this.observer.observe(caption); this.observer.observe(this.preview);
    }
  }

  private on(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener); this.cleanups.push(() => target.removeEventListener(type, listener));
  }

  get editing(): boolean { return !!this.draft; }
  get siteLayout(): VideoSubtitleLayout | undefined { return this.saved && { ...this.saved }; }

  settings(preferences: VideoTranslationSettings): number {
    this.revision++;
    const saved = preferences.siteLayouts?.find(entry => entry.id === location.hostname);
    this.saved = saved ? normalizeVideoLayout(saved) : undefined;
    this.fontSize = preferences.fontSize;
    this.refresh();
    return this.saved?.fontSize ?? this.fontSize;
  }

  begin(): void {
    if (this.editing || this.busy || this.host.hidden) return;
    this.draft = this.saved ? { ...this.saved } : { ...DEFAULT_VIDEO_LAYOUT, fontSize: this.fontSize };
    const source = this.caption.querySelector(".source span")!.textContent;
    const translation = this.caption.querySelector(".translation span")!.textContent;
    this.preview.querySelector(".source span")!.textContent = source || (!translation ? "Drag to move subtitles. Resize to change wrapping." : "");
    this.preview.querySelector(".translation span")!.textContent = translation || "拖动调整字幕位置，拉动左右手柄调整宽度。";
    this.editor.hidden = false; this.host.setAttribute("data-layout-editing", "");
    this.error.hidden = true; this.sync();
    try { this.panel.showPopover?.(); } catch { /* Fixed panel also works without popover support. */ }
    this.preview.focus();
  }

  cancel(): void {
    if (!this.editing || this.busy) return;
    this.end();
  }

  private end(): void {
    try { this.panel.hidePopover?.(); } catch { /* Navigation may already have removed the top layer. */ }
    this.releasePointer(); this.draft = undefined; this.editor.hidden = true;
    this.host.removeAttribute("data-layout-editing"); this.refresh(); this.closed();
  }

  private async finish(): Promise<void> {
    if (!this.draft || this.busy) return;
    const layout = { ...this.draft }, revision = this.revision; this.busy = true; this.error.hidden = true;
    this.editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(control => { control.disabled = true; });
    try {
      await this.save(layout);
      if (!this.disposed) { if (revision === this.revision) this.saved = layout; this.busy = false; this.end(); }
    } catch {
      if (!this.disposed) { this.error.textContent = "布局未保存，请重试或取消。"; this.error.hidden = false; }
    } finally {
      this.busy = false;
      this.editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(control => { control.disabled = false; });
    }
  }

  private change(patch: Partial<VideoSubtitleLayout>): void {
    if (!this.draft || this.busy) return;
    this.draft = normalizeVideoLayout({ ...this.draft, ...patch }); this.sync();
  }

  private sync(): void {
    if (!this.draft) return;
    this.width.value = String(this.draft.width); this.font.value = String(this.draft.fontSize);
    this.editor.querySelector(".layout-width-value")!.textContent = `${this.draft.width}%`;
    this.editor.querySelector(".layout-font-value")!.textContent = `${this.draft.fontSize}px`;
    this.refresh();
  }

  resize(): void {
    if (this.host.hidden) { this.cancel(); return; }
    const dimensions = `${this.host.style.getPropertyValue("--wp-layer-width")}/${this.host.style.getPropertyValue("--wp-layer-height")}`;
    if (dimensions !== this.dimensions) { this.dimensions = dimensions; this.refresh(); }
    if (this.editing) this.positionPanel();
  }

  private size(): { width: number; height: number } {
    return { width: this.host.clientWidth || parseFloat(this.host.style.getPropertyValue("--wp-layer-width")) || 0,
      height: this.host.clientHeight || parseFloat(this.host.style.getPropertyValue("--wp-layer-height")) || 0 };
  }

  refresh(): void {
    if (this.disposed) return;
    const size = this.size();
    if (!size.width || !size.height) return;
    this.place(this.caption, this.saved ?? { ...DEFAULT_VIDEO_LAYOUT, fontSize: this.fontSize }, size, !!this.saved);
    if (this.draft) this.place(this.preview, this.draft, size, true);
    if (this.editing) this.positionPanel();
  }

  private positionPanel(): void {
    const rect = this.host.getBoundingClientRect(), height = this.panel.offsetHeight || 210, width = Math.min(340, innerWidth - 20);
    // Prefer space outside a small player so its preview remains draggable.
    const top = innerHeight - rect.bottom >= height + 10 ? rect.bottom + 8
      : rect.top >= height + 10 ? rect.top - height - 8 : rect.top + 10;
    setStyle(this.panel, "left", `${clamp(rect.left + 10, 10, innerWidth - width - 10)}px`);
    setStyle(this.panel, "top", `${clamp(top, 10, innerHeight - height - 10)}px`);
  }

  private place(element: HTMLElement, layout: VideoSubtitleLayout, size: { width: number; height: number }, custom: boolean): void {
    element.toggleAttribute("data-custom-layout", custom);
    setStyle(element, "--wp-video-font", `${layout.fontSize}px`);
    setStyle(element, "width", `${layout.width}%`);
    const effective = custom ? layout : { ...layout, bottom: Math.max(layout.bottom, Math.min(46 / size.height * 100, 25)) };
    const bounds = subtitleLayoutBounds(effective, size.width, size.height, element.offsetHeight);
    setStyle(element, "left", `${bounds.x}px`); setStyle(element, "bottom", `${bounds.bottom}px`);
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.draft || this.busy || event.button !== 0 || this.drag || event.isPrimary === false) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".layout-handle") ?? this.preview : this.preview;
    const host = this.host.getBoundingClientRect(), rect = this.preview.getBoundingClientRect(), size = this.size();
    if (!host.width || !host.height || !size.width || !size.height) return;
    event.preventDefault(); target.focus();
    this.drag = { id: event.pointerId, target, mode: target.classList.contains("layout-left") ? "left" : target.classList.contains("layout-right") ? "right" : "move",
      x: event.clientX, y: event.clientY, left: (rect.left - host.left) * size.width / host.width,
      right: (rect.right - host.left) * size.width / host.width, bottom: (host.bottom - rect.bottom) * size.height / host.height,
      scaleX: size.width / host.width, scaleY: size.height / host.height, ...size };
    target.setPointerCapture?.(event.pointerId);
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || !this.draft || event.pointerId !== drag.id) return;
    event.preventDefault();
    const dx = (event.clientX - drag.x) * drag.scaleX, dy = (event.clientY - drag.y) * drag.scaleY;
    if (drag.mode === "move") {
      const desired = { ...this.draft, x: ((drag.left + drag.right) / 2 + dx) / drag.width * 100, bottom: (drag.bottom - dy) / drag.height * 100 };
      const bounds = subtitleLayoutBounds(desired, drag.width, drag.height, this.preview.offsetHeight);
      this.change({ x: bounds.x / drag.width * 100, bottom: bounds.bottom / drag.height * 100 });
    } else {
      const min = drag.width * .2, max = drag.width * .96, margin = Math.min(8, drag.width * .02, drag.height * .02);
      const left = drag.mode === "left" ? clamp(drag.left + dx, Math.max(margin, drag.right - max), drag.right - min) : drag.left;
      const right = drag.mode === "right" ? clamp(drag.right + dx, drag.left + min, Math.min(drag.width - margin, drag.left + max)) : drag.right;
      this.change({ width: (right - left) / drag.width * 100, x: (left + right) / 2 / drag.width * 100 });
    }
  }

  private pointerEnd(event: PointerEvent): void { if (event.pointerId === this.drag?.id) this.releasePointer(); }
  private releasePointer(): void {
    const drag = this.drag; this.drag = undefined;
    if (drag?.target.hasPointerCapture?.(drag.id)) drag.target.releasePointerCapture(drag.id);
  }

  private key(event: KeyboardEvent): void {
    if (!this.draft || this.busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    if (event.target instanceof Element && event.target.closest(".layout-handle")) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction = event.target.closest(".layout-left") ? -1 : 1;
        this.change({ width: this.draft.width + (event.key === "ArrowRight" ? step : -step) * direction });
      }
    } else this.change({ x: this.draft.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      bottom: this.draft.bottom + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0) });
  }

  dispose(): void {
    this.disposed = true; this.releasePointer(); this.observer?.disconnect();
    try { this.panel.hidePopover?.(); } catch { /* Disconnected during player replacement. */ }
    for (const cleanup of this.cleanups) cleanup();
    this.editor.remove();
  }
}
