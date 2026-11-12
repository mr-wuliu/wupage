import { initializeInterfaceLanguage, t } from "../shared/i18n";
import { getSettings } from "../shared/settings";
import { ocrRevision } from "./ocr-service";
import type { RuntimeRequest, RuntimeResponse } from "../shared/types";

export const IMAGE_MENU_ID = "wupage-translate-image";

export function initImageContextMenu(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleImageMenuClick(info, tab).catch(() => openImageSettings("refresh"));
  });
  void initializeInterfaceLanguage().then(refreshImageContextMenu).catch(error => console.warn("WuPage image menu:", error));
}

export function refreshImageContextMenu(): void {
  const properties: chrome.contextMenus.CreateProperties = {
    title: t("translateImageWithWupage"), contexts: ["image"], documentUrlPatterns: ["http://*/*", "https://*/*"]
  };
  // Menus persist across service-worker restarts; update the existing item first.
  // update() only returns a Promise in Chrome 123+. Keep callback support for
  // Chromium forks with an older extension API implementation.
  chrome.contextMenus.update(IMAGE_MENU_ID, properties, () => {
    if (!chrome.runtime.lastError) return;
    chrome.contextMenus.create({ ...properties, id: IMAGE_MENU_ID }, () => {
      if (chrome.runtime.lastError) console.warn("WuPage image menu:", chrome.runtime.lastError.message);
    });
  });
}

export async function handleImageMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== IMAGE_MENU_ID || !info.srcUrl || tab?.id === undefined) return;
  const settings = await getSettings();
  if (!settings.imageTranslationEnabled || !await ocrRevision(settings)) {
    await openImageSettings("setup");
    return;
  }
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_CONTEXT_IMAGE", srcUrl: info.srcUrl
  } satisfies RuntimeRequest, { frameId: info.frameId ?? 0 }) as RuntimeResponse | undefined;
  // Content reports selection errors next to the page. No receiver usually means
  // the tab predates the extension reload and needs a refresh.
  if (!response?.ok || typeof (response.data as { started?: unknown } | undefined)?.started !== "boolean") {
    await openImageSettings("refresh");
  }
}

async function openImageSettings(reason: "setup" | "refresh"): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}?imageTranslationNotice=${reason}` });
}
