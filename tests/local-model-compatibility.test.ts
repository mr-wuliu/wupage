import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../src/local/catalog.json";

let update: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  update = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://wupage/", getManifest: () => ({ version: "1.10.0" }) },
    declarativeNetRequest: { updateSessionRules: update }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Mozilla model download compatibility", () => {
  it("limits the client header to this extension's model GETs and preserves unrelated rules", async () => {
    const { ensureLocalModelDownloadCompatibility } = await import("../src/background/local-model-compatibility");
    await Promise.all([ensureLocalModelDownloadCompatibility(), ensureLocalModelDownloadCompatibility()]);
    expect(update).toHaveBeenCalledOnce();
    const change = update.mock.calls[0][0] as Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0];
    const rule = change.addRules![0];
    expect(change.removeRuleIds).toEqual([rule.id]);
    expect(rule.condition).toMatchObject({
      initiatorDomains: ["wupage"], requestMethods: ["get"], resourceTypes: ["xmlhttprequest", "main_frame", "other"]
    });
    expect(rule.action.requestHeaders).toEqual([{ header: "user-agent", operation: "set", value: "WuPage/1.10.0 (Bergamot model download)" }]);
    const matches = new RegExp(rule.condition.regexFilter!);
    for (const file of catalog.flatMap(model => model.files)) expect(matches.test(file.url), file.url).toBe(true);
    const url = catalog[0].files[0].url;
    for (const other of [url.replace("https:", "http:"), url + "/extra", url + "?other=1",
      url.replace("cdn.mozilla.net", "example.com"), url.replace("translations-models/", "other/")]) {
      expect(matches.test(other), other).toBe(false);
    }
  });

  it("retries rule preparation after failure", async () => {
    update.mockRejectedValueOnce(new Error("Rules unavailable"));
    const { ensureLocalModelDownloadCompatibility } = await import("../src/background/local-model-compatibility");
    await expect(ensureLocalModelDownloadCompatibility()).rejects.toThrow("Rules unavailable");
    await expect(ensureLocalModelDownloadCompatibility()).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps Firefox's native client identification", async () => {
    vi.stubEnv("MODE", "firefox");
    const { ensureLocalModelDownloadCompatibility } = await import("../src/background/local-model-compatibility");
    await ensureLocalModelDownloadCompatibility();
    expect(update).not.toHaveBeenCalled();
  });
});
