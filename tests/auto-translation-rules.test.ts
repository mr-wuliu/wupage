import { describe, expect, it } from "vitest";
import { addAutoTranslationWebsite, currentWebsitePattern, excludeAutoTranslationWebsite, hasAutoTranslationWebsite, isAutoTranslationWebsiteExcluded, languageFamily, matchesAutoTranslationSite, matchesSitePattern, normalizeAutoTranslation, normalizeSitePattern, setAutoTranslationEnabled } from "../src/shared/auto-translation";
import { normalizeSettings } from "../src/shared/settings";
import { matchesRegionSitePattern, normalizeRegionSitePattern } from "../src/shared/region-site-pattern";

describe("automatic translation site rules", () => {
  it.each([
    ["example.com", "https://example.com/article", true],
    ["example.com", "http://docs.example.com/article", true],
    ["example.com", "https://evil-example.com/", false],
    ["example.com", "https://example.com.evil.test/", false],
    ["*.example.com", "https://example.com/", false],
    ["*.example.com", "https://docs.example.com/", true],
    ["https://example.com/docs/*", "https://example.com/docs/a/b", true],
    ["https://example.com/docs/*", "http://example.com/docs/a", false],
    ["example.com/docs/*", "https://example.com/blog/a", false],
    ["example.com/docs/a", "https://example.com/docs/ab", false],
    ["example.com/a.b/*/end", "https://example.com/axb/c/end", false],
    ["example.com/a.b/*/end", "https://example.com/a.b/c/end?x=1#part", true],
    ["127.0.0.1:6543/docs/*", "http://127.0.0.1:6543/docs/a", true],
    ["127.0.0.1:6543/docs/*", "http://127.0.0.1:6544/docs/a", false],
    ["example.com", "file:///example.com/a", false],
    ["[::1]:6543", "http://[::1]:6543/docs", true],
    ["https://example.com:443", "https://example.com:8443/docs", false],
    ["example.com:80", "http://example.com/docs", true],
    ["example.com:443", "http://example.com/docs", false]
  ])("matches %s against %s as %s", (pattern, url, result) => {
    expect(matchesSitePattern(pattern, url)).toBe(result);
  });

  it.each(["", "https://user:pass@example.com", "ftp://example.com", "javascript:alert(1)", "https://example.com/?q=1", "example.*.com", "*.127.0.0.1", "example..com"])(
    "rejects an invalid rule %s", pattern => expect(() => normalizeSitePattern(pattern)).toThrow()
  );

  it("normalizes domains, Unicode hosts and paths without changing path case", () => {
    expect(normalizeSitePattern(" HTTPS://Example.COM/Docs/** ")).toBe("https://example.com/Docs/*");
    expect(normalizeSitePattern("例子.测试")).toContain("xn--");
  });

  it("accepts a URL in the path of a rule with or without a leading protocol", () => {
    const pattern = "example.invalid/docs/https://reference.invalid/*";
    expect(normalizeSitePattern(pattern)).toBe(pattern);
    expect(normalizeRegionSitePattern(pattern)).toBe(pattern);
    for (const matches of [matchesSitePattern, matchesRegionSitePattern]) {
      const address = "example.invalid/docs/https://reference.invalid/article";
      expect(matches(pattern, `http://${address}`)).toBe(true);
      expect(matches(pattern, `https://${address}`)).toBe(true);
      expect(matches(`https://${pattern}`, `http://${address}`)).toBe(false);
      expect(matches(`https://${pattern}`, `https://${address}`)).toBe(true);
    }
  });

  it("keeps old installations disabled and normalizes only valid rules", () => {
    expect(normalizeSettings({}).autoTranslation).toEqual({ enabled: false, nonTargetLanguage: false, presetSites: [], customSites: [] });
    const settings = normalizeAutoTranslation({ enabled: true, nonTargetLanguage: "true", presetSites: ["github.com", "unknown.test", "github.com"], customSites: [
      { id: "one", pattern: "Example.com", enabled: false },
      { id: "one", pattern: "*.example.net", enabled: true },
      { pattern: "example.com" }, { pattern: "javascript:bad" }, null
    ] });
    expect(settings.nonTargetLanguage).toBe(false);
    expect(settings.presetSites).toEqual(["github.com"]);
    expect(settings.customSites).toHaveLength(2);
    expect(new Set(settings.customSites.map(site => site.id)).size).toBe(2);
    expect(matchesAutoTranslationSite(settings, "https://github.com/a")).toBe(true);
    expect(matchesAutoTranslationSite(settings, "https://example.com/a")).toBe(false);
    expect(matchesAutoTranslationSite(settings, "https://docs.example.net/a")).toBe(true);
    expect(matchesAutoTranslationSite({ ...settings, enabled: false }, "https://github.com/a")).toBe(false);
  });

  it("compares language variants as the same language", () => {
    expect(languageFamily("en-US")).toBe(languageFamily("en"));
    expect(languageFamily("zh_Hans")).toBe(languageFamily("zh-CN"));
  });

  it("only supplies a first-use language rule when no site rules have been configured", () => {
    expect(setAutoTranslationEnabled(undefined, true)).toEqual({ enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] });
    const configured = { enabled: false, nonTargetLanguage: false, presetSites: [],
      customSites: [{ id: "one", pattern: "example.com", enabled: false }] };
    expect(setAutoTranslationEnabled(configured, true)).toEqual({ ...configured, enabled: true });
    expect(configured.enabled).toBe(false);
  });

  it("keeps deleted presets removed and does not enable a broader language rule", () => {
    const rules = normalizeAutoTranslation({ enabled: true, presetSites: ["github.com"], removedPresetSites: ["github.com", "unknown.test"] });
    expect(rules.presetSites).toEqual([]);
    expect(rules.removedPresetSites).toEqual(["github.com"]);
    expect(matchesAutoTranslationSite(rules, "https://github.com/a")).toBe(false);
    expect(setAutoTranslationEnabled(rules, true).nonTargetLanguage).toBe(false);
  });

  it.each([
    ["https://Example.com/docs/page?q=secret#part", "example.com"],
    ["http://localhost:4321/article", "localhost:4321"],
    ["http://[::1]:4321/article", "[::1]:4321"],
    ["https://例子.测试/文章", "xn--fsqu00a.xn--0zwm56d"]
  ])("adds the whole current website from %s without retaining page data", (address, pattern) => {
    const original = normalizeAutoTranslation({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"] });
    const added = addAutoTranslationWebsite(original, address);
    expect(currentWebsitePattern(address)).toBe(pattern);
    expect(added.customSites).toEqual([{ id: expect.any(String), pattern, enabled: true }]);
    expect(added.nonTargetLanguage).toBe(false);
    expect(added.presetSites).toEqual(["github.com"]);
    expect(original.customSites).toEqual([]);
    expect(hasAutoTranslationWebsite(added, address)).toBe(true);
    expect(addAutoTranslationWebsite(added, address)).toEqual(added);
  });

  it("re-enables an existing whole-site rule and preserves its identity", () => {
    const rules = normalizeAutoTranslation({ enabled: true, customSites: [{ id: "existing", pattern: "https://example.com/*", enabled: false }] });
    const added = addAutoTranslationWebsite(rules, "https://example.com/article");
    expect(added.customSites).toEqual([{ id: "existing", pattern: "https://example.com/*", enabled: true }]);
    expect(rules.customSites[0].enabled).toBe(false);
  });

  it("restores a removed preset only when explicitly adding that website", () => {
    const added = addAutoTranslationWebsite({ enabled: true, removedPresetSites: ["github.com", "medium.com"] }, "https://github.com/user/repo");
    expect(added.presetSites).toEqual(["github.com"]);
    expect(added.removedPresetSites).toEqual(["medium.com"]);
    expect(added.customSites).toEqual([]);
  });

  it("reuses a covering enabled rule and keeps disabled parent and path rules narrow", () => {
    const parent = { enabled: true, customSites: [{ id: "parent", pattern: "example.com", enabled: true }] };
    expect(addAutoTranslationWebsite(parent, "https://docs.example.com/article").customSites).toHaveLength(1);
    const disabled = { ...parent, customSites: [{ ...parent.customSites[0], enabled: false }] };
    const added = addAutoTranslationWebsite(disabled, "https://docs.example.com/article");
    expect(added.customSites).toEqual([{ ...disabled.customSites[0] }, { id: expect.any(String), pattern: "docs.example.com", enabled: true }]);
    const path = { enabled: true, customSites: [{ id: "path", pattern: "example.com/docs/*", enabled: true }] };
    expect(hasAutoTranslationWebsite(path, "https://example.com/docs/a")).toBe(false);
    expect(addAutoTranslationWebsite(path, "https://example.com/docs/a").customSites).toHaveLength(2);
  });

  it.each([undefined, "file:///book.pdf", "edge://settings", "chrome-extension://id/popup.html", "about:blank", "invalid"])("does not add an unsupported page %s", address => {
    expect(currentWebsitePattern(address)).toBeUndefined();
    expect(hasAutoTranslationWebsite({ enabled: true }, address)).toBe(false);
    expect(() => addAutoTranslationWebsite({ enabled: true }, address)).toThrow("普通网页");
  });

  it("does not enable automatic translation implicitly when adding a site", () => {
    expect(() => addAutoTranslationWebsite(undefined, "https://example.com/article")).toThrow("请先开启自动翻译");
  });

  it("excludes only the current host while retaining parent rules and restores it without duplicates", () => {
    const original = normalizeAutoTranslation({ enabled: true, nonTargetLanguage: true, presetSites: ["github.com"],
      customSites: [{ id: "parent", pattern: "example.com", enabled: true }] });
    const address = "https://docs.example.com/article?q=1";
    const excluded = excludeAutoTranslationWebsite(original, address);
    expect(excluded).toEqual({ ...original, excludedSites: ["docs.example.com"] });
    expect(isAutoTranslationWebsiteExcluded(excluded, address)).toBe(true);
    expect(hasAutoTranslationWebsite(excluded, address)).toBe(false);
    expect(matchesAutoTranslationSite(excluded, address)).toBe(false);
    expect(matchesAutoTranslationSite(excluded, "https://other.example.com/")).toBe(true);
    expect(excludeAutoTranslationWebsite(excluded, address)).toEqual(excluded);
    expect(addAutoTranslationWebsite(excluded, address)).toEqual(original);
    expect(original.excludedSites).toBeUndefined();
  });

  it("normalizes exact-host exclusions and preserves explicit language choices when enabling", () => {
    const rules = normalizeAutoTranslation({ excludedSites: ["EXAMPLE.com", "https://example.com/", "localhost:4321", "*.example.com", "example.com/docs", "file:///book.pdf", null] });
    expect(rules.excludedSites).toEqual(["example.com", "localhost:4321"]);
    expect(isAutoTranslationWebsiteExcluded(rules, "http://localhost:4321/article")).toBe(true);
    expect(isAutoTranslationWebsiteExcluded(rules, "http://localhost:4322/article")).toBe(false);
    expect(setAutoTranslationEnabled(rules, true).nonTargetLanguage).toBe(false);
    expect(() => excludeAutoTranslationWebsite({ enabled: true }, "file:///book.pdf")).toThrow("普通网页");
  });
});
