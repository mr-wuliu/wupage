import { normalizeElementExclusions, normalizeElementInclusions, type ElementRule, type ElementRuleSettings } from "../shared/element-exclusions";
import { matchesSitePattern } from "../shared/auto-translation";
import { composedParent } from "./dom-roots";

let rules = { exclude: normalizeElementExclusions(undefined), include: normalizeElementInclusions(undefined) };
let signature = JSON.stringify(rules);
type RegionSelectors = Record<keyof typeof rules, string[]>;
let documents = new WeakMap<Document, { address: string; selectors: RegionSelectors }>();
let appliedSelectors: string | undefined;

function selectorsFor(document: Document): RegionSelectors {
  const address = document.URL;
  const cached = documents.get(document);
  if (cached?.address === address) return cached.selectors;
  const probe = document.createElement("div");
  const matching = (entries: ElementRule[]): string[] => [...new Set(entries.filter(rule => rule.enabled && matchesSitePattern(rule.pattern, address))
    .flatMap(rule => rule.selectors))].filter(selector => {
      try { probe.matches(selector); return true; } catch { return false; }
    });
  const selectors = { exclude: matching(rules.exclude), include: matching(rules.include) };
  documents.set(document, { address, selectors });
  return selectors;
}

/** Return whether the current document's effective region rules changed. */
export function configureElementRules(settings: ElementRuleSettings): boolean {
  const current = () => typeof document !== "undefined" ? JSON.stringify(selectorsFor(document)) : "";
  const before = appliedSelectors ?? current();
  const normalized = { exclude: normalizeElementExclusions(settings.elementExclusions),
    include: normalizeElementInclusions(settings.elementInclusions) };
  const next = JSON.stringify(normalized);
  if (signature !== next) { rules = normalized; signature = next; documents = new WeakMap(); }
  appliedSelectors = current();
  return before !== appliedSelectors;
}

export function matchesElementExclusion(element: Element): boolean {
  return selectorsFor(element.ownerDocument).exclude.some(selector => element.matches(selector));
}

export function isElementExcluded(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (matchesElementExclusion(current)) return true;
  }
  return false;
}

export function containsElementRuleBoundary(element: Element): boolean {
  const { exclude, include } = selectorsFor(element.ownerDocument);
  return exclude.some(selector => element.querySelector(selector)) || include.some(selector => element.querySelector(selector));
}

/** Find the nearest region whose visible text can bypass automatic filters. */
export function forcedTextRoot(element: Element): Element | null {
  const { include } = selectorsFor(element.ownerDocument);
  if (!include.length) return null;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    for (const selector of include) if (current.matches(selector)) return current;
  }
  return null;
}

/** Observe both rendering changes and attributes used by region rules. */
export function observedTranslationAttributes(document: Document): string[] {
  const attributes = new Set(["id", "class", "style", "hidden", "aria-hidden", "placeholder", "alt", "open", "translate", "contenteditable", "role"]);
  const { exclude, include } = selectorsFor(document);
  for (const selector of [...exclude, ...include]) {
    for (const match of selector.matchAll(/\[\s*([\w:-]+)/gu)) attributes.add(match[1]);
  }
  return [...attributes];
}
