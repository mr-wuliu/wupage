import { describe, expect, it, vi } from "vitest";
import { matchesSitePattern, normalizeSitePattern } from "../src/shared/auto-translation";
import { matchesRegionSitePattern as matches, normalizeRegionSitePattern as normalize } from "../src/shared/region-site-pattern";

describe("translation region website patterns", () => {
  it.each(["", "   ", "*", " * "])("uses %j for all HTTP and HTTPS websites", pattern => {
    expect(normalize(pattern)).toBe("*");
    for (const url of ["https://example.com/", "http://localhost:8080/docs", "https://other.org/a?q=b#c"]) expect(matches(pattern, url)).toBe(true);
    for (const url of ["file:///document.html", "about:blank", "chrome-extension://id/options.html", "ftp://example.com/", "invalid"]) expect(matches(pattern, url)).toBe(false);
  });

  it.each(["example.com", "*.example.com", "https://EXAMPLE.com/docs/**", "example.com:443/a*", "http://localhost:8080", "[::1]:8080"])("preserves legacy semantics for %s", pattern => {
    expect(normalize(pattern)).toBe(normalizeSitePattern(pattern));
    for (const url of ["https://example.com/", "http://example.com:443/abc", "https://www.example.com/docs/read?q=1", "https://notexample.com/docs/read", "http://localhost:8080/", "http://[::1]:8080/"]) {
      expect(matches(pattern, url), url).toBe(matchesSitePattern(pattern, url));
    }
  });

  it.each([
    ["example.*", "https://example.org/", true],
    ["example.*", "https://notexample.org/", false],
    ["news.*.org", "https://news.example.org/", true],
    ["news.*.org", "https://news.example.com/", false],
    ["*://*.example.com/docs/*", "http://news.example.com/docs/guide?a=1#top", true],
    ["*://*.example.com/docs/*", "https://news.example.com/docs/guide", true],
    ["*://*.example.com/docs/*", "https://example.com/docs/guide", false],
    ["*://*.example.com/docs/*", "https://news.example.com/other?path=/docs/guide", false],
    ["*://example.com/docs/*", "http://sub.example.com:8080/docs/guide", true],
    ["*/docs/*", "https://anywhere.net/docs/a/b", true],
    ["https://*/docs/*", "http://anywhere.net/docs/a", false],
    ["https://*/docs/*", "https://anywhere.net:8443/docs/a", false],
    ["https://*:443/docs/*", "https://anywhere.net/docs/a", true],
    ["*://*:8080/*", "http://localhost:8080/a", true],
    ["*://*:8080/*", "https://localhost/a", false],
    ["*://[::1]:8080/*", "http://[::1]:8080/a", true],
    ["*://例子.测试/*", "https://例子.测试/a", true],
    ["https://*.example.*.org/a+b/*", "https://www.example.test.org/a+b/read", true],
    ["https://*.example.*.org/a+b/*", "https://www.example.test.org/aaab/read", false]
  ])("matches %s against %s: %s", (pattern, url, expected) => {
    expect(matches(pattern, url)).toBe(expected);
    expect(matches(normalize(pattern), url)).toBe(expected);
    expect(normalize(normalize(pattern))).toBe(normalize(pattern));
  });

  it("normalizes extended globs without discarding explicit default ports", () => {
    expect(normalize(" *://NEWS.**.ORG./docs/** ")).toBe("*://news.*.org/docs/*");
    expect(normalize("https://*:00443/docs/*")).toBe("https://*:443/docs/*");
  });

  it("handles browser URL implementations that percent-encode hostname stars", () => {
    const NativeURL = URL;
    class BrowserURL extends NativeURL {
      override get hostname() { return super.hostname.replaceAll("*", "%2A"); }
    }
    vi.stubGlobal("URL", BrowserURL);
    try {
      for (const pattern of ["*.browser-example.org", "browser-example.*", "*://*.browser-example.org/docs/*"]) {
        expect(normalize(pattern)).toBe(pattern);
        expect(matches(pattern, "https://www.browser-example.org/docs/guide")).toBe(pattern !== "browser-example.*");
      }
      expect(matches("browser-example.*", "https://browser-example.com/")).toBe(true);
      expect(normalize("*://wupage-wildcard.org/*")).toBe("*://wupage-wildcard.org/*");
      expect(matches("wupage-wildcard.*", "https://wupage-wildcard.org/")).toBe(true);
      expect(normalize("*.%77upage-wildcard.org")).toBe("*.wupage-wildcard.org");
      expect(matches("*.%77upage-wildcard.org", "https://sub.wupage-wildcard.org/")).toBe(true);
      expect(matches("*.%77upage-wildcard.org", "https://sub.other.org/")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("supports simple regexes, optional case insensitivity, and full URL query/fragment matching", () => {
    const pattern = String.raw`/^https?:\/\/(www\.)?example\.(com|org)\/docs\/[a-z0-9-]+(?:\?.*)?$/i`;
    expect(normalize(` ${pattern} `)).toBe(pattern);
    expect(matches(pattern, "https://www.example.org/docs/Guide-12?q=1")).toBe(true);
    expect(matches(pattern, "http://example.com/docs/a")).toBe(true);
    expect(matches(pattern, "https://other.example.com/docs/a")).toBe(false);
    expect(matches(pattern, "https://example.net/docs/a")).toBe(false);
    expect(matches(pattern, "https://example.com/docs/a#fragment")).toBe(false);
    expect(matches("/\\?mode=read#top$/", "https://example.com/?mode=read#top")).toBe(true);
    expect(matches("/Docs/", "https://example.com/docs/a")).toBe(false);
    expect(matches("/Docs/i", "https://example.com/docs/a")).toBe(true);
    expect(matches("/.*/", "file:///docs/a")).toBe(false);
    // Cached expressions must never keep a lastIndex between documents.
    for (let i = 0; i < 3; i++) expect(matches("/Docs/i", "https://example.com/docs/a")).toBe(true);
  });

  it.each(["https://", "ftp://*/*", "https://user:password@*/*", "https://*/?q=1", "https://*/#top", "example..*", "example.*!", "*://https://example.com", "**.localhost", "**.127.0.0.1", "*".repeat(2049), "/", "//", "/unclosed", "/[/", "/abc/g", "/abc/ii", "/(?=abc)/", "/(?<=abc)/", String.raw`/(abc)\1/`, "/a{1001}/"])("rejects malformed or unsupported rule %s", pattern => {
    expect(() => normalize(pattern)).toThrow();
    expect(matches(pattern, "https://example.com/")).toBe(false);
  });

  it("handles backtracking-heavy expressions and cache eviction without changing matches", () => {
    expect(matches("/(a+)+$/", `https://example.com/${"a".repeat(20000)}!`)).toBe(false);
    for (let i = 0; i < 270; i++) expect(matches(`/docs-${i}$/`, `https://example.com/docs-${i}`)).toBe(true);
    expect(matches("/(a+)+$/", "https://example.com/aaa")).toBe(true);
  });
});
