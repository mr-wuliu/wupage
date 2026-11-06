import { findTranslatableParagraph } from "./dom";
import { queryTranslationElements } from "./dom-roots";
import { translateParagraph } from "./paragraph-translation";
import { setHtmlContent } from "../shared/html";
import { uiIconMarkup } from "../shared/ui-icons";
import { visibleViewport } from "../shared/touch";

const HOST_ID = "wupage-touch-paragraph";
const EXCLUDED = "a,button,input,textarea,select,label,summary,[contenteditable]:not([contenteditable='false']),[role='button'],[role='link'],[role='textbox'],[role='slider'],[role='checkbox'],[role='radio'],[role='switch'],[role='combobox'],[role='menuitem'],[role='tab'],[draggable='true'],img,video,audio,canvas,svg,iframe,#wupage-touch-paragraph,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-image-tools,#wupage-selection-tools,#wupage-debug-panel";

function excludesEvent(event: Event): boolean {
  return event.composedPath().some(node => node instanceof Element && node.matches(EXCLUDED));
}

/** A one-shot page action, deliberately separate from the saved Ctrl-click preference. */
export class TouchParagraphController {
  private host?: HTMLElement;
  private message?: HTMLElement;
  private timer?: number;
  private active = false;
  private startPoint?: { id: number; x: number; y: number; target: Element };
  private moved = false;
  private version = 0;

  start(): void {
    this.close();
    this.active = true;
    const host = this.host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("translate", "no");
    host.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483647!important;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box}section{display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;border:1px solid var(--wp-border,#c9d1cf);border-radius:12px;background:var(--wp-surface,#fff);color:var(--wp-foreground,#172026);box-shadow:0 6px 24px #0003;font:14px/1.5 system-ui,sans-serif}
      p{flex:1;min-width:0;margin:0;overflow-wrap:anywhere}button{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:8px;background:var(--wp-soft,#eef2f1);color:inherit;touch-action:manipulation;user-select:none;-webkit-user-select:none}button:focus-visible{outline:2px solid var(--wp-accent,#116466)}svg{width:18px;height:18px}
    `;
    const bar = document.createElement("section");
    bar.setAttribute("aria-label", "点选段落翻译");
    this.message = document.createElement("p");
    this.message.setAttribute("role", "status");
    this.message.textContent = "点选要翻译的段落，完成后自动退出。";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "取消点选段落");
    setHtmlContent(cancel, uiIconMarkup("cross"));
    cancel.addEventListener("click", () => this.close());
    bar.append(this.message, cancel); root.append(style, bar); document.documentElement.append(host);
    this.position();
    document.addEventListener("pointerdown", this.pointerDown, true);
    document.addEventListener("pointermove", this.pointerMove, { capture: true, passive: true });
    document.addEventListener("pointercancel", this.pointerCancel, true);
    document.addEventListener("click", this.click, true);
    document.addEventListener("scroll", this.pointerCancel, { capture: true, passive: true });
    document.addEventListener("keydown", this.keyDown, true);
    document.addEventListener("fullscreenchange", this.close);
    window.addEventListener("pagehide", this.close);
    window.addEventListener("popstate", this.close);
    window.addEventListener("hashchange", this.close);
    window.addEventListener("resize", this.position);
    window.visualViewport?.addEventListener("resize", this.position);
    window.visualViewport?.addEventListener("scroll", this.position);
  }

  close = (): void => {
    this.version++;
    this.active = false;
    this.startPoint = undefined;
    window.clearTimeout(this.timer);
    this.host?.remove(); this.host = undefined; this.message = undefined;
    document.removeEventListener("pointerdown", this.pointerDown, true);
    document.removeEventListener("pointermove", this.pointerMove, true);
    document.removeEventListener("pointercancel", this.pointerCancel, true);
    document.removeEventListener("click", this.click, true);
    document.removeEventListener("scroll", this.pointerCancel, true);
    document.removeEventListener("keydown", this.keyDown, true);
    document.removeEventListener("fullscreenchange", this.close);
    window.removeEventListener("pagehide", this.close);
    window.removeEventListener("popstate", this.close);
    window.removeEventListener("hashchange", this.close);
    window.removeEventListener("resize", this.position);
    window.visualViewport?.removeEventListener("resize", this.position);
    window.visualViewport?.removeEventListener("scroll", this.position);
  };

  private position = (): void => {
    if (!this.host) return;
    const view = visibleViewport(), width = Math.max(0, Math.min(420, view.width - 24));
    this.host.style.setProperty("width", `${width}px`, "important");
    this.host.style.setProperty("left", `${view.left + (view.width - width) / 2}px`, "important");
    this.host.style.setProperty("top", `${view.top + 12}px`, "important");
  };

  private pointerDown = (event: PointerEvent): void => {
    this.startPoint = undefined;
    this.moved = false;
    if (!this.active || event.isPrimary === false || event.button > 0) return;
    const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (!target || excludesEvent(event)) return;
    this.startPoint = { id: event.pointerId, x: event.clientX, y: event.clientY, target };
  };

  private pointerMove = (event: PointerEvent): void => {
    const start = this.startPoint;
    if (start && event.pointerId === start.id && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) this.moved = true;
  };
  private pointerCancel = (): void => { this.startPoint = undefined; };
  private keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); this.close(); }
  };

  private click = (event: MouseEvent): void => {
    const start = this.startPoint;
    this.startPoint = undefined;
    if (!this.active || !start || this.moved || event.button !== 0) return;
    const element = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (!element || excludesEvent(event) || !(element === start.target || element.contains(start.target) || start.target.contains(element))) return;
    const translationId = element.closest(".wupage-translation")?.getAttribute("data-wupage-translation-target");
    const paragraph = translationId
      ? queryTranslationElements("[data-wupage-target-id]").find(target => target.getAttribute("data-wupage-target-id") === translationId)
      : findTranslatableParagraph(element);
    if (!paragraph) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Only this paragraph can be consumed, including while its request is pending.
    this.active = false;
    const version = this.version;
    this.host!.shadowRoot!.querySelector("button")!.setAttribute("aria-label", "关闭段落翻译状态");
    this.message!.textContent = "正在处理所选段落…";
    void translateParagraph(paragraph).then(() => {
      if (version !== this.version) return;
      this.message!.textContent = "已完成，再次点选此段可切换原文与译文。";
      this.timer = window.setTimeout(this.close, 2200);
    }).catch(error => {
      if (version !== this.version) return;
      this.message!.textContent = error instanceof Error ? error.message : "段落翻译失败，请重试。";
    });
  };
}

let controller: TouchParagraphController | undefined;
export function startTouchParagraph(): void {
  (controller ??= new TouchParagraphController()).start();
}
