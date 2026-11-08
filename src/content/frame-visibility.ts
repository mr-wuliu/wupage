import { t } from "../shared/i18n";
import { createDocumentKey } from "../shared/frame-session";
import { validVideoFrameArea, type VideoFrameArea } from "../shared/video-frame";
import { componentShadowRoot } from "./dom-roots";

const GEOMETRY_REQUEST = "wupage-video-frame-area";
const GEOMETRY_REPLY = "wupage-video-frame-area-result";

/** Page messages carry coordinates only; capturing pixels requires extension messaging. */
export async function topVideoFrameArea(area: VideoFrameArea, signal?: AbortSignal): Promise<VideoFrameArea> {
  signal?.throwIfAborted();
  if (!validVideoFrameArea(area)) throw new Error(t("bringTheEntireVideoIntoViewAndTry"));
  if (window === window.top) return area;
  const key = createDocumentKey();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== GEOMETRY_REPLY || event.data.key !== key) return;
      cleanup();
      if (validVideoFrameArea(event.data.area)) resolve(event.data.area);
      else reject(new Error(t("cannotLocateTheEmbeddedVideoBringTheEntire")));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(t("cannotLocateTheEmbeddedVideoTryOnThe"))); }, 2000);
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", cancel, { once: true });
    window.parent.postMessage({ type: GEOMETRY_REQUEST, key, area }, "*");
  });
}

const EVENT = "wupage:frame-visibility";
const scope = globalThis as typeof globalThis & { __wupageFrameRendered?: boolean };
export const frameIsRendered = (): boolean => scope.__wupageFrameRendered !== false;

/** Page messages carry geometry hints only, never translation commands or data. */
export function installFrameVisibilityBridge(): { ready: Promise<void> } {
  const key = createDocumentKey();
  const children = new Map<Window, { key: string; host?: HTMLIFrameElement; rendered?: boolean }>();
  const roots = new Set<Document | ShadowRoot>([document]);
  let observer: MutationObserver | undefined;
  let scheduled = false;
  let resolveReady = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = window === window.top ? Promise.resolve() : new Promise<void>(resolve => {
    resolveReady = resolve; timer = setTimeout(resolve, 300);
  });
  const rendered = (host?: Element): boolean => {
    if (!frameIsRendered()) return false;
    if (!host) return true; // Native intersection is the fallback for inaccessible hosts.
    if (!host.isConnected) return false;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let element: Element | null = host; element;) {
      const style = getComputedStyle(element);
      if (element.matches("[hidden],[aria-hidden='true']") || style.display === "none" || style.visibility === "hidden"
        || style.contentVisibility === "hidden" || Number(style.opacity) === 0) return false;
      element = element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
    }
    return true;
  };
  const flush = () => {
    scheduled = false;
    let removedRoot = false;
    for (const root of roots) if (!root.isConnected) { roots.delete(root); removedRoot = true; }
    if (removedRoot) { observer?.disconnect(); observeRoots(); }
    for (const [child, item] of children) {
      if (item.host && !item.host.isConnected) { children.delete(child); continue; }
      const next = rendered(item.host);
      if (next === item.rendered) continue;
      item.rendered = next;
      child.postMessage({ type: "wupage-frame-rendered", key: item.key, rendered: next }, "*");
    }
  };
  const observeRoots = () => {
    if (!observer) return;
    for (const root of roots) {
      const target = root instanceof Document ? root.documentElement : root;
      if (target) observer.observe(target, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden"] });
    }
  };
  const schedule = () => { if (!scheduled && children.size) { scheduled = true; requestAnimationFrame(flush); } };
  const findHost = (source: MessageEventSource | null, root: Document | ShadowRoot = document): HTMLIFrameElement | undefined => {
    for (const element of root.querySelectorAll("iframe,frame")) {
      if ((element as HTMLIFrameElement).contentWindow === source) return element as HTMLIFrameElement;
    }
    for (const element of root.querySelectorAll("*")) {
      const shadow = componentShadowRoot(element);
      if (shadow) { roots.add(shadow); const found = findHost(source, shadow); if (found) return found; }
    }
  };
  window.addEventListener("message", event => {
    if (event.data?.type === GEOMETRY_REQUEST && typeof event.data.key === "string" && event.data.key.length === 32
      && event.source && event.source !== window && event.source !== window.parent && validVideoFrameArea(event.data.area)) {
      const host = findHost(event.source);
      if (!host) return;
      const source = event.source as Window, key = event.data.key;
      for (let element: Element | null = host; element;) {
        const transform = getComputedStyle(element).transform;
        if (transform && transform !== "none") {
          const matrix = new DOMMatrixReadOnly(transform);
          if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) {
            source.postMessage({ type: GEOMETRY_REPLY, key }, "*"); return;
          }
        }
        element = element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
      }
      const area = event.data.area as VideoFrameArea, rect = host.getBoundingClientRect();
      const sx = rect.width / (host.offsetWidth || rect.width), sy = rect.height / (host.offsetHeight || rect.height);
      const x = rect.left + host.clientLeft * sx, y = rect.top + host.clientTop * sy;
      const scaleX = host.clientWidth * sx / area.viewport.width, scaleY = host.clientHeight * sy / area.viewport.height;
      void topVideoFrameArea({ rect: { x: x + area.rect.x * scaleX, y: y + area.rect.y * scaleY,
        width: area.rect.width * scaleX, height: area.rect.height * scaleY }, viewport: { width: innerWidth, height: innerHeight } })
        .then(area => source.postMessage({ type: GEOMETRY_REPLY, key, area }, "*"),
          () => source.postMessage({ type: GEOMETRY_REPLY, key }, "*"));
      return;
    }
    if (event.source === window.parent && event.data?.type === "wupage-frame-rendered" && event.data.key === key
      && typeof event.data.rendered === "boolean") {
      clearTimeout(timer); resolveReady();
      const changed = scope.__wupageFrameRendered !== event.data.rendered;
      scope.__wupageFrameRendered = event.data.rendered;
      if (changed) {
        document.dispatchEvent(new Event(EVENT)); schedule();
      }
    }
    if (event.data?.type !== "wupage-frame-render-request" || typeof event.data.key !== "string" || event.data.key.length !== 32
      || !event.source || event.source === window || event.source === window.parent) return;
    // Only an actual immediate child WindowProxy can request a geometry hint.
    let child: Window | undefined;
    for (let index = 0; index < window.frames.length; index++) if (window.frames[index] === event.source) child = window.frames[index];
    if (!child) return;
    const host = findHost(event.source);
    children.set(child, { key: event.data.key, host });
    flush();
    if (!observer && document.documentElement) {
      observer = new MutationObserver(schedule);
    }
    observeRoots();
  });
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", () => { if (window !== window.top) window.parent.postMessage({ type: "wupage-frame-render-request", key }, "*"); schedule(); });
  if (window !== window.top) window.parent.postMessage({ type: "wupage-frame-render-request", key }, "*");
  return { ready };
}
