import { t } from "../shared/i18n";
import type { ExtensionSettings, ImageTextRegion, TranslateImageResponse } from "../shared/types";
import { SETTINGS_KEY } from "../shared/defaults";
import { ocrSettingsIdentity } from "../shared/ocr-service";
import { hasRuntimeContext, sendRuntimeRequest } from "./runtime";
import { getImageRasterSize, renderImageTranslation } from "./image-rendering";
import { isNonProseElement, isTranslationOptedOut } from "./content-policy";
import { hasTouchInput, TOUCH_INPUT_QUERY, visibleViewport } from "../shared/touch";

interface ImageEntry {
  image: HTMLImageElement;
  source: string;
  button: HTMLButtonElement;
  status: HTMLDivElement;
  canvas?: HTMLCanvasElement;
  renderSource?: HTMLImageElement;
  regions?: ImageTextRegion[];
  busy: boolean;
  showing: boolean;
  replaceSource?: boolean;
  generation: number;
  manual?: boolean;
  contextOccluder?: Element | null;
  presentation?: HTMLElement;
  hoverBounds?: { left: number; top: number; right: number; bottom: number; buttonLeft: number };
  hideTimer?: number;
  fadeTimer?: number;
}

const HOST_ID = "wupage-image-tools";
const BUTTON_HIDE_DELAY = 500;
const BUTTON_FADE_DURATION = 150;
const SOURCE_MASK_ATTR = "data-wupage-image-source-mask";
const SOURCE_STYLE_ID = "wupage-image-source-style";
const maskedSources = new Map<HTMLElement, string | null>();
const entries = new Map<HTMLImageElement, ImageEntry>();
let host: HTMLDivElement | undefined;
let sourceStyle: HTMLStyleElement | undefined;
let root: ShadowRoot | undefined;
let enabled = false;
let observer: MutationObserver | undefined;
let resizeObserver: ResizeObserver | undefined;
let scanTimer: number | undefined;
let frame: number | undefined;
let hoverFrame: number | undefined;
let pointer: { x: number; y: number } | undefined;
let touchControls = false;
let stopTouchMedia: (() => void) | undefined;
let initialized = false;
let contextTarget: { image: HTMLImageElement; source: string } | undefined;

export function initImageTranslation(): void {
  if (initialized || !hasRuntimeContext()) return;
  initialized = true;
  let revision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    revision += 1;
    const settings = changes[SETTINGS_KEY].newValue as ExtensionSettings | undefined;
    const previous = changes[SETTINGS_KEY].oldValue as ExtensionSettings | undefined;
    if (!previous || !settings || previous.imageTranslationEnabled !== settings.imageTranslationEnabled
      || previous.sourceLang !== settings.sourceLang || previous.targetLang !== settings.targetLang
      || previous.activeProviderId !== settings.activeProviderId
      || ocrSettingsIdentity(previous.ocr) !== ocrSettingsIdentity(settings.ocr)
      || JSON.stringify(previous.providers) !== JSON.stringify(settings.providers)) {
      // Clear old language/provider results as well as pending responses.
      setImageTranslationEnabled(false);
    }
    // Even an unrelated update supersedes the initial read. Apply its current
    // switch value so initialization cannot remain disabled until a reload.
    setImageTranslationEnabled(settings?.imageTranslationEnabled === true);
  });
  const initialRevision = revision;
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then((settings) => {
    if (revision === initialRevision) setImageTranslationEnabled(settings.imageTranslationEnabled === true);
  }).catch(() => undefined);
}

