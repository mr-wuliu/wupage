// Steam's community cards are navigable containers, not compact action labels.
const CARD_SELECTOR = ".apphub_Card[role='button'],.apphub_StoreInfoHeader[role='button']";
const TEXT_SELECTOR = [
  ".apphub_StoreAppText", ".apphub_CardTextContent", ".apphub_CardContentNewsTitle",
  ".apphub_CardContentDiscussionTitle", ".apphub_CardContentGuideTitle", ".apphub_CardContentGuideDesc",
  ".apphub_CardContentTitle", ".workshopItemTitle", ".workshopItemDescription",
  ".bb_h1", ".bb_h2", ".bb_h3", ".bb_paragraph"
].join(",");

export function isSteamCommunity(element: Element): boolean {
  return element.ownerDocument.location?.hostname === "steamcommunity.com";
}

export function isSteamContentCard(element: Element): boolean {
  return element.matches(CARD_SELECTOR) && isSteamCommunity(element);
}

/** Workshop's current UI uses generated CSS names; item URLs remain stable. */
export function steamItemTitle(element: Element): HTMLAnchorElement | null {
  if (!isSteamCommunity(element)) return null;
  const link = element.closest<HTMLAnchorElement>("a[href]");
  if (!link) return null;
  try {
    const url = new URL(link.href);
    return url.hostname === "steamcommunity.com" && /^\/(?:sharedfiles|workshop)\/filedetails\/?$/.test(url.pathname)
      && url.searchParams.has("id") ? link : null;
  } catch { return null; }
}

export function steamTextBlock(element: Element): Element | null {
  return isSteamCommunity(element) ? steamItemTitle(element) ?? element.closest(TEXT_SELECTOR) : null;
}
