import { SETTINGS_KEY } from "../shared/defaults";
import { t } from "../shared/i18n";
import { inputTemplateLabel, inputTemplateProvider, normalizeInputTranslation, type InputTranslationTemplate } from "../shared/input-translation";
import { visibleViewport } from "../shared/touch";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";
import { inputDraftCaret } from "./input-caret";
import { sendRuntimeRequest } from "./runtime";
import { captureInputDraft, inputDraftFocused, replaceSelectionSource, selectionSourceUnchanged, type InputDraft } from "./selection-source";

const GESTURE_WINDOW = 750;
const STYLES = `
:host { all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none; color-scheme: var(--wp-color-scheme, light dark); }
.popup { box-sizing: border-box; position: fixed; width: max-content; overflow: auto; pointer-events: auto; font: 14px/1.35 system-ui, sans-serif; }
.templates { display: flex; flex-wrap: wrap; gap: 5px; }
button { box-sizing: border-box; max-width: 100%; min-height: 32px; padding: 4px 12px; overflow-wrap: anywhere; font: inherit;
  color: var(--wp-input-button-foreground, var(--wp-on-accent, #fff));
  background: var(--wp-input-button-background, var(--wp-accent, #116466)); border: 0; border-radius: 7px;
  cursor: pointer; touch-action: manipulation; }
button:hover { background: var(--wp-input-button-hover, var(--wp-accent-hover, #0f5557)); }
button:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
button.unconfigured:not(:hover, :focus-visible) { opacity: .78; }
.status { box-sizing: border-box; width: fit-content; max-width: min(320px, 100%); margin-top: 5px; padding: 4px 8px; border-radius: 6px;
  color: var(--wp-foreground, #172026); background: var(--wp-surface, #fff); overflow-wrap: anywhere; font-size: 12px; }
.status:empty { display: none; }
@media (any-pointer: coarse) { button { min-height: 44px; } }
`;

interface SpaceGesture {
  element: HTMLElement;
  text: string;
  count: number;
  started: number;
}

