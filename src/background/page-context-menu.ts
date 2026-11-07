import { initializeInterfaceLanguage, t } from "../shared/i18n";
import { SETTINGS_KEY } from "../shared/defaults";
import { getSettings } from "../shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../shared/types";

export const PAGE_MENU_ID = "wupage-toggle-page-translation";
const LEGACY_MENU_IDS = ["wupage-translate-paragraph", "wupage-restore-paragraph"];
let refreshActivePage = async (): Promise<void> => {};

export function initPageContextMenu(): void {
  // Register synchronously: a menu click can wake a suspended service worker.
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handlePageMenuClick(info, tab).catch(reportError);
  });
  let enabled = false;
  let translated = false;
  let revision = 0;
  let settingsRevision = 0;
  // Old persistent items must be removed before the new entry appears.
  let updates = Promise.all(LEGACY_MENU_IDS.map(id => new Promise<void>(resolve => {
    chrome.contextMenus.remove(id, () => { void chrome.runtime.lastError; resolve(); });
  }))).then(() => {}).catch(reportError);
  const sync = (): Promise<void> => {
    updates = updates.catch(reportError).then(async () => {
      await initializeInterfaceLanguage();
      return upsertMenu({
        title: translated ? t("restoreOriginal") : t("translateFullPage"),
        // 'page' also covers ordinary text in frames. Adding 'frame', 'link' or
        // 'selection' can overlap the image entry and recreate Chrome's submenu.
        contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"], visible: enabled
      });
    });
    return updates;
  };
  refreshActivePage = async () => {
    const current = ++revision;
    let next = false;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_TRANSLATION_STATE" } satisfies RuntimeRequest,
          { frameId: 0 }) as RuntimeResponse | undefined;
        next = response?.ok === true && (response.data as { translated?: unknown } | undefined)?.translated === true;
      }
    } catch { /* New, restricted and stale pages have no content listener. */ }
    if (current !== revision) return;
    translated = next;
    await sync();
  };
  const refresh = () => { void refreshActivePage().catch(reportError); };
  chrome.tabs?.onActivated?.addListener(refresh);
  chrome.tabs?.onUpdated?.addListener((_tabId, change, tab) => {
    if (tab.active && (change.status || change.url)) refresh();
  });
  chrome.windows?.onFocusChanged?.addListener(refresh);
  chrome.storage.onChanged?.addListener((changes, area) => {
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !settings) return;
    settingsRevision++;
    enabled = settings.contextMenuTranslationEnabled === true;
    void sync().catch(reportError);
    if (enabled) refresh();
  });
  const initialRevision = settingsRevision;
  void getSettings().then(async settings => {
    if (initialRevision !== settingsRevision) return;
    enabled = settings.contextMenuTranslationEnabled === true;
    await sync();
    await refreshActivePage();
  }).catch(reportError);
}

export async function refreshPageContextMenu(sender?: chrome.runtime.MessageSender): Promise<void> {
  if (sender && (sender.tab?.id === undefined || sender.frameId !== 0)) return;
  // Query the active page rather than trusting the sender: another tab may
  // have become active while a background page finished translating.
  await refreshActivePage();
}

function upsertMenu(properties: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.update(PAGE_MENU_ID, properties, () => {
      if (!chrome.runtime.lastError) { resolve(); return; }
      if (properties.visible === false) { resolve(); return; }
      chrome.contextMenus.create({ ...properties, id: PAGE_MENU_ID }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  });
}

export async function handlePageMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== PAGE_MENU_ID || tab?.id === undefined) return;
  if (!(await getSettings()).contextMenuTranslationEnabled) return;
  try {
    // The content action rechecks live state, including pending translations.
    // Always target the whole page, even if the menu was opened inside a frame.
    const response = await chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_TRANSLATION_SHORTCUT",
      command: "toggle-page-translation" } satisfies RuntimeRequest, { frameId: 0 }) as RuntimeResponse | undefined;
    if (!response?.ok || (response.data as { handled?: unknown } | undefined)?.handled !== true) {
      throw new Error("Page listener unavailable");
    }
  } catch {
    await chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}?pageTranslationNotice=refresh` });
  }
}

function reportError(error: unknown): void { console.warn("WuPage page menu:", error); }
