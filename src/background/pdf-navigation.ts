import { isLikelyPdfUrl, pdfRedirectKey } from "../pdf/launch";

// A PDF viewer exposes the final download URL, which may already have expired
// when the user clicks Translate. Retain the publisher URL for this document.
export function installPdfNavigation(): void {
  const navigation = chrome.webNavigation;
  const session = chrome.storage?.session;
  if (!navigation?.onBeforeNavigate || !session) return;
  const pending = new Map<number, string>();
  navigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    if (/^https?:/u.test(url) && isLikelyPdfUrl(url)) pending.set(tabId, url);
    else pending.delete(tabId);
  });
  navigation.onCommitted.addListener(({ tabId, frameId, documentId, url, transitionQualifiers }) => {
    if (frameId !== 0) return;
    const source = pending.get(tabId);
    pending.delete(tabId);
    const key = pdfRedirectKey(tabId);
    if (source && documentId && transitionQualifiers.includes("server_redirect") && source !== url && isLikelyPdfUrl(url)) {
      void session.set({ [key]: { source, documentId } }).catch(() => {});
    } else {
      void session.remove(key).catch(() => {});
    }
  });
  navigation.onErrorOccurred.addListener(({ tabId, frameId, url }) => {
    if (frameId === 0 && pending.get(tabId) === url) pending.delete(tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    pending.delete(tabId);
    void session.remove(pdfRedirectKey(tabId)).catch(() => {});
  });
}
