import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import {
  createSettingsBackup,
  parseSettingsBackup,
  SETTINGS_BACKUP_MAX_BYTES,
  settingsBackupFileName,
  SettingsBackupError
} from "../src/shared/settings-backup";

describe("settings backup", () => {
  it("round-trips the current settings through the exported file", () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, activeProviderId: "deepseek", chunkSize: 900 });
    const file = createSettingsBackup(settings, new Date("2026-02-03T04:05:06Z"));
    expect(file).toMatchObject({ app: "wupage", kind: "settings", version: 1 });
    expect(file.exportedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(parseSettingsBackup(JSON.stringify(file))).toEqual(settings);
  });

  it("keeps the export detached from later edits", () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS);
    const original = settings.chunkSize;
    const file = createSettingsBackup(settings);
    file.settings.chunkSize = original + 100;
    expect(settings.chunkSize).toBe(original);
  });

  it("accepts a bare settings object and normalizes it", () => {
    const imported = parseSettingsBackup(JSON.stringify({ targetLang: "ja", chunkSize: 20 }));
    expect(imported.targetLang).toBe("ja");
    expect(imported.chunkSize).toBe(200);
    expect(imported.providers).toHaveLength(DEFAULT_SETTINGS.providers.length);
    expect(imported.providers.some(provider => provider.enabled !== false)).toBe(true);
  });

  it("rejects malformed and foreign files", () => {
    expect(() => parseSettingsBackup("{")).toThrow(SettingsBackupError);
    expect(() => parseSettingsBackup("{}")).toThrow("没有可识别的 WuPage 设置");
    expect(() => parseSettingsBackup("[]")).toThrow("不是设置对象");
    expect(() => parseSettingsBackup(JSON.stringify({ hello: "world" }))).toThrow("没有可识别的 WuPage 设置");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "other", settings: { targetLang: "ja" } })))
      .toThrow("不是 WuPage 的设置备份");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", version: 2, settings: { targetLang: "ja" } })))
      .toThrow("更新版本");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", settings: "nope" })))
      .toThrow("没有可识别的设置");
  });

  it("rejects a file that carries another backup kind", () => {
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", kind: "history", settings: { targetLang: "ja" } })))
      .toThrow("这不是设置备份");
  });

  it("rejects a version that is not a number", () => {
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", version: "2", settings: { targetLang: "ja" } })))
      .toThrow("版本无法识别");
  });

  it("rejects a file too large to be settings", () => {
    expect(() => parseSettingsBackup("x".repeat(SETTINGS_BACKUP_MAX_BYTES + 1))).toThrow("文件过大");
  });

  it("names files with a sortable local timestamp", () => {
    expect(settingsBackupFileName(new Date(2026, 1, 3, 4, 5))).toBe("wupage-settings-20260203-0405.json");
  });
});
