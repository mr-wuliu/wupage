import type { ExtensionSettings, TranslateImageResponse } from "../shared/types";
import { hasRuntimeContext, sendRuntimeRequest } from "./runtime";
import { renderImageTranslation } from "./image-rendering";

interface ImageEntry {
  image: HTMLImageElement;
  source: string;
  button: HTMLButtonElement;
  status: HTMLDivElement;
  canvas?: HTMLCanvasElement;
  busy: boolean;
  showing: boolean;
  generation: number;
  manual?: boolean;
  contextOccluder?: Element | null;
  presentation?: HTMLElement;
  hoverBounds?: { left: number; top: number; right: number; bottom: number; buttonLeft: number };
}

const HOST_ID = "wupage-image-tools";
const entries = new Map<HTMLImageElement, ImageEntry>();
let host: HTMLDivElement | undefined;
let root: ShadowRoot | undefined;
let enabled = false;
let observer: MutationObserver | undefined;
let resizeObserver: ResizeObserver | undefined;
let scanTimer: number | undefined;
let frame: number | undefined;
let hoverFrame: number | undefined;
let pointer: { x: number; y: number } | undefined;
let initialized = false;
let contextTarget: { image: HTMLImageElement; source: string } | undefined;

export function initImageTranslation(): void {
  if (initialized || !hasRuntimeContext()) return;
  initialized = true;
  let revision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["wupage.settings"]) return;
    revision += 1;
    const settings = changes["wupage.settings"].newValue as ExtensionSettings | undefined;
    const previous = changes["wupage.settings"].oldValue as ExtensionSettings | undefined;
    if (previous && settings && previous.imageTranslationEnabled === settings.imageTranslationEnabled
      && previous.sourceLang === settings.sourceLang && previous.targetLang === settings.targetLang
      && previous.activeProviderId === settings.activeProviderId
      && JSON.stringify(previous.providers) === JSON.stringify(settings.providers)) return;
    // Clear old language/provider results as well as pending responses.
    setImageTranslationEnabled(false);
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
    observer?.disconnect(); resizeObserver?.disconnect();
    window.removeEventListener("scroll", scheduleLayout, true);
    window.removeEventListener("resize", scheduleScan);
    document.removeEventListener("load", scheduleScan, true);
    document.removeEventListener("contextmenu", rememberContextImage, true);
    document.removeEventListener("pointermove", trackPointer, true);
    document.removeEventListener("pointerout", leavePage, true);
    window.removeEventListener("blur", clearPointer);
    if (hoverFrame !== undefined) window.cancelAnimationFrame(hoverFrame);
    hoverFrame = undefined; pointer = undefined;
    contextTarget = undefined;
    if (scanTimer !== undefined) window.clearTimeout(scanTimer);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    scanTimer = undefined; frame = undefined;
    entries.forEach((entry) => { entry.generation += 1; });
    entries.clear(); host?.remove(); host = undefined; root = undefined;
    return;
  }
  createHost();
  observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== host
      && !(record.target instanceof Element && record.target.closest(`#${HOST_ID},.wupage-translation`)))) scheduleScan();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["src", "srcset", "sizes", "width", "height", "style", "class", "hidden"] });
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(scheduleLayout);
  window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleScan, { passive: true });
  document.addEventListener("load", scheduleScan, true);
  document.addEventListener("contextmenu", rememberContextImage, true);
  document.addEventListener("pointermove", trackPointer, { capture: true, passive: true });
  document.addEventListener("pointerout", leavePage, true);
  window.addEventListener("blur", clearPointer);
  scanImages();
}

