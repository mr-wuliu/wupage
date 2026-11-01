import { afterEach, expect, it, vi } from "vitest";
import { addAutoTranslationWebsite } from "../src/shared/auto-translation";
import { VideoRequests } from "../src/content/video-requests";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

afterEach(() => vi.unstubAllGlobals());

it("creates site rules and video sessions when HTTP pages do not expose crypto.randomUUID", () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const settings = { enabled: true, nonTargetLanguage: false, presetSites: [], customSites: [] };
  expect(addAutoTranslationWebsite(settings, "http://intranet.example/article").customSites[0].pattern).toBe("intranet.example");
  const first = new VideoRequests(DEFAULT_SETTINGS, "en");
  const second = new VideoRequests(DEFAULT_SETTINGS, "en");
  expect(first.id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u);
  expect(first.id).not.toBe(second.id);
});
