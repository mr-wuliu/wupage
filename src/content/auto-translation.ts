import { isAutoTranslationWebsiteExcluded, languageFamily, matchesAutoTranslationSite, normalizeAutoTranslation } from "../shared/auto-translation";
import { SETTINGS_KEY } from "../shared/defaults";
import type { ExtensionSettings } from "../shared/types";
import { hasPageTranslations } from "./dom";
import { getPageTranslationState, hidePageTranslation, loadPageTranslationSettings, startPageTranslation, subscribePageTranslationState } from "./page-translation";
import { sendRuntimeRequest } from "./runtime";
import { isNonProseElement, isTranslationOptedOut } from "./content-policy";

interface AutoTranslationDependencies {
  loadSettings: () => Promise<ExtensionSettings>;
  start: (settings: ExtensionSettings) => Promise<unknown>;
  active: () => boolean;
  stop: () => void | Promise<void>;
  subscribe: typeof subscribePageTranslationState;
  detectLanguage?: (text: string) => Promise<{ languages: Array<{ language: string; percentage: number }> }>;
}

const OWNED = '.wupage-translation,.wupage-translation-pending,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-debug-panel,#wupage-paragraph-highlight,[data-wupage-video],[data-wupage-video-style],[data-wupage-video-native]';
const SKIP_TEXT = `${OWNED},script,style,noscript,pre,code,textarea,input,select,button,nav,header,footer,aside,[contenteditable="true"],[hidden],[aria-hidden="true"]`;