function createHost(): void {
  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("translate", "no");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;";
  root = host.attachShadow({ mode: "open" });
  root.addEventListener("focusin", scheduleHover);
  root.addEventListener("focusout", scheduleHover);
  const style = document.createElement("style");
  style.textContent = `
    button{position:fixed;box-sizing:border-box;width:30px;height:30px;padding:0;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#1856ba;box-shadow:0 2px 8px #0003;cursor:pointer;pointer-events:auto;font:600 13px/1 system-ui,sans-serif}
    button:hover,button[aria-pressed=true]{background:#1856ba;color:#fff}
    button:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
    button:disabled{cursor:wait;opacity:.8}
    canvas{position:fixed;pointer-events:none;box-sizing:content-box}
    .status{position:fixed;max-width:min(280px,85vw);padding:7px 10px;background:#172033;color:#fff;border-radius:7px;font:12px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;pointer-events:none}
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
  for (const [image, entry] of entries) {
    if (!image.isConnected || entry.source !== imageSource(image)) {
      entry.generation += 1; entry.button.remove(); entry.status.remove(); entry.canvas?.remove();
      resizeObserver?.unobserve(image); entries.delete(image);
    }
  }
  for (const image of document.images) {
    if (entries.has(image) || !imageSource(image) || !image.complete || !image.naturalWidth
      || image.naturalWidth < 80 || image.naturalHeight < 40
      || image.closest("[contenteditable='true'],.wupage-translation")) continue;
    createEntry(image);
  }
  updateLayout();
}

function createEntry(image: HTMLImageElement): ImageEntry {
  const existing = entries.get(image);
  if (existing && existing.source === imageSource(image)) return existing;
  if (existing) {
    existing.generation += 1; existing.button.remove(); existing.status.remove(); existing.canvas?.remove();
  }
  const button = document.createElement("button");
  button.type = "button"; button.textContent = "译"; button.title = "翻译图片文字并覆盖原文";
  button.setAttribute("aria-label", "翻译图片"); button.setAttribute("aria-pressed", "false");
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
    if (!settings.imageTranslationEnabled) throw new Error("请先在 WuPage 设置中安装 OCR 模型并开启图片翻译。");
    setImageTranslationEnabled(true);
    let image: HTMLImageElement | undefined;
    if (selected && (selected.source === srcUrl || selected.image.src === srcUrl)) {
      if (!selected.image.isConnected || imageSource(selected.image) !== selected.source) throw new Error("这张图片已变化，请重新右键点击图片。");
      image = selected.image;
    } else {
      const candidates = Array.from(document.images).filter((candidate) => {
        if (imageSource(candidate) !== srcUrl && candidate.src !== srcUrl) return false;
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
          && rect.left < window.innerWidth && rect.top < window.innerHeight;
      });
      if (candidates.length > 1) throw new Error("页面中有多张相同图片，请重新右键点击需要翻译的那一张。");
      image = candidates[0];
    }
    if (!image) throw new Error("未找到这张图片，请等待图片加载完成后重新右键翻译。");
    if (!image.complete || !image.naturalWidth) throw new Error("图片尚未加载完成，请稍后重试。");
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
    showContextNotice(error instanceof Error ? error.message : "图片翻译失败，请重试。");
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
  text.style.cssText = "max-width:320px;padding:12px 16px;background:#172033;color:white;border-radius:8px;font:14px/1.6 system-ui,sans-serif";
  shadow.append(text); document.documentElement.append(notice);
  window.setTimeout(() => notice.remove(), 10_000);
}

function imageSource(image: HTMLImageElement): string { return image.currentSrc || image.src; }

function scheduleLayout(): void {
  if (!enabled || frame !== undefined) return;
  frame = window.requestAnimationFrame(() => { frame = undefined; updateLayout(); });
}

function trackPointer(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY };
  scheduleHover();
}

function leavePage(event: PointerEvent): void {
  if (!event.relatedTarget) clearPointer();
}

function clearPointer(): void { pointer = undefined; scheduleHover(); }

function scheduleHover(): void {
  if (!enabled || hoverFrame !== undefined) return;
  hoverFrame = window.requestAnimationFrame(() => { hoverFrame = undefined; updateHover(); });
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
    entry.button.hidden = !bounds || (!hovered && !keyboardFocus);
  }
}

function updateLayout(): void {
  for (const entry of entries.values()) {
    const { image, button, status, canvas } = entry;
    entry.hoverBounds = undefined;
    // Resolve for automatic buttons too, and refresh when a feed replaces nodes.
    entry.presentation = imagePresentation(image);
    const presentation = entry.presentation ?? image;
    const rect = presentation.getBoundingClientRect();
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    let hidden = !image.isConnected || imageSource(image) !== entry.source
      || rect.width < (entry.manual ? 1 : 80) || rect.height < (entry.manual ? 1 : 40);
    if (hidden || right - left < 30 || bottom - top < 30) {
      button.hidden = true; status.hidden = true; if (canvas) canvas.hidden = true;
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
    hidden ||= right - left < 30 || bottom - top < 30;
    if (!hidden && document.elementFromPoint) {
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      hidden = Boolean(hit && hit !== image && !hit.contains(image) && !presentation.contains(hit)
        && !(entry.manual && (hit === entry.contextOccluder || entry.contextOccluder?.contains(hit))));
    }
    if (hidden) button.hidden = true;
    status.hidden = hidden || !status.textContent;
    if (canvas) canvas.hidden = hidden || !entry.showing;
    if (hidden) continue;
    const buttonLeft = right + 4 + 30 < window.innerWidth ? right + 4 : right - 34;
    entry.hoverBounds = { left, top, right, bottom, buttonLeft: Math.max(0, buttonLeft) };
    button.style.left = `${Math.max(0, buttonLeft)}px`; button.style.top = `${top + 4}px`;
    status.style.left = `${Math.max(4, Math.min(buttonLeft, window.innerWidth - 290))}px`; status.style.top = `${top + 38}px`;
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
      Object.assign(canvas.style, {
        left: `${cx}px`, top: `${cy}px`, width: `${width}px`, height: `${height}px`,
        objectFit: entry.presentation ? (/^(cover|contain)$/.test(style.backgroundSize) ? style.backgroundSize : "fill") : style.objectFit || "fill",
        objectPosition: entry.presentation ? style.backgroundPosition || "50% 50%" : style.objectPosition || "50% 50%",
        borderRadius: style.borderRadius, opacity: style.opacity, filter: style.filter,
        clipPath: `inset(${Math.max(0, top - cy)}px ${Math.max(0, cx + width - right)}px ${Math.max(0, cy + height - bottom)}px ${Math.max(0, left - cx)}px)`
      });
    }
  }
  updateHover();
}

async function translateImage(entry: ImageEntry): Promise<void> {
  if (entry.busy) return;
  if (entry.canvas) {
    entry.showing = !entry.showing; updateButton(entry); updateLayout(); return;
  }
  const generation = ++entry.generation;
  const current = () => enabled && entry.generation === generation && entry.image.isConnected
    && imageSource(entry.image) === entry.source && entries.get(entry.image) === entry;
  entry.busy = true; entry.button.disabled = true; entry.button.textContent = "…";
  entry.status.textContent = "正在识别并翻译图片文字…"; updateLayout();
  try {
    const source = await readImage(entry.image);
    if (!current()) return;
    const result = await sendRuntimeRequest<TranslateImageResponse>({ type: "TRANSLATE_IMAGE",
      dataUrl: source.toDataURL("image/png"), width: source.width, height: source.height });
    if (!current()) return;
    if (!result.regions.length) { entry.status.textContent = "未发现需要翻译的文字。"; return; }
    const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", result.regions.map((region) => region.translation).join("\n"));
    renderImageTranslation(canvas, source, result.regions);
    entry.canvas = canvas; entry.showing = true; root!.prepend(canvas);
    entry.status.textContent = result.warning ?? "";
  } catch (error) {
    if (current()) entry.status.textContent = error instanceof Error ? error.message : "图片翻译失败，请重试。";
  } finally {
    if (current()) { entry.busy = false; entry.button.disabled = false; updateButton(entry); updateLayout(); }
  }
}

function updateButton(entry: ImageEntry): void {
  entry.button.textContent = entry.showing ? "原" : "译";
  entry.button.title = entry.showing ? "显示原图" : entry.canvas ? "显示图片译文" : "翻译图片文字并覆盖原文";
  entry.button.setAttribute("aria-label", entry.button.title);
  entry.button.setAttribute("aria-pressed", String(entry.showing));
}

async function readImage(image: HTMLImageElement): Promise<HTMLCanvasElement> {
  const draw = (source: HTMLImageElement): HTMLCanvasElement => {
    const scale = Math.min(1, 4096 / Math.max(source.naturalWidth, source.naturalHeight),
      Math.sqrt(16_000_000 / (source.naturalWidth * source.naturalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法读取图片。");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toDataURL("image/png"); // Detect cross-origin canvas restrictions.
    return canvas;
  };
  try { return draw(image); } catch { /* Fetch a readable copy without changing the page image. */ }
  const url = imageSource(image);
  if (!/^https?:/i.test(url)) throw new Error("此图片无法读取，请在普通网页图片上重试。");
  const { dataUrl } = await sendRuntimeRequest<{ dataUrl: string }>({ type: "LOAD_IMAGE", url });
  const copy = new Image(); copy.src = dataUrl;
  await copy.decode();
  return draw(copy);
}
