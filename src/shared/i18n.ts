import type messages from "../../public/_locales/en/messages.json";
import { isContextInvalidatedError } from "./extension-context";

export type MessageKey = keyof typeof messages;
export type InterfaceLanguage = "browser" | "zh-CN" | "en";
export const INTERFACE_LANGUAGE_KEY = "wupage.interface-language";

type BrowserNamespace = { browser?: { i18n?: typeof chrome.i18n } };
type Catalog = Partial<Record<MessageKey, {
  message: string;
  placeholders?: Record<string, { content: string }>;
}>>;

const catalogs = new Map<Exclude<InterfaceLanguage, "browser">, Promise<Catalog>>();
let selectedLanguage: InterfaceLanguage = "browser";
let catalog: Catalog | undefined;
let ready: Promise<void> | undefined;
let runtimeLanguageRequest: Promise<void> | undefined;
// Keep at most the last result per message, so stale controls can retain their
// labels during teardown without repeatedly calling an invalid extension API.
const nativeMessages = new WeakMap<object, Map<MessageKey, { values: string; text: string }>>();
const invalidatedApis = new WeakSet<object>();

function messageApi() {
  return typeof globalThis.chrome?.i18n?.getMessage === "function" ? globalThis.chrome.i18n : (globalThis as BrowserNamespace).browser?.i18n;
}

function nativeMessage(key: MessageKey, values: unknown[] = []): string | undefined {
  const api = messageApi();
  if (!api) return;
  const substitutions = values.map(String), signature = JSON.stringify(substitutions);
  let cached = nativeMessages.get(api);
  if (!invalidatedApis.has(api)) {
    try {
      const text = api.getMessage(key, substitutions.length ? substitutions : undefined);
      if (text) {
        if (!cached) { cached = new Map(); nativeMessages.set(api, cached); }
        cached.set(key, { values: signature, text });
      }
      return text;
    } catch (error) {
      if (!isContextInvalidatedError(error)) throw error;
      invalidatedApis.add(api);
    }
  }
  const previous = cached?.get(key);
  return previous?.values === signature ? previous.text : undefined;
}

function normalizeLanguage(value: unknown): InterfaceLanguage {
  return value === "en" || value === "zh-CN" ? value : "browser";
}

function loadCatalog(language: Exclude<InterfaceLanguage, "browser">): Promise<Catalog> {
  let pending = catalogs.get(language);
  if (!pending) {
    const folder = language === "zh-CN" ? "zh_CN" : "en";
    pending = fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`)).then(async response => {
      if (!response.ok) throw new Error(`Unable to load interface language: ${language}`);
      return await response.json() as Catalog;
    }).catch(error => {
      catalogs.delete(language);
      throw error;
    });
    catalogs.set(language, pending);
  }
  return pending;
}

async function applyLanguage(value: unknown): Promise<void> {
  const language = normalizeLanguage(value);
  catalog = language === "browser" || language === nativeMessage("interfaceLanguage")
    ? undefined : await loadCatalog(language);
  selectedLanguage = language;
}

export async function initializeInterfaceLanguage(): Promise<void> {
  if (!messageApi() && typeof globalThis.chrome?.runtime?.sendMessage === "function"
    && typeof globalThis.chrome?.storage?.local?.get !== "function") {
    // Chromium offscreen documents only have runtime APIs. Ask the background
    // for the effective locale, including a saved override, on each operation.
    runtimeLanguageRequest ??= (ready ?? Promise.resolve()).then(async () => {
      const language = await chrome.runtime.sendMessage({ target: "wupage-interface-language" });
      if (language?.locale !== "en" && language?.locale !== "zh-CN") throw new Error("Unable to read interface language.");
      catalog = await loadCatalog(language.locale);
      selectedLanguage = normalizeLanguage(language.selected);
    }).catch(reportLocaleError).finally(() => { runtimeLanguageRequest = undefined; });
    ready = runtimeLanguageRequest;
  } else {
    ready ??= Promise.resolve().then(async () => {
      const stored = await globalThis.chrome?.storage?.local?.get?.(INTERFACE_LANGUAGE_KEY);
      await applyLanguage(stored?.[INTERFACE_LANGUAGE_KEY]);
    }).catch(reportLocaleError);
  }
  let pending: Promise<void>;
  do {
    pending = ready;
    await pending;
  } while (pending !== ready);
}

/** Background and offscreen pages can outlive the settings page. */
export function watchInterfaceLanguage(refresh?: () => void): void {
  if (messageApi() && typeof globalThis.chrome?.storage?.local?.get === "function") {
    chrome.runtime?.onMessage?.addListener((request, sender, sendResponse) => {
      if (request?.target !== "wupage-interface-language" || sender.id !== chrome.runtime.id || sender.tab) return;
      void initializeInterfaceLanguage().then(() => sendResponse({ selected: selectedLanguage, locale: t("interfaceLanguage") }));
      return true;
    });
  }
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[INTERFACE_LANGUAGE_KEY]) return;
    const value = changes[INTERFACE_LANGUAGE_KEY].newValue;
    // Apply changes in order, including when the catalog for an earlier choice
    // is still loading.
    const update = (ready ?? Promise.resolve()).then(() => applyLanguage(value)).catch(reportLocaleError);
    ready = update;
    void update.then(() => { if (ready === update) refresh?.(); });
  });
}

function reportLocaleError(error: unknown): void {
  console.warn("WuPage interface language:", error);
}

export function getInterfaceLanguage(): InterfaceLanguage {
  return selectedLanguage;
}

function translate(key: MessageKey, values: unknown[]): string | undefined {
  const entry = catalog?.[key];
  if (typeof entry?.message === "string") {
    return entry.message.replace(/\$([A-Z][A-Z0-9_]*)\$/gi, (_, name: string) => {
      const index = entry.placeholders?.[name.toLowerCase()]?.content.slice(1);
      return index === undefined ? "" : String(values[Number(index) - 1] ?? "");
    });
  }
  return nativeMessage(key, values);
}

export function t(key: MessageKey, ...values: unknown[]): string {
  // The video page bridge and OCR sandbox have no extension APIs. Their receiver
  // resolves these tokens in the extension's locale before displaying them.
  return translate(key, values) || `__MSG_${key}__`;
}

export function resolveBridgeMessage(value: string): string {
  const match = /^__MSG_([a-zA-Z0-9_]+)__$/.exec(value);
  return match ? translate(match[1] as MessageKey, []) || value : value;
}

export function htmlMessage(key: MessageKey, ...values: unknown[]): string {
  return t(key, ...values).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Applies only to marked, extension-owned static markup, before controls are populated. */
export function localizeDocument(doc: Document): void {
  doc.documentElement.lang = t("interfaceLanguage");
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const node = Array.from(element.childNodes).find(child => child.nodeType === 3 && child.textContent?.trim());
    if (node) node.textContent = node.textContent!.replace(/\S[\s\S]*\S|\S/, () => t(element.dataset.i18n as MessageKey));
  }
  for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
    const marker = "data-i18n-" + attribute;
    for (const element of doc.querySelectorAll(`[${marker}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(marker) as MessageKey));
    }
  }
}
