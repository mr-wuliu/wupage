import { initializeInterfaceLanguage, t } from "../shared/i18n";
import { getSettings } from "../shared/settings";
import { SETTINGS_KEY } from "../shared/defaults";
import { isRestrictedContentUrl } from "../shared/content-access";
import { ocrRevision } from "./ocr-service";
import type { RuntimeRequest, RuntimeResponse } from "../shared/types";

export const IMAGE_MENU_ID = "wupage-translate-image";
let menuUpdates: Promise<void> = Promise.resolve();

export function initImageContextMenu(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleImageMenuClick(info, tab).catch(reportError);
  });
  const refresh = () => { void refreshImageContextMenu().catch(reportError); };
  chrome.tabs.onActivated?.addListener(refresh);
  chrome.tabs.onUpdated?.addListener((_tabId, change, tab) => {
    if (tab.active && (change.url || change.status)) refresh();
  });
  chrome.windows?.onFocusChanged?.addListener(refresh);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      refresh();
    }
  });
  void initializeInterfaceLanguage().then(refreshImageContextMenu).catch(reportError);
}

export function refreshImageContextMenu(): Promise<void> {
  menuUpdates = menuUpdates.catch(() => undefined).then(updateImageContextMenu);
  return menuUpdates;
}

async function updateImageContextMenu(): Promise<void> {
  const [settings, tabs] = await Promise.all([getSettings(), chrome.tabs.query({ active: true, lastFocusedWindow: true })]);
  const restricted = isRestrictedContentUrl(tabs[0]?.url);
  const properties: chrome.contextMenus.CreateProperties = {
    title: t(restricted ? "imageTranslationUnavailableOnThisPage" : "translateImageWithWupage"),
    contexts: ["image"], documentUrlPatterns: ["http://*/*", "https://*/*"], enabled: !restricted,
    visible: settings.imageTranslationEnabled === true && settings.imageTranslationContextMenuEnabled !== false
  };
  // Menus persist across service-worker restarts; update the existing item first.
  // update() only returns a Promise in Chrome 123+. Keep callback support for
  // Chromium forks with an older extension API implementation.
  await new Promise<void>((resolve, reject) => {
    chrome.contextMenus.update(IMAGE_MENU_ID, properties, () => {
      if (!chrome.runtime.lastError) { resolve(); return; }
      chrome.contextMenus.create({ ...properties, id: IMAGE_MENU_ID }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

export async function handleImageMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== IMAGE_MENU_ID || !info.srcUrl || tab?.id === undefined) return;
  const settings = await getSettings();
  if (settings.imageTranslationContextMenuEnabled === false) return;
  // A stale menu can outlive a navigation. A restricted document cannot be
  // repaired by enabling OCR or refreshing the page, so never open settings.
  if (isRestrictedContentUrl(info.pageUrl) || isRestrictedContentUrl(tab.url)
    || isRestrictedContentUrl(info.frameUrl, true)) return;
  if (!settings.imageTranslationEnabled || !await ocrRevision(settings)) {
    await openImageSettings("setup");
    return;
  }
  let response: RuntimeResponse | undefined;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_CONTEXT_IMAGE", srcUrl: info.srcUrl
    } satisfies RuntimeRequest, { frameId: info.frameId ?? 0 }) as RuntimeResponse | undefined;
  } catch {
    await openImageSettings("refresh");
    return;
  }
  // Content reports selection errors next to the page. No receiver usually means
  // the tab predates the extension reload and needs a refresh.
  if (!response?.ok || typeof (response.data as { started?: unknown } | undefined)?.started !== "boolean") {
    await openImageSettings("refresh");
  }
}

async function openImageSettings(reason: "setup" | "refresh"): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}?imageTranslationNotice=${reason}` });
}

function reportError(error: unknown): void { console.warn("WuPage image menu:", error); }
