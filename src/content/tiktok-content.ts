const COMMENT_BODY_SELECTOR = "[data-e2e='comment-level-1'],[data-e2e='comment-level-2']";

export function tiktokCommentBody(element: Element): Element | null {
  if (!/(^|\.)tiktok\.com$/u.test(element.ownerDocument.location?.hostname ?? "")) return null;
  return element.closest(COMMENT_BODY_SELECTOR);
}
