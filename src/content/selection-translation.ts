import type { ExtensionSettings, TranslateBatchResponse } from "../shared/types";
import { sendRuntimeRequest } from "./runtime";
import { SETTINGS_KEY } from "../shared/defaults";
import { formatSelectionShortcut, normalizeSelectionTranslation, shortcutFromEvent } from "../shared/selection-translation";

const HOST_ID = "wupage-selection-translator";
const MAX_SELECTION_LENGTH = 5000;
const EXCLUDED = "input,textarea,select,[contenteditable]:not([contenteditable='false']),"
  + ".wupage-translation,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-debug-panel,"
  + `#${HOST_ID},script,style,[hidden],[aria-hidden='true']`;

interface SelectedText {
  text: string;
  range: Range;
}

/** Selection is read locally. Only explicit activation sends the selected text. */
export function initSelectionTranslation(): () => void {
  if (typeof document === "undefined" || document.getElementById(HOST_ID)) return () => {};
  let selected: SelectedText | null = null;
  let dismissed: SelectedText | null = null;
  let host: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement;
  let panel: HTMLDivElement;
  let result: HTMLDivElement;
  let retry: HTMLButtonElement;
  let generation = 0;
  let opened = false;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let preferences = normalizeSelectionTranslation(undefined);
  let disposed = false;
  let preferenceRevision = 0;
  let selecting = false;

  function applyPreferences(value: unknown): void {
    preferences = normalizeSelectionTranslation(value);
    if (!host) return;
    const hint = preferences.shortcut ? `翻译选中文字（${formatSelectionShortcut(preferences.shortcut)}）` : "翻译选中文字";
    trigger.title = hint;
    trigger.setAttribute("aria-label", hint);
    trigger.hidden = opened || !preferences.showIcon;
    host.hidden = !selected || (!opened && !preferences.showIcon);
    position();
  }

  const onSettingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    preferenceRevision++;
    applyPreferences((changes[SETTINGS_KEY].newValue as Partial<ExtensionSettings> | undefined)?.selectionTranslation);
  };
  chrome.storage?.onChanged?.addListener(onSettingsChanged);
  const initialRevision = preferenceRevision;
  void chrome.storage?.local?.get(SETTINGS_KEY).then((stored) => {
    if (!disposed && preferenceRevision === initialRevision) {
      applyPreferences((stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined)?.selectionTranslation);
    }
  }).catch(() => { /* Keep safe defaults if extension storage is unavailable. */ });

  function isInside(event: Event): boolean {
    return Boolean(host && event.composedPath().includes(host));
  }

  function sameSelection(left: SelectedText | null, right: SelectedText | null): boolean {
    return Boolean(left && right && left.text === right.text
      && left.range.startContainer === right.range.startContainer && left.range.startOffset === right.range.startOffset
      && left.range.endContainer === right.range.endContainer && left.range.endOffset === right.range.endOffset);
  }

  function readSelection(): SelectedText | null {
    if (document.activeElement?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const text = selection.toString().trim();
    if (!text || text.length > MAX_SELECTION_LENGTH) return null;
    const range = selection.getRangeAt(0);
    for (const node of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element || element.closest(EXCLUDED) || element.getRootNode() !== document) return null;
    }
    // Reject mixed selections containing an editor, even if both endpoints are prose.
    if (range.cloneContents().querySelector(EXCLUDED)) return null;
    if (!Array.from(range.getClientRects()).some((rect) => rect.height > 0)) return null;
    return { text, range: range.cloneRange() };
  }

  function dismiss(): void {
    generation++;
    dismissed = selected;
    selected = null;
    opened = false;
    loading = false;
    if (host) host.hidden = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function mount(): void {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    // Keep the host out of layout and protect placement from page-wide styles.
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("width", "0", "important");
    host.style.setProperty("height", "0", "important");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host([hidden]) { display: none !important; }
      * { box-sizing: border-box; }
      .surface { position: fixed; font: 14px/1.6 system-ui, sans-serif; color: #253044;
        color-scheme: light dark; background: #fff; border: 1px solid #d9dfe8;
        box-shadow: 0 3px 16px #18203318; }
      button { font: inherit; cursor: pointer; color: inherit; }
      button:focus-visible { outline: 2px solid #5584c4; outline-offset: 3px; }
      [hidden] { display: none !important; }
      .trigger { width: 28px; height: 28px; display: grid; place-items: center; padding: 0;
        background: transparent; border: 0; box-shadow: none; opacity: .72;
        animation: appear 120ms ease-out; }
      .trigger-dot { display: block; width: 8px; height: 8px; border: 0;
        border-radius: 50%; background: #245747; pointer-events: none; }
      .trigger:hover, .trigger:focus-visible { opacity: 1; }
      .trigger:hover .trigger-dot, .trigger:focus-visible .trigger-dot { background: #163e32; }
      @keyframes appear { from { opacity: 0; } to { opacity: .72; } }
      @media (prefers-reduced-motion: reduce) { .trigger { animation: none; } }
      .panel { width: 340px; max-width: calc(100vw - 16px); max-height: min(360px, calc(100dvh - 16px));
        border-radius: 10px; padding: 12px 14px; overflow: auto; overscroll-behavior: contain; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px;
        font-size: 12px; color: #657187; margin-bottom: 8px; }
      .close { background: transparent; border: 0; border-radius: 4px; padding: 0 5px; font-size: 18px; }
      .result { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
      .retry { margin-top: 10px; border: 1px solid #d9dfe8; background: transparent; border-radius: 5px; padding: 2px 10px; }
      @media (prefers-color-scheme: dark) {
        .surface { color: #e4e8ef; background: #242933; border-color: #495264; }
        header { color: #b2bdce; }
        .trigger { background: transparent; }
        .trigger-dot { background: #397b63; }
        .trigger:hover .trigger-dot, .trigger:focus-visible .trigger-dot { background: #4a9479; }
      }
      @media (forced-colors: active) {
        .panel { border: 1px solid ButtonText; }
        .trigger-dot { background: ButtonText; forced-color-adjust: none; }
      }
    </style>
    <button class="surface trigger" data-action="translate" type="button"
      title="翻译选中文字" aria-label="翻译选中文字"><span class="trigger-dot" aria-hidden="true"></span></button>
    <div class="surface panel" role="dialog" aria-label="划词翻译" hidden>
      <header><span>WuPage · 划词翻译</span><button class="close" data-action="close" type="button" aria-label="关闭划词翻译">×</button></header>
      <div class="result" data-role="result" role="status" aria-live="polite"></div>
      <button class="retry" data-action="retry" type="button" hidden>重试</button>
    </div>`;
    trigger = shadow.querySelector<HTMLButtonElement>("[data-action=translate]")!;
    panel = shadow.querySelector<HTMLDivElement>("[role=dialog]")!;
    result = shadow.querySelector<HTMLDivElement>("[data-role=result]")!;
    retry = shadow.querySelector<HTMLButtonElement>("[data-action=retry]")!;
    // Do not collapse the page selection when clicking the trigger.
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.addEventListener("click", (event) => { event.stopPropagation(); void translate(); });
    retry.addEventListener("click", () => { void translate(); });
    shadow.querySelector("[data-action=close]")!.addEventListener("click", () => {
      const restoreFocus = shadow.activeElement !== null;
      dismiss();
      if (restoreFocus) window.getSelection()?.anchorNode?.parentElement?.focus({ preventScroll: true });
    });
    document.documentElement.append(host);
    applyPreferences(preferences);
  }

  function position(): void {
    if (!selected || !host || host.hidden) return;
    if (!selected.range.startContainer.isConnected || !selected.range.endContainer.isConnected) {
      dismiss();
      return;
    }
    const rects = Array.from(selected.range.getClientRects()).filter((rect) => rect.height > 0);
    const anchor = rects[rects.length - 1];
    if (!anchor || anchor.bottom < 0 || anchor.top > window.innerHeight || anchor.right < 0 || anchor.left > window.innerWidth) {
      dismiss();
      return;
    }
    const surface = opened ? panel : trigger;
    const width = surface.getBoundingClientRect().width || (opened ? Math.min(340, window.innerWidth - 16) : 28);
    const height = surface.getBoundingClientRect().height || (opened ? 100 : 28);
    // Center the 8px dot 6px to the lower right of the final selected line.
    // Its transparent hit area remains larger without introducing a visible box.
    const left = Math.max(8, Math.min(opened ? anchor.right : anchor.right + 6 - width / 2, window.innerWidth - width - 8));
    let top = opened ? anchor.bottom + 8 : anchor.bottom + 6 - height / 2;
    if (top + height > window.innerHeight - 8) top = opened ? anchor.top - height - 8 : window.innerHeight - height - 8;
    surface.style.left = `${left}px`;
    surface.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
  }

  function updateSelection(): void {
    timer = undefined;
    const next = readSelection();
    // Selection inside the dialog (e.g. copying a translation) must not close it.
    if (host?.shadowRoot?.activeElement || (opened && window.getSelection()?.anchorNode?.getRootNode() === host?.shadowRoot)) return;
    if (sameSelection(selected, next)) return;
    if (!next) {
      // Browser focus changes can collapse the source selection after opening.
      if (!opened) dismiss();
      return;
    }
    if (sameSelection(dismissed, next)) return;
    generation++;
    selected = next;
    dismissed = null;
    opened = false;
    loading = false;
    mount();
    host!.hidden = false;
    panel.hidden = true;
    applyPreferences(preferences);
  }

  function scheduleSelection(event: Event): void {
    if (isInside(event) || selecting) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(updateSelection, 180);
  }

  async function translate(): Promise<void> {
    if (!selected || loading) return;
    const snapshot = selected;
    const id = ++generation;
    const pageUrl = location.href;
    mount();
    host!.hidden = false;
    opened = true;
    loading = true;
    trigger.hidden = true;
    panel.hidden = false;
    panel.setAttribute("aria-busy", "true");
    result.textContent = "正在翻译…";
    retry.hidden = true;
    position();
    try {
      const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
      if (id !== generation || location.href !== pageUrl) return;
      const response = await sendRuntimeRequest<TranslateBatchResponse>({
        type: "TRANSLATE_BATCH", texts: [snapshot.text], sourceLang: settings.sourceLang,
        targetLang: settings.targetLang, providerId: settings.activeProviderId
      });
      if (id !== generation || location.href !== pageUrl) return;
      if (response.translations.length !== 1 || typeof response.translations[0] !== "string" || !response.translations[0].trim()) {
        throw new Error("翻译服务未返回有效译文。");
      }
      result.textContent = response.translations[0];
    } catch (error) {
      if (id !== generation) return;
      result.textContent = error instanceof Error ? error.message : "翻译失败，请重试。";
      retry.hidden = false;
    } finally {
      if (id === generation) {
        loading = false;
        panel.setAttribute("aria-busy", "false");
        position();
      }
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && (selected || timer !== undefined)) {
      dismiss();
      return;
    }
    if (!preferences.shortcut || shortcutFromEvent(event) !== preferences.shortcut || event.defaultPrevented) return;
    if (event.composedPath().some((node) => node instanceof Element && node.matches(EXCLUDED))) return;
    const next = readSelection();
    if (!next) return;
    event.preventDefault();
    if (!sameSelection(selected, next)) { generation++; selected = next; loading = false; }
    dismissed = null;
    void translate();
  }

  function onPointerDown(event: Event): void {
    if (!isInside(event)) {
      dismiss();
      selecting = true;
    }
  }
  function onPointerUp(event: Event): void {
    selecting = false;
    scheduleSelection(event);
  }
  function onPointerCancel(): void { selecting = false; dismiss(); }
  function onPageHide(): void { selecting = false; dismiss(); }
  document.addEventListener("selectionchange", scheduleSelection);
  document.addEventListener("mouseup", scheduleSelection);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("popstate", onPageHide);
  window.addEventListener("hashchange", onPageHide);
  return () => {
    disposed = true;
    chrome.storage?.onChanged?.removeListener(onSettingsChanged);
    dismiss();
    host?.remove();
    document.removeEventListener("selectionchange", scheduleSelection);
    document.removeEventListener("mouseup", scheduleSelection);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", position, true);
    window.removeEventListener("resize", position);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("popstate", onPageHide);
    window.removeEventListener("hashchange", onPageHide);
  };
}