export function setImageTranslationEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  if (!enabled) {
    restoreSourcePixels();
    observer?.disconnect(); resizeObserver?.disconnect();
    window.removeEventListener("scroll", scheduleLayout, true);
    window.removeEventListener("resize", scheduleScan);
    document.removeEventListener("load", scheduleScan, true);
    document.removeEventListener("contextmenu", rememberContextImage, true);
    document.removeEventListener("pointermove", trackPointer, true);
    document.removeEventListener("pointerdown", trackInput, true);
    document.removeEventListener("pointerout", leavePage, true);
    window.removeEventListener("blur", clearPointer);
    window.visualViewport?.removeEventListener("resize", scheduleLayout);
    window.visualViewport?.removeEventListener("scroll", scheduleLayout);
    stopTouchMedia?.(); stopTouchMedia = undefined;
    if (hoverFrame !== undefined) window.cancelAnimationFrame(hoverFrame);
    hoverFrame = undefined; pointer = undefined;
    contextTarget = undefined;
    if (scanTimer !== undefined) window.clearTimeout(scanTimer);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    scanTimer = undefined; frame = undefined;
    entries.forEach((entry) => { entry.generation += 1; cancelButtonHide(entry); });
    entries.clear(); host?.remove(); host = undefined; root = undefined;
    sourceStyle?.remove(); sourceStyle = undefined;
    return;
  }
  touchControls = hasTouchInput();
  createHost();
  const media = window.matchMedia?.(TOUCH_INPUT_QUERY);
  const changed = () => setTouchControls(hasTouchInput());
  media?.addEventListener("change", changed);
  stopTouchMedia = () => media?.removeEventListener("change", changed);
  observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== host
      && !(record.target instanceof Element && record.target.closest(`#${HOST_ID},.wupage-translation`)))) scheduleScan();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["src", "srcset", "sizes", "width", "height", "style", "class", "hidden", "translate", "contenteditable", "role"] });
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(scheduleLayout);
  window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleScan, { passive: true });
  document.addEventListener("load", scheduleScan, true);
  document.addEventListener("contextmenu", rememberContextImage, true);
  document.addEventListener("pointermove", trackPointer, { capture: true, passive: true });
  document.addEventListener("pointerdown", trackInput, { capture: true, passive: true });
  document.addEventListener("pointerout", leavePage, true);
  window.addEventListener("blur", clearPointer);
  window.visualViewport?.addEventListener("resize", scheduleLayout);
  window.visualViewport?.addEventListener("scroll", scheduleLayout);
  scanImages();
}

function createHost(): void {
  sourceStyle = document.createElement("style");
  sourceStyle.id = SOURCE_STYLE_ID;
  sourceStyle.textContent = `
    img[${SOURCE_MASK_ATTR}="image"]{clip-path:inset(50%)!important}
    [${SOURCE_MASK_ATTR}="background"]{background-image:none!important}
  `;
  document.documentElement.append(sourceStyle);
  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("translate", "no");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;";
  root = host.attachShadow({ mode: "open" });
  host.dataset.touch = String(touchControls);
  root.addEventListener("focusin", scheduleHover);
  root.addEventListener("focusout", scheduleHover);
  const style = document.createElement("style");
  style.textContent = `
    button{position:fixed;box-sizing:border-box;width:30px;height:30px;padding:0;border:1px solid var(--wp-border,#cbd5e1);border-radius:9px;background:var(--wp-image-button-background,#fff);color:var(--wp-image-button-foreground,#1856ba);box-shadow:0 2px 8px #0003;cursor:pointer;pointer-events:auto;font:600 13px/1 system-ui,sans-serif;transition:opacity ${BUTTON_FADE_DURATION}ms ease-out}
    button:hover,button[aria-pressed=true]{background:var(--wp-image-button-foreground,#1856ba);color:var(--wp-image-button-background,#fff)}
    button:focus-visible{outline:3px solid var(--wp-image-button-background,#60a5fa);outline-offset:2px}
    button:disabled{cursor:wait;opacity:.8}
    button[data-fading]{opacity:0}
    @media(prefers-reduced-motion:reduce){button{transition:none}}
    :host([data-touch="true"]) button{width:44px;height:44px;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
    canvas{position:fixed;pointer-events:none;box-sizing:content-box}
    .status{position:fixed;max-width:min(280px,85vw);padding:7px 10px;background:var(--wp-surface,#172033);color:var(--wp-foreground,#fff);border:1px solid var(--wp-border,transparent);border-radius:7px;font:12px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;pointer-events:none}
    [hidden]{display:none!important}
  `;
  root.append(style); document.documentElement.append(host);
}

