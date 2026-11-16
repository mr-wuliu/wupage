const FIREFOX_RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net", "accounts.firefox.com", "addons.cdn.mozilla.net", "addons.mozilla.org",
  "api.accounts.firefox.com", "content.cdn.mozilla.net", "discovery.addons.mozilla.org", "install.mozilla.org",
  "oauth.accounts.firefox.com", "profile.accounts.firefox.com", "support.mozilla.org", "sync.services.mozilla.com"
]);

/** Known browser restrictions, independent of the extension's feature settings. */
export function isRestrictedContentUrl(address?: string, frame = false): boolean {
  if (!address) return false;
  try {
    const url = new URL(address);
    // The frame bootstrap supports inherited origins on these document types.
    if (frame && (url.protocol === "blob:" || url.protocol === "data:"
      || address === "about:blank" || address === "about:srcdoc")) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const firefox = /\bFirefox\//u.test(agent);
    if (firefox) return FIREFOX_RESTRICTED_HOSTS.has(url.hostname);
    if (url.hostname === "chromewebstore.google.com"
      || url.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/u.test(url.pathname)) return true;
    return /\bEdg(?:A|iOS)?\//u.test(agent) && url.hostname === "microsoftedge.microsoft.com";
  } catch { return true; }
}