class InputTranslationController {
  private readonly lifecycle = new AbortController();
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "open" });
  private readonly popup = document.createElement("div");
  private readonly buttons = document.createElement("div");
  private readonly status = document.createElement("div");
  private templates: InputTranslationTemplate[] = [];
  private providers: readonly ProviderConfig[] = [];
  private draft?: InputDraft;
  private gesture?: SpaceGesture;
  private repeat = false;
  private composing = false;
  private pending = false;
  private editing = false;
  private layoutFrame = 0;

  constructor() {
    this.host.id = "wupage-input-translation";
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.popup.className = "popup";
    this.popup.setAttribute("role", "group");
    this.buttons.className = "templates";
    this.status.className = "status";
    this.status.setAttribute("role", "status");
    this.popup.append(this.buttons, this.status);
    this.shadow.append(style, this.popup);
    const signal = this.lifecycle.signal;
    document.addEventListener("beforeinput", this.beforeInput as EventListener, { capture: true, signal });
    document.addEventListener("input", this.onInput, { capture: true, signal });
    document.addEventListener("keydown", this.onKeyDown, { capture: true, signal });
    document.addEventListener("keyup", () => { this.repeat = false; }, { capture: true, signal });
    document.addEventListener("compositionstart", () => { this.composing = true; this.suspend(); }, { capture: true, signal });
    document.addEventListener("compositionend", () => { this.composing = false; }, { capture: true, signal });
    document.addEventListener("focusin", this.onFocus, { capture: true, signal });
    document.addEventListener("pointerdown", this.onPointerDown, { capture: true, signal });
    this.popup.addEventListener("pointerdown", event => { if (event.pointerType === "mouse") event.preventDefault(); });
    window.addEventListener("resize", this.schedulePosition, { signal });
    window.addEventListener("scroll", this.schedulePosition, { capture: true, signal });
    window.visualViewport?.addEventListener("resize", this.schedulePosition, { signal });
    window.visualViewport?.addEventListener("scroll", this.schedulePosition, { signal });
  }

  update(settings: Partial<ExtensionSettings> | undefined): void {
    const input = normalizeInputTranslation(settings?.inputTranslation);
    this.templates = input.enabled ? input.templates.filter(template => template.enabled) : [];
    this.providers = settings?.providers ?? [];
    this.suspend();
  }

  suspend(): void {
    this.gesture = undefined;
    this.close();
  }

  dispose(): void {
    this.lifecycle.abort();
    this.suspend();
  }

  private beforeInput = (event: InputEvent): void => {
    if (this.editing || !event.isTrusted) return;
    this.close();
    if (!this.templates.length || !event.cancelable || this.composing || event.isComposing || this.repeat
      || event.inputType !== "insertText" || event.data !== " ") {
      this.gesture = undefined;
      return;
    }
    const draft = captureInputDraft();
    if (!draft?.text.trim()) { this.gesture = undefined; return; }
    // Native editable elements can represent adjacent visible spaces with NBSP.
    const text = draft.source.kind === "range" ? draft.source.text.replace(/\u00a0/gu, " ") : draft.text;
    const previous = this.gesture;
    const continues = previous?.element === draft.element && event.timeStamp - previous.started <= GESTURE_WINDOW
      && text === previous.text + " ".repeat(previous.count);
    if (!continues) {
      this.gesture = { element: draft.element, text, count: 1, started: event.timeStamp };
      return;
    }
    if (previous.count === 1) { previous.count = 2; return; }
    this.gesture = undefined;
    const spaces = captureInputDraft(2);
    if (!spaces) return;
    // Allow the first two edits to happen naturally, then consume the third.
    event.preventDefault();
    this.editing = true;
    try {
      replaceSelectionSource(spaces.source, "", false);
      const cleaned = captureInputDraft();
      const cleanedText = cleaned?.source.kind === "range" ? cleaned.source.text.replace(/\u00a0/gu, " ") : cleaned?.text;
      if (cleaned?.element === draft.element && cleanedText === previous.text) this.open(cleaned);
    } catch { /* A page can veto cleanup. Leave its draft in place. */ }
    finally { this.editing = false; }
  };

  private onInput = (event: Event): void => {
    if (this.editing) return;
    this.close();
    if (event instanceof InputEvent && (event.inputType !== "insertText" || event.data !== " ")) this.gesture = undefined;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!event.isTrusted) return;
    this.repeat = event.key === " " && event.repeat;
    if (event.key !== " " || this.repeat || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey) this.gesture = undefined;
    if (!this.draft || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const draft = this.draft;
      const returnFocus = !!this.shadow.activeElement;
      this.close();
      if (returnFocus) draft.element.focus({ preventScroll: true });
    } else if (event.key === "Tab" && !event.shiftKey && inputDraftFocused(this.draft) && !this.pending) {
      const first = this.buttons.querySelector("button");
      if (!first) return;
      event.preventDefault();
      first.focus();
    } else if (inputDraftFocused(this.draft) && /^(?:Enter|Arrow.+|Home|End|PageUp|PageDown)$/u.test(event.key)) {
      this.close();
    }
  };

  private onFocus = (event: FocusEvent): void => {
    this.gesture = undefined;
    if (this.draft && !event.composedPath().includes(this.host) && !inputDraftFocused(this.draft)) this.close();
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.gesture = undefined;
    if (!event.composedPath().includes(this.host)) this.close();
  };

  private open(draft: InputDraft): void {
    this.draft = draft;
    this.popup.setAttribute("aria-label", t("inputTranslation"));
    this.buttons.replaceChildren(...this.templates.map(template => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = inputTemplateLabel(template);
      button.dataset.templateId = template.id;
      if (!inputTemplateProvider(template, this.providers)) {
        button.className = "unconfigured";
        button.title = t("configureInputTemplate");
      }
      button.addEventListener("click", event => {
        if (event.isTrusted) void this.apply(draft, template);
      });
      return button;
    }));
    document.documentElement.append(this.host);
    draft.element.addEventListener("scroll", this.schedulePosition, { passive: true });
    this.position();
  }

  private close(): void {
    if (!this.draft) return;
    this.draft.element.removeEventListener("scroll", this.schedulePosition);
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = 0;
    this.draft = undefined;
    this.pending = false;
    this.host.remove();
    this.buttons.replaceChildren();
    this.status.textContent = "";
    this.popup.removeAttribute("aria-busy");
  }

  private schedulePosition = (): void => {
    if (!this.draft || this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      this.position();
    });
  };

  private position(): void {
    if (!this.draft) return;
    const rect = this.draft.element.getBoundingClientRect();
    const view = visibleViewport();
    if (!this.draft.element.isConnected || !rect.width || !rect.height
      || rect.bottom < view.top || rect.top > view.bottom || rect.right < view.left || rect.left > view.right) {
      this.close();
      return;
    }
    const margin = 8, gap = 6;
    this.popup.style.maxWidth = Math.min(400, view.width - 2 * margin) + "px";
    this.popup.style.maxHeight = Math.max(32, Math.min(220, view.height - 2 * margin)) + "px";
    const { offsetWidth: width, offsetHeight: height } = this.popup;
    const caret = inputDraftCaret(this.draft, this.shadow, rect);
    const inline = caret && (caret.rtl ? caret.x - gap - width : caret.x + gap);
    const fitsInline = inline !== undefined && inline >= view.left + margin && inline + width <= view.right - margin;
    const lineTop = caret?.top ?? rect.top, lineBottom = caret?.bottom ?? rect.bottom;
    const anchorX = caret ? caret.x - (caret.rtl ? width : 0) : rect.left;
    const x = fitsInline ? inline : Math.max(view.left + margin, Math.min(anchorX, view.right - margin - width));
    const below = lineBottom + gap;
    const y = fitsInline ? (lineTop + lineBottom - height) / 2
      : below + height <= view.bottom - margin ? below : lineTop - height - gap;
    const clampedY = Math.max(view.top + margin, Math.min(y, view.bottom - margin - height));
    this.popup.style.left = x + "px";
    this.popup.style.top = clampedY + "px";
  }

  private async apply(draft: InputDraft, template: InputTranslationTemplate): Promise<void> {
    if (this.draft !== draft || this.pending) return;
    if (!selectionSourceUnchanged(draft.source)) { this.close(); return; }
    this.pending = true;
    this.popup.setAttribute("aria-busy", "true");
    try {
      if (!inputTemplateProvider(template, this.providers)) {
        await sendRuntimeRequest({ type: "OPEN_OPTIONS_PAGE", section: "input" });
        if (this.draft === draft) this.close();
        return;
      }
      this.status.textContent = t("translationInProgress");
      this.position();
      const result = await sendRuntimeRequest<string>({ type: "TRANSLATE_INPUT", text: draft.text, templateId: template.id });
      if (this.draft !== draft) return;
      const leading = draft.text.match(/^\s*/u)?.[0] ?? "";
      const trailing = draft.text.match(/\s*$/u)?.[0] ?? "";
      this.editing = true;
      try { replaceSelectionSource(draft.source, leading + result + trailing, false); }
      finally { this.editing = false; }
      this.close();
    } catch (error) {
      if (this.draft !== draft) return;
      this.status.textContent = error instanceof Error ? error.message : t("requestFailure");
      this.position();
    } finally {
      if (this.draft === draft) {
        this.pending = false;
        this.popup.removeAttribute("aria-busy");
      }
    }
  }
}

let controller: InputTranslationController | undefined;

export function initInputTranslation(): void {
  if (!chrome?.runtime?.id || controller) return;
  const instance = controller = new InputTranslationController();
  let revision = 0;
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    revision++;
    instance.update(changes[SETTINGS_KEY].newValue as ExtensionSettings | undefined);
  };
  chrome.storage.onChanged.addListener(changed);
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => {
    if (!revision) instance.update(settings);
  }).catch(() => undefined);
  window.addEventListener("pagehide", event => {
    if (event.persisted) { instance.suspend(); return; }
    instance.dispose();
    chrome.storage.onChanged.removeListener(changed);
  });
}
