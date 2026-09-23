import { getSettings } from "../shared/settings";
import { installedRevision } from "../ocr/model-store";
import type { RuntimeRequest, RuntimeResponse } from "../shared/types";

export const IMAGE_MENU_ID = "wupage-translate-image";

export function initImageContextMenu(): void {
  const properties: chrome.contextMenus.CreateProperties = {
    title: "使用 WuPage 翻译图片", contexts: ["image"], documentUrlPatterns: ["http://*/*", "https://*/*"]
  };
  // Menus persist across service-worker restarts; update the existing item first.
  void chrome.contextMenus.update(IMAGE_MENU_ID, properties).catch(() => {
    chrome.contextMenus.create({ ...properties, id: IMAGE_MENU_ID }, () => {
      if (chrome.runtime.lastError) console.warn("WuPage image menu:", chrome.runtime.lastError.message);
    });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleImageMenuClick(info, tab).catch(() => openImageSettings("refresh"));
  });
}

export async function handleImageMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== IMAGE_MENU_ID || !info.srcUrl || tab?.id === undefined) return;
  const settings = await getSettings();
  if (!settings.imageTranslationEnabled || !await installedRevision()) {
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