export function initAutoTranslation(overrides: Partial<AutoTranslationDependencies> = {}): () => void {
  if (typeof document === "undefined" || typeof window === "undefined" || window.top !== window
    || !/^https?:$/u.test(location.protocol) || !["text/html", "application/xhtml+xml"].includes(document.contentType)) return () => {};
  const deps: AutoTranslationDependencies = {
    loadSettings: loadPageTranslationSettings,
    start: startPageTranslation,
    active: () => getPageTranslationState().active || hasPageTranslations(),
    stop: hidePageTranslation,
    subscribe: listener => subscribePageTranslationState(listener),
    detectLanguage: typeof chrome !== "undefined" && chrome.i18n?.detectLanguage ? text => chrome.i18n.detectLanguage(text) : undefined,
    ...overrides
  };
  let settings: ExtensionSettings | undefined;
  let route = routeKey();
  let handled = deps.active();
  let previouslyActive = handled;
  let owned = false;
  let transitioning = false;
  let invokingStop = false;
  let generation = 0;
  let timer: number | undefined;
  let running = false;
  let dirty = false;
  let disposed = false;
  let lastSample = "";

  const unsubscribe = deps.subscribe(event => {
    checkRoute();
    const active = deps.active();
    // Automatic route/rule changes include an asynchronous background stop.
    // Its notifications are not a user's request to keep the page restored.
    if (transitioning) {
      if (event === "stopped" && !invokingStop) { handled = true; owned = false; generation++; }
      previouslyActive = active; return;
    }
    if (!active && (previouslyActive || event === "stopped")) {
      handled = true; owned = false; generation++;
    } else if (active) handled = true;
    previouslyActive = active;
    if (!active && !handled) schedule();
  });

  function stopOwned(): void {
    if (owned && deps.active()) {
      transitioning = true;
      invokingStop = true;
      let stopped: void | Promise<void>;
      try { stopped = deps.stop(); } catch { stopped = undefined; } finally { invokingStop = false; }
      void Promise.resolve(stopped).catch(() => {}).finally(() => {
        transitioning = false; previouslyActive = deps.active();
        if (previouslyActive) handled = true;
        schedule();
      });
    }
    owned = false; previouslyActive = deps.active();
  }

  function checkRoute(): void {
    const next = routeKey();
    if (next === route) return;
    generation++; route = next; lastSample = "";
    // A selected site/path still owns this same document. Its existing DOM
    // observer already handles new posts, including replies arriving later.
    if (owned && deps.active() && settings?.autoTranslation?.enabled
      && !isAutoTranslationWebsiteExcluded(settings.autoTranslation, location.href)
      && matchesAutoTranslationSite(settings.autoTranslation, location.href)) return;
    stopOwned(); handled = deps.active();
  }

  function schedule(): void {
    if (disposed || handled || !settings?.autoTranslation?.enabled || isAutoTranslationWebsiteExcluded(settings.autoTranslation, location.href) || document.visibilityState === "hidden") return;
    if (transitioning) return;
    if (running) { dirty = true; return; }
    if (timer !== undefined) return;
    timer = window.setTimeout(() => { timer = undefined; void evaluate(); }, 350);
  }

  async function evaluate(): Promise<void> {
    if (disposed || handled || transitioning || !settings || document.visibilityState === "hidden") return;
    running = true; dirty = false;
    const version = generation;
    const current = settings;
    try {
      if (deps.active()) { handled = true; return; }
      const config = normalizeAutoTranslation(current.autoTranslation);
      if (!config.enabled || isAutoTranslationWebsiteExcluded(config, location.href)) return;
      const siteMatch = matchesAutoTranslationSite(config, location.href);
      if (!siteMatch && !config.nonTargetLanguage) return;
      const samples = [pageText()];
      if (!overrides.start && chrome.runtime?.id && typeof chrome.runtime.onMessage?.addListener === "function") {
        const frames = await sendRuntimeRequest<unknown>({ type: "FRAME_SESSION_SAMPLES" }).catch(() => []);
        if (Array.isArray(frames)) samples.push(...frames.filter((sample): sample is string => typeof sample === "string"));
      }
      if (!samples.some(sample => sample.trim())) return;
      if (!siteMatch) {
        const candidates = samples.filter(sample => sample.length >= 40);
        if (!candidates.length) return;
        const signature = `${document.documentElement.lang}\n${current.targetLang}\n${candidates.join("\n")}`;
        if (signature === lastSample) return;
        let foreign = false;
        for (const sample of candidates) {
          let language = "";
          if (deps.detectLanguage) {
            const result = await deps.detectLanguage(sample);
            const best = result.languages[0];
            if (best && best.percentage >= 70 && best.language !== "und") language = languageFamily(best.language);
          } else language = languageFamily(document.documentElement.lang);
          if (disposed || version !== generation) return;
          if (language && language !== "und" && language !== languageFamily(current.targetLang)) { foreign = true; break; }
        }
        if (!foreign) {
          lastSample = signature; return;
        }
      }
      if (disposed || version !== generation || handled || deps.active() || document.hidden) return;
      handled = true; owned = true;
      await deps.start(current);
    } catch { /* Leave failures to the existing translation state; never retry automatically. */ }
    finally { running = false; if (dirty) schedule(); }
  }

  function applySettings(value: ExtensionSettings, initial = false): void {
    const config = normalizeAutoTranslation(value.autoTranslation);
    const identity = (entry: ExtensionSettings | undefined): string => JSON.stringify([entry?.autoTranslation, entry?.sourceLang, entry?.targetLang]);
    const changed = identity(settings) !== identity({ ...value, autoTranslation: config });
    const rulesChanged = JSON.stringify(settings?.autoTranslation) !== JSON.stringify(config);
    const stopped = handled && !owned && !deps.active();
    generation++;
    // Language changes must not resume a page the user explicitly restored.
    if (changed) { stopOwned(); handled = deps.active() || stopped && (initial || !rulesChanged); lastSample = ""; }
    settings = { ...value, autoTranslation: config };
    if (config.enabled && !isAutoTranslationWebsiteExcluded(config, location.href)) observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["lang", "hidden", "aria-hidden", "style", "class"]
    });
    else {
      observer.disconnect(); dirty = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
    schedule();
  }

  const observer = new MutationObserver(records => {
    checkRoute();
    if (records.every(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(OWNED))) return;
    if (!handled) { generation++; schedule(); }
  });
  const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local") return;
    const value = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (value) applySettings(value);
  };
  chrome.storage?.onChanged?.addListener(storageChanged);
  const pageChanged = (): void => { checkRoute(); schedule(); };
  const visibilityChanged = (): void => { generation++; if (document.visibilityState !== "hidden") pageChanged(); };
  const pageHidden = (event: PageTransitionEvent): void => {
    if (event.persisted) { generation++; if (timer !== undefined) clearTimeout(timer); timer = undefined; }
    else dispose();
  };
  window.addEventListener("popstate", pageChanged);
  window.addEventListener("hashchange", pageChanged);
  window.addEventListener("pageshow", pageChanged);
  window.addEventListener("pagehide", pageHidden);
  document.addEventListener("visibilitychange", visibilityChanged);
  void deps.loadSettings().then(value => { if (!disposed && !settings && value) applySettings(value, true); }).catch(() => {});

  function dispose(): void {
    if (disposed) return;
    disposed = true; generation++;
    if (timer !== undefined) clearTimeout(timer);
    observer.disconnect(); unsubscribe();
    chrome.storage?.onChanged?.removeListener?.(storageChanged);
    window.removeEventListener("popstate", pageChanged);
    window.removeEventListener("hashchange", pageChanged);
    window.removeEventListener("pageshow", pageChanged);
    window.removeEventListener("pagehide", pageHidden);
    document.removeEventListener("visibilitychange", visibilityChanged);
  }
  return dispose;
}

function routeKey(): string {
  const url = new URL(location.href);
  return url.origin + url.pathname + url.search + url.hash;
}

function pageText(): string {
  const roots = Array.from(document.querySelectorAll("main,article,[role='main']")).filter(textVisible);
  const root = roots.sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0] ?? document.body;
  if (!root) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let output = "";
  while (walker.nextNode() && output.length < 6000) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_TEXT) || isNonProseElement(parent) || isTranslationOptedOut(parent) || !node.textContent?.trim()) continue;
    if (textVisible(parent)) output += `${node.textContent}\n`;
  }
  return output.slice(0, 6000).trim();
}

function textVisible(element: Element): boolean {
  if (element.closest("[hidden],[aria-hidden='true']")) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
