import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { restoreSyncedSettings } from "../src/background/settings-backup";
import { publishBrowserSettings, readBrowserSettings, webDavSettings } from "../src/options/settings-sync";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { createSettingsBackup, createSettingsSyncBackup, parseSettingsBackup, parseSettingsSyncBackup,
  serializeSettingsBackup, serializeSettingsSyncBackup, SETTINGS_BACKUP_MAX_BYTES } from "../src/shared/settings-backup";
import { normalizeSettings } from "../src/shared/settings";

afterEach(() => vi.unstubAllGlobals());

it("round-trips portable preferences and restores them over the latest local settings without changing service configuration", async () => {
  const current = normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), targetLang: "ja", statisticsEnabled: true });
  const provider = current.providers.find(entry => entry.type === "deepseek")!;
  provider.apiKey = "device-secret";
  provider.baseURL = "https://example.com/device-provider";
  const source = normalizeSettings({
    ...current, targetLang: "de", pdfTranslationPageRadius: null, statisticsEnabled: false,
    glossaryGroups: [{ id: "work", name: "Work", enabled: true,
      entries: [{ id: "example", site: "example.com", source: "cloud", target: "云" }] }]
  });
  const text = serializeSettingsSyncBackup(createSettingsSyncBackup(source, "1.24.1"));
  expect(text).not.toMatch(/device-secret|device-provider|statisticsEnabled|activeProviderId|inputTranslation|\bproviders\b|\bocr\b/u);
  expect(parseSettingsSyncBackup(text).settings).toMatchObject({
    targetLang: "de", pdfTranslationPageRadius: null, glossaryGroups: source.glossaryGroups
  });
  expect(() => parseSettingsBackup(text)).toThrow();
  const full = serializeSettingsBackup(createSettingsBackup(current, "1.24.1", undefined, { includeKeys: true }));
  expect(() => parseSettingsSyncBackup(full)).toThrow();
  const addField = (field: string) => text.replace("[settings]", `[settings]\n${field}`);
  expect(() => parseSettingsSyncBackup(addField('activeProviderId = "deepseek"'))).toThrow();
  expect(() => parseSettingsSyncBackup(text.replace(/^targetLang = .*$/mu, ""))).toThrow();

  const latest = { ...current, providers: current.providers.map(entry => entry.type === "deepseek"
    ? { ...entry, apiKey: "new-device-secret" } : entry) };
  const set = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ [SETTINGS_KEY]: latest }), set } } });
  const restored = await restoreSyncedSettings(text);
  expect(restored).toMatchObject({ targetLang: "de", statisticsEnabled: true, providers: latest.providers });
  expect(set).toHaveBeenCalledWith({ [SETTINGS_KEY]: restored });
});

it("writes browser chunks within quota and refuses mixed revisions and oversized writes", async () => {
  let values: Record<string, unknown> = {};
  const set = vi.fn(async (next: Record<string, unknown>) => { values = structuredClone(next); });
  vi.stubGlobal("chrome", { storage: { sync: { get: async () => values, set } } });

  const text = randomBytes(16000).toString("hex") + "术语";
  await expect(readBrowserSettings()).rejects.toThrow();
  await publishBrowserSettings(text);
  expect(set).toHaveBeenCalledTimes(1);
  const keys = Object.keys(values);
  const parts = keys.filter(key => typeof values[key] === "string");
  expect(parts.length).toBeGreaterThan(1);
  for (const key of keys) expect(Buffer.byteLength(key + JSON.stringify(values[key]))).toBeLessThan(8192);
  expect(await readBrowserSettings()).toBe(text);
  const firstPart = values[parts[0]];
  values[parts[0]] = String(firstPart).replace(/^./u, String(firstPart).startsWith("A") ? "Z" : "A");
  await expect(readBrowserSettings()).rejects.toThrow();

  await publishBrowserSettings("shorter");
  expect(values[parts[1]]).toBeNull();
  expect(await readBrowserSettings()).toBe("shorter");
  await expect(publishBrowserSettings(randomBytes(120000).toString("hex"))).rejects.toThrow();
  expect(set).toHaveBeenCalledTimes(2);
  expect(await readBrowserSettings()).toBe("shorter");
});

it("uses conditional WebDAV writes and keeps credentials scoped to the selected URL", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(new Response("old", { headers: { ETag: '"old"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 412 }))
    .mockResolvedValueOnce(new Response("新配置"));
  vi.stubGlobal("fetch", fetch);
  const dav = webDavSettings("https://example.com/dav/Settings%20Folder", "user", "app-password");
  const missing = await dav.revision();
  expect(missing).toBeNull();
  await dav.write("new", missing);
  const previous = await dav.revision();
  expect(previous).toBe('"old"');
  await expect(dav.write("must not overwrite", previous)).rejects.toThrow();
  expect(await dav.read()).toBe("新配置");
  expect(fetch.mock.calls.map(([, request]) => request.method)).toEqual(["HEAD", "PUT", "HEAD", "GET", "PUT", "GET"]);
  expect(fetch.mock.calls[1][1].headers).toMatchObject({ "If-None-Match": "*" });
  expect(fetch.mock.calls[4][1].headers).toMatchObject({ "If-Match": '"old"' });
  for (const [url, request] of fetch.mock.calls) {
    expect(url.href).toBe("https://example.com/dav/Settings%20Folder/wupage-preferences.toml");
    expect(request).toMatchObject({ credentials: "omit", redirect: "error",
      headers: { Authorization: `Basic ${btoa("user:app-password")}` } });
  }
  for (const url of ["http://example.com/dav/", "https://name:pass@example.com/dav/", "https://example.com/dav/?token=foo"]) {
    expect(() => webDavSettings(url, "", "")).toThrow();
  }
});

it("rejects WebDAV backups without a strong revision and caps streamed reads", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { headers: { ETag: 'W/"old"' } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(SETTINGS_BACKUP_MAX_BYTES + 1)));
  vi.stubGlobal("fetch", fetch);
  const dav = webDavSettings("http://127.0.0.1:9876/", "", "");
  await expect(dav.revision()).rejects.toThrow();
  await expect(dav.read()).rejects.toThrow("5 MiB");
});
