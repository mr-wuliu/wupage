import { describe, expect, it } from "vitest";
import { elementRuleIdentity, normalizeElementExclusions } from "../src/shared/element-exclusions";
import { normalizeSettings } from "../src/shared/settings";
import { matchesSitePattern } from "../src/shared/auto-translation";

describe("element exclusion settings", () => {
  it("seeds only X for old and new settings without mutating defaults", () => {
    const rules = normalizeSettings({}).elementExclusions!;
    expect(rules).toEqual([{ id: "x-sidebar", name: "X 侧边导航栏", pattern: "x.com", selectors: ['header[role="banner"]'], enabled: true }]);
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
    const rules = normalizeElementExclusions(undefined);
    expect(elementRuleIdentity({ elementExclusions: rules })).toBe(elementRuleIdentity({ elementExclusions: [{ ...rules[0], id: "renamed", name: "Custom label" }] }));
    expect(elementRuleIdentity({ elementExclusions: [{ ...rules[0], enabled: false }] })).toBe(elementRuleIdentity({ elementExclusions: [] }));
    const includes = { elementInclusions: rules };
    expect(elementRuleIdentity(includes, "https://example.com/")).toBe(elementRuleIdentity({}, "https://example.com/"));
    expect(elementRuleIdentity(includes, "https://x.com/home")).not.toBe(elementRuleIdentity({}, "https://x.com/home"));
  });
});
