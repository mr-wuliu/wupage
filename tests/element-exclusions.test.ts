import { describe, expect, it } from "vitest";
import { elementRuleIdentity, normalizeElementExclusions } from "../src/shared/element-exclusions";
import { normalizeSettings } from "../src/shared/settings";
import { matchesSitePattern } from "../src/shared/auto-translation";

describe("element exclusion settings", () => {
  it("seeds X navigation, news, trends, follow suggestions and footer without mutating defaults", () => {
    const rules = normalizeSettings({}).elementExclusions!;
    expect(rules).toEqual([
      { id: "x-sidebar", name: "X 侧边导航栏", pattern: "x.com", selectors: ['header[role="banner"]'], enabled: true },
      { id: "x-news", name: "X 新闻", pattern: "x.com", selectors: ['[data-testid="sidebarColumn"] div:has(> [data-testid="news_sidebar"])'], enabled: true },
      { id: "x-trends", name: "X 趋势", pattern: "x.com", selectors: ['[data-testid="sidebarColumn"] section:has([data-testid="trend"])'], enabled: true },
      { id: "x-follow", name: "X 推荐关注", pattern: "x.com", selectors: ['[data-testid="sidebarColumn"] aside:has([data-testid="UserCell"])'], enabled: true },
      { id: "x-footer", name: "X 页脚", pattern: "x.com", selectors: ['[data-testid="sidebarColumn"] nav:has(a[href="https://x.com/tos"])'], enabled: true }
    ]);
    rules[0].selectors.push(".another");
    expect(normalizeElementExclusions(undefined)[0].selectors).toHaveLength(1);
    expect(matchesSitePattern(rules[0].pattern, "https://x.com/home")).toBe(true);
    expect(matchesSitePattern(rules[0].pattern, "https://notx.com/home")).toBe(false);
  });

  it("retains explicitly deleted and disabled presets across saves", () => {
    expect(normalizeSettings({ elementExclusions: [] }).elementExclusions).toEqual([]);
    const rules = normalizeElementExclusions(undefined); rules[0].enabled = false;
    expect(normalizeSettings(normalizeSettings({ elementExclusions: rules })).elementExclusions?.[0].enabled).toBe(false);
  });

  it("adds only new presets to legacy settings once and preserves custom and disabled entries", () => {
    const rules = normalizeElementExclusions(undefined);
    const custom = { id: "custom", name: "My rule", pattern: "example.com", selectors: [".private"], enabled: true };
    const existingNews = { ...rules[1], name: "My news rule", selectors: [".my-news"], enabled: false };
    const migrated = normalizeSettings({ elementExclusions: [custom, existingNews] });
    expect(migrated.elementExclusions).toEqual([custom, existingNews, ...rules.slice(2)]);
    expect(migrated.elementExclusionDefaultsVersion).toBe(2);
    migrated.elementExclusions = [custom];
    expect(normalizeSettings(migrated).elementExclusions).toEqual([custom]);
    expect(normalizeSettings(normalizeSettings(migrated))).toEqual(normalizeSettings(migrated));
  });

  it("adds follow and footer to version 1 without restoring previously deleted rules", () => {
    const rules = normalizeElementExclusions(undefined);
    const existingFollow = { ...rules[3], selectors: [".my-follow-card"], enabled: false };
    const migrated = normalizeSettings({ elementExclusions: [rules[0], existingFollow], elementExclusionDefaultsVersion: 1 });
    expect(migrated.elementExclusions).toEqual([rules[0], existingFollow, rules[4]]);
    migrated.elementExclusions!.pop();
    expect(normalizeSettings(migrated).elementExclusions).toEqual([rules[0], existingFollow]);
    expect(normalizeSettings({ elementExclusions: [], elementExclusionDefaultsVersion: 1 }).elementExclusions).toEqual([]);
  });

  it("keeps the maximum of 100 rules when adding new presets", () => {
    const rules = Array.from({ length: 100 }, (_, i) => ({ id: `custom-${i}`, name: `Rule ${i}`, pattern: "example.com", selectors: [".private"], enabled: true }));
    expect(normalizeSettings({ elementExclusions: rules }).elementExclusions).toEqual(rules);
  });

  it("normalizes imported rules independently and keeps selectors as data", () => {
    const value = [{ id: "same", name: " Sidebar ", pattern: "EXAMPLE.com/docs/*", selectors: [" .sidebar ", ".sidebar", 42, ""], enabled: false },
      { id: "same", pattern: "https://*.example.org/*", selectors: ["[data-region='ads']"] },
      { pattern: "javascript://invalid", selectors: ["body"] }, { pattern: "example.net", selectors: [] }];
    const rules = normalizeElementExclusions(value);
    expect(rules).toHaveLength(2); expect(rules[0]).toMatchObject({ name: "Sidebar", pattern: "example.com/docs/*", selectors: [".sidebar"], enabled: false });
    expect(rules[1].id).not.toBe(rules[0].id);
    expect(normalizeElementExclusions(rules)).toEqual(rules);
  });

  it("does not restart translations for renamed or disabled entries", () => {
    const rules = normalizeElementExclusions(undefined).slice(0, 1);
    expect(elementRuleIdentity({ elementExclusions: rules })).toBe(elementRuleIdentity({ elementExclusions: [{ ...rules[0], id: "renamed", name: "Custom label" }] }));
    expect(elementRuleIdentity({ elementExclusions: [{ ...rules[0], enabled: false }] })).toBe(elementRuleIdentity({ elementExclusions: [] }));
    const includes = { elementInclusions: rules };
    expect(elementRuleIdentity(includes, "https://example.com/")).toBe(elementRuleIdentity({}, "https://example.com/"));
    expect(elementRuleIdentity(includes, "https://x.com/home")).not.toBe(elementRuleIdentity({}, "https://x.com/home"));
  });
});
