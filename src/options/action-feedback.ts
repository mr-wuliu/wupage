export const ACTION_STATUS_DURATION = 1200;
const statusTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

/** Transient success feedback must never erase a later validation/error message. */
export function showActionStatus(element: HTMLElement, message: string): void {
  clearTimeout(statusTimers.get(element));
  element.textContent = message;
  statusTimers.set(element, setTimeout(() => {
    if (element.textContent === message) element.textContent = "";
    statusTimers.delete(element);
  }, ACTION_STATUS_DURATION));
}

/** Delegate so dynamically rendered default/reset buttons get the same feedback. */
export function setupSettingsActionFeedback(root: Document): void {
  const events = new AbortController();
  const animations = new Map<HTMLElement, Animation>();
  root.addEventListener("click", event => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-settings-feedback]") : null;
    if (!button || !button.isConnected) return;
    animations.get(button)?.cancel();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = button.animate?.([
      { transform: "translateY(2px) scale(.96)", filter: "brightness(.9)" },
      { transform: "none", filter: "none" }
    ], { duration: 180, easing: "ease-out" });
    if (!animation) return;
    animations.set(button, animation);
    const finish = (): void => { if (animations.get(button) === animation) animations.delete(button); };
    void animation.finished.then(finish, finish);
  }, { signal: events.signal });
  window.addEventListener("pagehide", () => {
    events.abort();
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
    for (const timer of statusTimers.values()) clearTimeout(timer);
    statusTimers.clear();
  }, { once: true });
}