function scheduleScan(): void {
  if (!enabled || scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => { scanTimer = undefined; scanImages(); }, 120);
  scheduleLayout();
}

function scanImages(): void {
  if (!enabled || !root) return;
  if (host && !host.isConnected) document.documentElement.append(host);
  if (sourceStyle && !sourceStyle.isConnected) document.documentElement.append(sourceStyle);
  for (const [image, entry] of entries) {
    if (!image.isConnected || entry.source !== imageSource(image) || isNonProseElement(image) || isTranslationOptedOut(image)) {
      cancelButtonHide(entry);
      entry.generation += 1; entry.button.remove(); entry.status.remove(); entry.canvas?.remove();
      resizeObserver?.unobserve(image); entries.delete(image);
    }
  }
  for (const image of document.images) {
    if (entries.has(image) || !imageSource(image) || !image.complete || !image.naturalWidth
      || image.naturalWidth < 80 || image.naturalHeight < 40
      || isNonProseElement(image) || isTranslationOptedOut(image) || image.closest(".wupage-translation")) continue;
    createEntry(image);
  }
  updateLayout();
}

function createEntry(image: HTMLImageElement): ImageEntry {
  const existing = entries.get(image);
  if (existing && existing.source === imageSource(image)) return existing;
  if (existing) {
    cancelButtonHide(existing);
    existing.generation += 1; existing.button.remove(); existing.status.remove(); existing.canvas?.remove();
  }
  const button = document.createElement("button");
  button.type = "button"; button.textContent = t("translateBadge"); button.title = t("translateImageTextAndOverlayTheOriginal");
  button.hidden = true;
  button.setAttribute("aria-label", t("translateImage")); button.setAttribute("aria-pressed", "false");
  const status = document.createElement("div"); status.className = "status"; status.setAttribute("role", "status"); status.hidden = true;
  const entry: ImageEntry = { image, source: imageSource(image), button, status, busy: false, showing: false, generation: 0 };
  button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void translateImage(entry); });
  entries.set(image, entry); root!.append(button, status); resizeObserver?.observe(image);
  return entry;
}

function rememberContextImage(event: MouseEvent): void {
  const image = event.composedPath().find((node): node is HTMLImageElement => node instanceof HTMLImageElement)
    ?? document.elementsFromPoint?.(event.clientX, event.clientY).find((node): node is HTMLImageElement => node instanceof HTMLImageElement);
  contextTarget = image ? { image, source: imageSource(image) } : undefined;
}

