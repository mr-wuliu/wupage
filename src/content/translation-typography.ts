import { composedContains, onTranslationRoot, translationRoots } from "./dom-roots";
const TYPOGRAPHY = [
  "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
  "line-height", "letter-spacing", "word-spacing", "text-transform", "text-align"
] as const;

// Some results must be siblings to avoid the source's clipping/line clamp.
// Only those results need an explicit link; descendants keep native inheritance.
const sources = new Map<HTMLElement, Element>();
const observed = new Set<Element>();
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let refreshTimer: number | undefined;
let unobserveRoots: (() => void) | undefined;

function copyTypography(output: HTMLElement, source: Element): void {
  const style = window.getComputedStyle(source);
  for (const name of TYPOGRAPHY) {
    const value = style.getPropertyValue?.(name);
    if (value && (output.style.getPropertyValue(name) !== value || output.style.getPropertyPriority(name) !== "important")) {
      output.style.setProperty(name, value, "important");
    }
  }
}

function scheduleRefresh(): void {
  refreshTimer ??= window.setTimeout(refreshTypography, 16);
}

function refreshTypography(): void {
  refreshTimer = undefined;
  for (const [output, source] of sources) {
    if (!output.isConnected || !source.isConnected) sources.delete(output);
    else copyTypography(output, source);
  }
  if (!sources.size) { clearTranslationTypography(); return; }
  const active = new Set(sources.values());
  for (const source of observed) {
    if (active.has(source)) continue;
    resizeObserver?.unobserve(source);
    observed.delete(source);
  }
}

export function linkTranslationTypography(output: HTMLElement, source: Element): void {
  if (source.contains(output)) return;
  sources.set(output, source);
  copyTypography(output, source);
  if (!mutationObserver) {
    mutationObserver = new MutationObserver(records => {
      if (records.some(record => {
        if (record.type === "childList") return record.removedNodes.length > 0
          || (record.target instanceof Element && record.target.matches("style,head"));
        const target = record.target;
        // Our own style updates must not schedule another measurement cycle.
        return target instanceof Element && !target.closest(".wupage-translation,.wupage-translation-pending")
          && [...sources.values()].some(source => composedContains(target, source));
      })) scheduleRefresh();
    });
    const options = {
      subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "dir", "lang", "hidden"]
    };
    for (const root of translationRoots()) mutationObserver.observe(root, options);
    unobserveRoots = onTranslationRoot(root => mutationObserver?.observe(root, options));
    if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    document.fonts?.addEventListener("loadingdone", scheduleRefresh);
  }
  if (!observed.has(source)) { observed.add(source); resizeObserver?.observe(source); }
}

export function clearTranslationTypography(): void {
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  refreshTimer = undefined;
  mutationObserver?.disconnect();
  unobserveRoots?.(); unobserveRoots = undefined;
  resizeObserver?.disconnect();
  mutationObserver = undefined;
  resizeObserver = undefined;
  window.removeEventListener("resize", scheduleRefresh);
  document.fonts?.removeEventListener("loadingdone", scheduleRefresh);
  sources.clear();
  observed.clear();
}
