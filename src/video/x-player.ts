const X_APP_PLAYER_SELECTOR = "[data-testid='app-player-container']";
const X_PLAYER_SELECTOR = "[data-testid='videoPlayer']";
const X_COMPONENT_SELECTOR = "[data-testid='videoComponent']";
const X_EXIT_FULLSCREEN_SELECTOR = "[data-testid='videoPlayerExitFullScreenButton' i]";

export const X_VIDEO_CONTROL_SELECTOR = [X_APP_PLAYER_SELECTOR, X_COMPONENT_SELECTOR, "[data-testid^='videoPlayer']"].join(",");

export function isXVideoHost(hostname = location.hostname): boolean {
  return /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/iu.test(hostname);
}

export function xPlayerScope(video: HTMLVideoElement): HTMLElement | null {
  return video.closest<HTMLElement>(X_APP_PLAYER_SELECTOR)
    ?? video.closest<HTMLElement>(X_PLAYER_SELECTOR)
    ?? video.closest<HTMLElement>(X_COMPONENT_SELECTOR);
}

export function hasXFullscreenControl(scope: ParentNode): boolean {
  // The exit button can identify an expanded viewer without a Fullscreen API event.
  return [...scope.querySelectorAll(X_EXIT_FULLSCREEN_SELECTOR)].some(control => control.getClientRects().length > 0);
}
