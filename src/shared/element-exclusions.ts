import { t } from "./i18n";
import { matchesRegionSitePattern, normalizeRegionSitePattern } from "./region-site-pattern";

export interface ElementRule {
  id: string;
  name: string;
  pattern: string;
  selectors: string[];
  enabled: boolean;
}

export const ELEMENT_EXCLUSION_DEFAULTS_VERSION = 2;

export const DEFAULT_ELEMENT_EXCLUSIONS: ElementRule[] = [{
  id: "x-sidebar", get name() { return t("xSidebarNavigation"); }, pattern: "x.com", selectors: ['header[role="banner"]'], enabled: true
}, {
  id: "x-news", get name() { return t("xSidebarNews"); }, pattern: "x.com",
  selectors: ['[data-testid="sidebarColumn"] div:has(> [data-testid="news_sidebar"])'], enabled: true
}, {
  id: "x-trends", get name() { return t("xSidebarTrends"); }, pattern: "x.com",
  selectors: ['[data-testid="sidebarColumn"] section:has([data-testid="trend"])'], enabled: true
}, {
  id: "x-follow", get name() { return t("xSidebarFollow"); }, pattern: "x.com",
  selectors: ['[data-testid="sidebarColumn"] aside:has([data-testid="UserCell"])'], enabled: true
}, {
  id: "x-footer", get name() { return t("xSidebarFooter"); }, pattern: "x.com",
  selectors: ['[data-testid="sidebarColumn"] nav:has(a[href="https://x.com/tos"])'], enabled: true
}];

const PRESET_ADDED_VERSION: Record<string, number> = { "x-news": 1, "x-trends": 1, "x-follow": 2, "x-footer": 2 };

export interface ElementRuleSettings {
  elementExclusions?: ElementRule[];
  elementInclusions?: ElementRule[];
  elementExclusionDefaultsVersion?: number;
}

export function normalizeElementExclusions(value: unknown): ElementRule[] {
  return normalizeRules(value, DEFAULT_ELEMENT_EXCLUSIONS, "exclusion");
}

/** Add new presets once, preserving edits and an explicitly empty rule list. */
export function migrateElementExclusionDefaults(value: unknown, version: unknown): ElementRule[] {
  const rules = normalizeElementExclusions(value);
  const previousVersion = typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
  if (!Array.isArray(value) || value.length === 0
    || previousVersion >= ELEMENT_EXCLUSION_DEFAULTS_VERSION) return rules;
  const ids = new Set(rules.map(rule => rule.id));
  const additions = DEFAULT_ELEMENT_EXCLUSIONS.filter(rule => (PRESET_ADDED_VERSION[rule.id] ?? 0) > previousVersion && !ids.has(rule.id));
  return normalizeElementExclusions([...rules, ...additions]);
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
      const pattern = normalizeRegionSitePattern(entry.pattern);
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
  return rules.filter(rule => rule.enabled && (address === undefined || matchesRegionSitePattern(rule.pattern, address)))
    .map(rule => [rule.pattern, rule.selectors]);
}
