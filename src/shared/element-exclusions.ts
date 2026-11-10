import { t } from "./i18n";
import { matchesSitePattern, normalizeSitePattern } from "./auto-translation";

export interface ElementRule {
  id: string;
  name: string;
  pattern: string;
  selectors: string[];
  enabled: boolean;
}

export const DEFAULT_ELEMENT_EXCLUSIONS: ElementRule[] = [{
  id: "x-sidebar", get name() { return t("xSidebarNavigation"); }, pattern: "x.com", selectors: ['header[role="banner"]'], enabled: true
}];

export interface ElementRuleSettings {
  elementExclusions?: ElementRule[];
  elementInclusions?: ElementRule[];
}

export function normalizeElementExclusions(value: unknown): ElementRule[] {
  return normalizeRules(value, DEFAULT_ELEMENT_EXCLUSIONS, "exclusion");
}

export function normalizeElementInclusions(value: unknown): ElementRule[] {
  return normalizeRules(value, [], "inclusion");
}

function normalizeRules(value: unknown, defaults: ElementRule[], prefix: string): ElementRule[] {
  const entries = Array.isArray(value) ? value : defaults;
  const rules: ElementRule[] = [];
  const ids = new Set<string>();
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry !== "object" || typeof entry.pattern !== "string" || !Array.isArray(entry.selectors)) continue;
    try {
      const pattern = normalizeSitePattern(entry.pattern);
      const selectors = [...new Set<string>(entry.selectors.filter((selector: unknown): selector is string => typeof selector === "string")
        .map((selector: string) => selector.trim()).filter((selector: string) => selector.length > 0 && selector.length <= 4096))].slice(0, 100);
      if (!selectors.length) continue;
      let id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 100) : `${prefix}-${rules.length}`;
      while (ids.has(id)) id += "-1";
      ids.add(id);
      rules.push({ id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 80) : pattern,
        pattern, selectors, enabled: entry.enabled !== false });
    } catch { /* Invalid imported entries must not discard unrelated settings. */ }
  }
  return rules;
}

/** Names and rule IDs do not change which content is translated. */
export function elementRuleIdentity(settings: ElementRuleSettings, address?: string): string {
  return JSON.stringify([enabledRules(normalizeElementExclusions(settings.elementExclusions), address),
    enabledRules(normalizeElementInclusions(settings.elementInclusions), address)]);
}

function enabledRules(rules: ElementRule[], address?: string): Array<[string, string[]]> {
  return rules.filter(rule => rule.enabled && (address === undefined || matchesSitePattern(rule.pattern, address)))
    .map(rule => [rule.pattern, rule.selectors]);
}
