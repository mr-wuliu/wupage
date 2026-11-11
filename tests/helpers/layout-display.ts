// Retain the DOM's default display values while mocking geometry/visibility.
// Cache probes: jsdom's full CSS cascade is expensive in large scan fixtures.
const computedStyle = window.getComputedStyle.bind(window);
const defaults = new Map<string, string>();
export function layoutDisplay(element: Element): string {
  if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") return "inline";
  const explicit = (element as HTMLElement).style.display;
  if (explicit) return explicit;
  let display = defaults.get(element.localName);
  if (!display) {
    display = computedStyle(document.createElement(element.localName)).display || "inline";
    defaults.set(element.localName, display);
  }
  return display;
}
