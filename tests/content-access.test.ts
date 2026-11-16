import { afterEach, expect, it, vi } from "vitest";
import { isRestrictedContentUrl } from "../src/shared/content-access";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["Chrome/130 Edg/130", "https://microsoftedge.microsoft.com/addons/", true],
  ["Chrome/130 Edg/130", "https://chromewebstore.google.com/detail/test", true],
  ["Chrome/130", "https://chrome.google.com/webstore/detail/test", true],
  ["Chrome/130", "https://chromewebstore.google.com/", true],
  ["Chrome/130", "https://chrome.google.com/other", false],
  ["Chrome/130", "https://microsoftedge.microsoft.com/addons/", false],
  ["Firefox/154", "https://addons.mozilla.org/en-US/firefox/", true],
  ["Firefox/154", "https://accounts.firefox.com/", true],
  ["Firefox/154", "https://addons.cdn.mozilla.net/test", true],
  ["Firefox/154", "https://microsoftedge.microsoft.com/addons/", false],
  ["Firefox/154", "https://chromewebstore.google.com/", false],
  ["Chrome/130 Edg/130", "https://addons.mozilla.org/", false],
  ["Chrome/130 Edg/130", "https://microsoftedge.microsoft.com.example.com/addons/", false],
  ["Firefox/154", "https://example.com/?page=addons.mozilla.org", false],
  ["Chrome/130 Edg/130", "edge://extensions/", true],
  ["Chrome/130", "chrome://settings/", true],
  ["Firefox/154", "about:addons", true],
  ["Chrome/130", "chrome-extension://another/page.html", true]
])("identifies restrictions for %s at %s: %s", (userAgent, address, blocked) => {
  vi.stubGlobal("navigator", { userAgent });
  expect(isRestrictedContentUrl(address)).toBe(blocked);
});

it("keeps inherited-origin frames eligible and treats missing tab metadata as unknown", () => {
  for (const address of ["about:blank", "about:srcdoc", "blob:https://example.com/id", "data:text/html,test"]) {
    expect(isRestrictedContentUrl(address, true)).toBe(false);
    expect(isRestrictedContentUrl(address)).toBe(true);
  }
  expect(isRestrictedContentUrl(undefined)).toBe(false);
  expect(isRestrictedContentUrl("not a url")).toBe(true);
});
