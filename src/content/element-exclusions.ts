import { normalizeElementExclusions, type ElementExclusionRule } from "../shared/element-exclusions";
import { matchesSitePattern } from "../shared/auto-translation";
import { composedParent } from "./dom-roots";

let rules = normalizeElementExclusions(undefined);
let signature = JSON.stringify(rules);
let documents = new WeakMap<Document, { address: string; selectors: string[] }>();
let appliedSelectors: string | undefined;

function selectorsFor(document: Document): string[] {
  const address = document.URL;
  const cached = documents.get(document);
  if (cached?.address === address) return cached.selectors;
  const probe = document.createElement("div");
  const selectors = [...new Set(rules.filter(rule => rule.enabled && matchesSitePattern(rule.pattern, address))
    .flatMap(rule => rule.selectors))].filter(selector => {
      try { probe.matches(selector); return true; } catch { return false; }
    });
  documents.set(document, { address, selectors });
  return selectors;
}

/** Return whether the current document's effective exclusions changed. */
export function configureElementExclusions(value: ElementExclusionRule[] | undefined): boolean {
  const before = appliedSelectors ?? (typeof document !== "undefined" ? JSON.stringify(selectorsFor(document)) : "[]");
  const normalized = normalizeElementExclusions(value);
  const next = JSON.stringify(normalized);
  if (signature !== next) { rules = normalized; signature = next; documents = new WeakMap(); }
  appliedSelectors = typeof document !== "undefined" ? JSON.stringify(selectorsFor(document)) : "[]";
  return before !== appliedSelectors;
}

export function matchesElementExclusion(element: Element): boolean {
  return selectorsFor(element.ownerDocument).some(selector => element.matches(selector));
}

export function isElementExcluded(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (matchesElementExclusion(current)) return true;
  }
  return false;
}

export function containsExcludedElement(element: Element): boolean {
  return selectorsFor(element.ownerDocument).some(selector => element.querySelector(selector));
}

/** Observe selector attributes too, including arbitrary data-* attributes. */
export function exclusionObservedAttributes(document: Document): string[] {
  const attributes = new Set<string>(["id"]);
  for (const selector of selectorsFor(document)) {
    for (const match of selector.matchAll(/\[\s*([\w:-]+)/gu)) attributes.add(match[1]);
  }
  return [...attributes];
}