export async function translateContextImage(srcUrl: string): Promise<{ started: boolean }> {
  try {
    const selected = contextTarget;
    const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
    if (!settings.imageTranslationEnabled) throw new Error(t("installOcrModelsAndEnableImageTranslationIn"));
    setImageTranslationEnabled(true);
    let image: HTMLImageElement | undefined;
    if (selected && (selected.source === srcUrl || selected.image.src === srcUrl)) {
      if (!selected.image.isConnected || imageSource(selected.image) !== selected.source) throw new Error(t("theImageHasChangedRightClickItAgain"));
      image = selected.image;
    } else {
      const candidates = Array.from(document.images).filter((candidate) => {
        if (imageSource(candidate) !== srcUrl && candidate.src !== srcUrl) return false;
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
          && rect.left < window.innerWidth && rect.top < window.innerHeight;
      });
      if (candidates.length > 1) throw new Error(t("multipleIdenticalImagesFoundRightClickTheOne"));
      image = candidates[0];
    }
    if (!image) throw new Error(t("imageNotFoundLetItLoadThenRight"));
    if (isNonProseElement(image) || isTranslationOptedOut(image)) throw new Error(t("thisImageIsInAnEditorOrAn"));
    if (!image.complete || !image.naturalWidth) throw new Error(t("theImageIsStillLoadingTryAgainShortly"));
    const entry = createEntry(image);
    entry.manual = true;
    entry.presentation = imagePresentation(image);
    const rect = (entry.presentation ?? image).getBoundingClientRect();
    entry.contextOccluder = document.elementFromPoint?.(
      (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2,
      (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2);
    // Repeated menu clicks show the existing translation rather than toggling it off.
    if (entry.canvas) { entry.showing = true; updateButton(entry); updateLayout(); }
    else void translateImage(entry);
    return { started: true };
  } catch (error) {
    showContextNotice(error instanceof Error ? error.message : t("imageTranslationFailedTryAgain"));
    return { started: false };
  }
}

function imagePresentation(image: HTMLImageElement): HTMLElement | undefined {
  if (window.getComputedStyle(image).opacity !== "0") return;
  const imageRect = image.getBoundingClientRect();
  const sources = new Set([imageSource(image), image.src]);
  // X renders the pixels in a sibling background, retaining a transparent img
  // for accessibility and the native image menu. Other sites use a parent.
  // Match both the source and bounds so unrelated backgrounds stay excluded.
  const candidates = new Set<HTMLElement>();
  for (const sibling of image.parentElement?.children ?? []) {
    if (sibling instanceof HTMLElement && sibling !== image) candidates.add(sibling);
  }
  for (let parent = image.parentElement, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
    candidates.add(parent);
  }
  for (const candidate of candidates) {
    const css = window.getComputedStyle(candidate);
    const match = /^url\(["']?(.*?)["']?\)$/.exec(css.backgroundImage);
    if (!match || !sources.has(match[1])) continue;
    const rect = candidate.getBoundingClientRect();
    if (Math.abs(rect.left - imageRect.left) <= 2 && Math.abs(rect.top - imageRect.top) <= 2
      && Math.abs(rect.width - imageRect.width) <= 2 && Math.abs(rect.height - imageRect.height) <= 2) return candidate;
  }
}

function showContextNotice(message: string): void {
  document.getElementById("wupage-image-context-notice")?.remove();
  const notice = document.createElement("div");
  notice.id = "wupage-image-context-notice";
  notice.setAttribute("translate", "no");
  notice.style.cssText = "all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;";
  const shadow = notice.attachShadow({ mode: "open" });
  const text = document.createElement("div"); text.setAttribute("role", "alert"); text.textContent = message;
  text.style.cssText = "max-width:320px;padding:12px 16px;background:var(--wp-surface,#172033);color:var(--wp-foreground,white);border:1px solid var(--wp-border,transparent);border-radius:8px;font:14px/1.6 system-ui,sans-serif";
  shadow.append(text); document.documentElement.append(notice);
  window.setTimeout(() => notice.remove(), 10_000);
}

function imageSource(image: HTMLImageElement): string { return image.currentSrc || image.src; }

function scheduleLayout(): void {
  if (!enabled || frame !== undefined) return;
  frame = window.requestAnimationFrame(() => { frame = undefined; updateLayout(); });
}

function trackPointer(event: PointerEvent): void {
  if (event.pointerType === "mouse") setTouchControls(false);
  pointer = { x: event.clientX, y: event.clientY };
  scheduleHover();
}

function trackInput(event: PointerEvent): void {
  if (event.pointerType === "touch" || event.pointerType === "mouse") setTouchControls(event.pointerType === "touch");
}

function setTouchControls(value: boolean): void {
  if (value === touchControls) return;
  touchControls = value;
  if (host) host.dataset.touch = String(value);
  scheduleLayout();
}

function leavePage(event: PointerEvent): void {
  if (!event.relatedTarget) clearPointer();
}

function clearPointer(): void { pointer = undefined; scheduleHover(); }

function scheduleHover(): void {
  if (!enabled || hoverFrame !== undefined) return;
  hoverFrame = window.requestAnimationFrame(() => { hoverFrame = undefined; updateHover(); });
}

function cancelButtonHide(entry: ImageEntry): void {
  if (entry.hideTimer !== undefined) window.clearTimeout(entry.hideTimer);
  if (entry.fadeTimer !== undefined) window.clearTimeout(entry.fadeTimer);
  entry.hideTimer = undefined;
  entry.fadeTimer = undefined;
  entry.button.removeAttribute("data-fading");
}

function hideButton(entry: ImageEntry): void {
  cancelButtonHide(entry);
  entry.button.hidden = true;
}

function scheduleButtonHide(entry: ImageEntry): void {
  // Repeated pointer moves and layout updates must not restart the grace period.
  if (entry.button.hidden || entry.hideTimer !== undefined || entry.fadeTimer !== undefined) return;
  entry.hideTimer = window.setTimeout(() => {
    entry.hideTimer = undefined;
    entry.button.setAttribute("data-fading", "");
    entry.fadeTimer = window.setTimeout(() => hideButton(entry), BUTTON_FADE_DURATION);
  }, BUTTON_HIDE_DELAY);
}

function updateHover(): void {
  const hit = pointer && document.elementFromPoint?.(pointer.x, pointer.y);
  for (const entry of entries.values()) {
    const bounds = entry.hoverBounds;
    let hovered = false;
    if (bounds && pointer) {
      const { x, y } = pointer;
      const onImage = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      const imageHit = !hit || hit === entry.image || hit.contains(entry.image)
        || entry.presentation?.contains(hit)
        || (entry.manual && (hit === entry.contextOccluder || entry.contextOccluder?.contains(hit)));
      // Keep the visible button reachable across the small gap beside the image.
      const onButton = !entry.button.hidden && x >= Math.min(bounds.right, bounds.buttonLeft)
        && x <= bounds.buttonLeft + 30 && y >= bounds.top + 4 && y <= bounds.top + 34;
      hovered = Boolean((onImage && imageHit) || onButton);
    }
    const keyboardFocus = root?.activeElement === entry.button && entry.button.matches(":focus-visible");
    if (!bounds) hideButton(entry);
    else if (touchControls || hovered || keyboardFocus) {
      cancelButtonHide(entry);
      entry.button.hidden = false;
    } else scheduleButtonHide(entry);
  }
}

function updateLayout(): void {
  // Read the site's real styles before applying our pixel-only masks. In
  // particular, background presentations must remain discoverable next frame.
  restoreSourcePixels();
  if (!host?.isConnected) return;
  const view = visibleViewport(), buttonSize = touchControls ? 44 : 30;
  const minimumHeight = buttonSize + (touchControls ? 4 : 0);
  const replacements: HTMLElement[] = [];
  for (const entry of entries.values()) {
    const { image, button, status, canvas } = entry;
    entry.hoverBounds = undefined;
    // Resolve for automatic buttons too, and refresh when a feed replaces nodes.
    entry.presentation = imagePresentation(image);
    const presentation = entry.presentation ?? image;
    const rect = presentation.getBoundingClientRect();
    let left = Math.max(view.left, rect.left), top = Math.max(view.top, rect.top);
    let right = Math.min(view.right, rect.right), bottom = Math.min(view.bottom, rect.bottom);
    let hidden = !image.isConnected || imageSource(image) !== entry.source || isNonProseElement(image) || isTranslationOptedOut(image)
      || rect.width < (entry.manual ? 1 : 80) || rect.height < (entry.manual ? 1 : 40);
    if (hidden || right - left < buttonSize || bottom - top < minimumHeight) {
      hideButton(entry); status.hidden = true; if (canvas) canvas.hidden = true;
      continue;
    }
    const style = window.getComputedStyle(presentation);
    for (let node: Element | null = presentation; node; node = node.parentElement) {
      const css = window.getComputedStyle(node);
      if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse" || css.opacity === "0") hidden = true;
      // Root overflow clips to the viewport, not the root element's scrolled
      // rectangle. X locks root scrolling in its fixed photo viewer; that
      // rectangle can be entirely above the screen while the photo is visible.
      // The viewport has already been applied to left/top/right/bottom above.
      if (node === presentation || node === document.documentElement) continue;
      const bounds = node.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(css.overflowX || css.overflow)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/hidden|clip|auto|scroll/.test(css.overflowY || css.overflow)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    hidden ||= right - left < buttonSize || bottom - top < minimumHeight;
    if (!hidden && document.elementFromPoint) {
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      hidden = Boolean(hit && hit !== image && !hit.contains(image) && !presentation.contains(hit)
        && !(entry.manual && (hit === entry.contextOccluder || entry.contextOccluder?.contains(hit))));
    }
    if (hidden) hideButton(entry);
    status.hidden = hidden || !status.textContent;
    if (canvas) canvas.hidden = hidden || !entry.showing;
    if (hidden) continue;
    const buttonLeft = right + 4 + buttonSize < view.right ? right + 4 : right - buttonSize - 4;
    entry.hoverBounds = { left, top, right, bottom, buttonLeft: Math.max(0, buttonLeft) };
    button.style.left = `${Math.max(0, buttonLeft)}px`; button.style.top = `${top + 4}px`;
    status.style.left = `${Math.max(view.left + 4, Math.min(buttonLeft, view.right - 290))}px`; status.style.top = `${top + buttonSize + 8}px`;
    if (canvas) {
      const scaleX = presentation.offsetWidth ? rect.width / presentation.offsetWidth : 1;
      const scaleY = presentation.offsetHeight ? rect.height / presentation.offsetHeight : 1;
      const px = (value: string) => Number.parseFloat(value) || 0;
      const insetLeft = (px(style.borderLeftWidth) + px(style.paddingLeft)) * scaleX;
      const insetRight = (px(style.borderRightWidth) + px(style.paddingRight)) * scaleX;
      const insetTop = (px(style.borderTopWidth) + px(style.paddingTop)) * scaleY;
      const insetBottom = (px(style.borderBottomWidth) + px(style.paddingBottom)) * scaleY;
      const cx = rect.left + insetLeft, cy = rect.top + insetTop;
      const width = rect.width - insetLeft - insetRight, height = rect.height - insetTop - insetBottom;
      if (entry.showing && entry.renderSource && entry.regions) {
        const size = getImageRasterSize(entry.renderSource.naturalWidth, entry.renderSource.naturalHeight,
          width, height, window.devicePixelRatio || 1);
        if (size.width > canvas.width || size.height > canvas.height) {
          canvas.width = size.width; canvas.height = size.height;
          // Redraw directly from the image (preserving SVG detail), never an
          // enlarged OCR bitmap. Geometry and translations remain reusable.
          entry.replaceSource = renderImageTranslation(canvas, entry.renderSource, entry.regions);
        }
      }
      Object.assign(canvas.style, {
        left: `${cx}px`, top: `${cy}px`, width: `${width}px`, height: `${height}px`,
        objectFit: entry.presentation ? (/^(cover|contain)$/.test(style.backgroundSize) ? style.backgroundSize : "fill") : style.objectFit || "fill",
        objectPosition: entry.presentation ? style.backgroundPosition || "50% 50%" : style.objectPosition || "50% 50%",
        borderRadius: style.borderRadius, opacity: style.opacity, filter: style.filter,
        clipPath: `inset(${Math.max(0, top - cy)}px ${Math.max(0, cx + width - right)}px ${Math.max(0, cy + height - bottom)}px ${Math.max(0, left - cx)}px)`
      });
      if (!canvas.hidden && entry.replaceSource) replacements.push(presentation);
    }
  }
  for (const source of replacements) {
    if (!maskedSources.has(source)) maskedSources.set(source, source.getAttribute(SOURCE_MASK_ATTR));
    source.setAttribute(SOURCE_MASK_ATTR, source instanceof HTMLImageElement ? "image" : "background");
  }
  updateHover();
}

function restoreSourcePixels(): void {
  for (const [source, previous] of maskedSources) {
    if (previous === null) source.removeAttribute(SOURCE_MASK_ATTR);
    else source.setAttribute(SOURCE_MASK_ATTR, previous);
  }
  maskedSources.clear();
}

async function translateImage(entry: ImageEntry): Promise<void> {
  if (entry.busy) return;
  if (entry.canvas) {
    entry.showing = !entry.showing; updateButton(entry); updateLayout(); return;
  }
  const generation = ++entry.generation;
  const current = () => enabled && entry.generation === generation && entry.image.isConnected
    && imageSource(entry.image) === entry.source && entries.get(entry.image) === entry
    && !isNonProseElement(entry.image) && !isTranslationOptedOut(entry.image);
  entry.busy = true; entry.button.disabled = true; entry.button.textContent = "…";
  entry.status.textContent = t("recognizingAndTranslatingImageText"); updateLayout();
  try {
    const { canvas: source, image: renderSource } = await readImage(entry.image, entry.presentation);
    if (!current()) return;
    const result = await sendRuntimeRequest<TranslateImageResponse>({ type: "TRANSLATE_IMAGE",
      dataUrl: source.toDataURL("image/png"), width: source.width, height: source.height,
      sourceText: entry.image.alt.trim().slice(0, 12000) || undefined });
    if (!current()) return;
    if (!result.regions.length) {
      entry.status.textContent = result.warning ?? t("couldNotReliablyIdentifyTextToTranslate");
      return;
    }
    const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", result.regions.map((region) => region.translation).join("\n"));
    entry.renderSource = renderSource; entry.regions = result.regions;
    entry.replaceSource = renderImageTranslation(canvas, renderSource, result.regions);
    entry.canvas = canvas; entry.showing = true; root!.prepend(canvas);
    entry.status.textContent = result.warning ?? "";
  } catch (error) {
    if (current()) entry.status.textContent = error instanceof Error ? error.message : t("imageTranslationFailedTryAgain");
  } finally {
    if (current()) { entry.busy = false; entry.button.disabled = false; updateButton(entry); updateLayout(); }
  }
}

function updateButton(entry: ImageEntry): void {
  entry.button.textContent = entry.showing ? t("originalBadge") : t("translateBadge");
  entry.button.title = entry.showing ? t("showOriginalImage") : entry.canvas ? t("showTranslatedImage") : t("translateImageTextAndOverlayTheOriginal");
  entry.button.setAttribute("aria-label", entry.button.title);
  entry.button.setAttribute("aria-pressed", String(entry.showing));
}

async function readImage(image: HTMLImageElement, presentation?: HTMLElement): Promise<{ canvas: HTMLCanvasElement; image: HTMLImageElement }> {
  const draw = (source: HTMLImageElement): HTMLCanvasElement => {
    const rect = (presentation ?? image).getBoundingClientRect();
    const size = getImageRasterSize(source.naturalWidth, source.naturalHeight, rect.width, rect.height, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("theBrowserCannotReadThisImage"));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toDataURL("image/png"); // Detect cross-origin canvas restrictions.
    return canvas;
  };
  try { return { canvas: draw(image), image }; } catch { /* Fetch a readable copy without changing the page image. */ }
  const url = imageSource(image);
  if (!/^https?:/i.test(url)) throw new Error(t("cannotReadThisImageTryAnImageOn"));
  const { dataUrl } = await sendRuntimeRequest<{ dataUrl: string }>({ type: "LOAD_IMAGE", url });
  const copy = new Image(); copy.src = dataUrl;
  await copy.decode();
  return { canvas: draw(copy), image: copy };
}
