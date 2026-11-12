export const TWITCH_MESSAGE_BODY_SELECTOR = "[data-a-target='chat-line-message-body']";
const MESSAGE_SELECTOR = ".chat-line__message";
const IDENTITY_SELECTOR = ".chat-line__username-container,[data-a-target='chat-message-username']";

function isTwitch(element: Element): boolean {
  return /(^|\.)twitch\.tv$/u.test(element.ownerDocument.location?.hostname ?? "");
}

/** Chat prose lives in an aside, independently of its clickable author label. */
export function twitchMessageBody(element: Element): Element | null {
  if (!isTwitch(element)) return null;
  const body = element.closest(TWITCH_MESSAGE_BODY_SELECTOR);
  return body?.closest(MESSAGE_SELECTOR) ? body : null;
}

export function isTwitchChatIdentity(element: Element): boolean {
  return isTwitch(element) && Boolean(element.closest(MESSAGE_SELECTOR) && element.closest(IDENTITY_SELECTOR));
}
