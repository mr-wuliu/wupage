import { ProviderError } from "./errors";
import { t } from "./i18n";

function providerSite(address: string): URL | undefined {
  // Chromium can grant individual origins from the withheld <all_urls> permission.
  if (globalThis.location?.protocol === "moz-extension:") return;
  try {
    const url = new URL(address);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch { /* Leave invalid addresses to provider validation. */ }
}

function siteAccessError(site: URL): ProviderError {
  return new ProviderError(t("providerSiteAccessRequired", site.origin), "permission-required");
}

function sitePermission(site: URL): chrome.permissions.Permissions {
  // Omitting a port in a Chromium match pattern asks for every port, including
  // when the user has already granted access to the site's default port alone.
  const port = site.port || (site.protocol === "https:" ? "443" : "80");
  return { origins: [`${site.protocol}//${site.hostname}:${port}/*`] };
}

export async function requireProviderSiteAccess(address: string): Promise<void> {
  const site = providerSite(address);
  const permissions = globalThis.chrome?.permissions;
  if (!site || !permissions?.contains) return;
  const granted = await permissions.contains(sitePermission(site)).catch(() => undefined);
  if (granted === false) throw siteAccessError(site);
}

// Call directly from the settings button's click handler to retain the user gesture.
export function requestProviderSiteAccess(address: string): Promise<void> | undefined {
  const site = providerSite(address);
  const permissions = globalThis.chrome?.permissions;
  if (!site || !permissions?.request) return;
  return permissions.request(sitePermission(site)).catch(() => false).then((granted) => {
    if (!granted) throw siteAccessError(site);
  });
}
