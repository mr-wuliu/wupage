export const TOUCH_INPUT_QUERY = "(any-hover: none) and (any-pointer: coarse)";

export function hasTouchInput(): boolean {
  return window.matchMedia?.(TOUCH_INPUT_QUERY).matches === true
    || navigator.maxTouchPoints > 0 && window.matchMedia?.("(any-pointer: fine)").matches !== true;
}

/** Fixed overlays follow the area left visible by zoom, browser chrome and the keyboard. */
export function visibleViewport() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
  return { left, top, width, height, right: left + width, bottom: top + height };
}
