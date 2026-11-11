const COMMENT_BODY_SELECTOR = ".comment .commtext";

function isHackerNews(document: Document): boolean {
  return document.location?.hostname === "news.ycombinator.com";
}

/** Site policy only: generic text flows own paragraph detection and grouping. */
export function isHackerNewsCommentChrome(element: Element): boolean {
  return isHackerNews(element.ownerDocument) && Boolean(element.closest("tr.comtr"))
    && !element.closest(COMMENT_BODY_SELECTOR);
}
