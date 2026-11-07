import { t } from "./i18n";
import { matchesSitePattern, normalizeSitePattern } from "./auto-translation";

export interface ElementExclusionRule {
  id: string;
  name: string;
  pattern: string;
  selectors: string[];
  enabled: boolean;
}

export const DEFAULT_ELEMENT_EXCLUSIONS: ElementExclusionRule[] = [{
  id: "x-sidebar", get name() { return t("xSidebarNavigation"); }, pattern: "x.com", selectors: ['header[role="banner"]'], enabled: true
}];

export function normalizeElementExclusions(value: unknown): ElementExclusionRule[] {
  const entries = Array.isArray(value) ? value : DEFAULT_ELEMENT_EXCLUSIONS;
  const rules: ElementExclusionRule[] = [];
  const ids = new Set<string>();
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry !== "object" || typeof entry.pattern !== "string" || !Array.isArray(entry.selectors)) continue;
    try {
      const pattern = normalizeSitePattern(entry.pattern);
      const selectors = [...new Set<string>(entry.selectors.filter((selector: unknown): selector is string => typeof selector === "string")
        .map((selector: string) => selector.trim()).filter((selector: string) => selector.length > 0 && selector.length <= 4096))].slice(0, 100);
      if (!selectors.length) continue;
      let id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 100) : `exclusion-${rules.length}`;
      while (ids.has(id)) id += "-1";
      ids.add(id);
      rules.push({ id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 80) : pattern,
        pattern, selectors, enabled: entry.enabled !== false });
    } catch { /* Invalid imported entries must not discard unrelated settings. */ }
  }
  return rules;
}

/** Names and rule IDs do not change which content is translated. */
export function elementExclusionIdentity(value: unknown, address?: string): string {
  return JSON.stringify(normalizeElementExclusions(value).filter(rule => rule.enabled && (address === undefined || matchesSitePattern(rule.pattern, address)))
    .map(rule => [rule.pattern, rule.selectors]));
}
