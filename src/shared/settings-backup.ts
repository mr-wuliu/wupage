import { normalizeSettings } from "./settings";
import type { ExtensionSettings } from "./types";

/** Marker written into exported files so a wrong JSON file is rejected clearly. */
const BACKUP_APP = "wupage";
const BACKUP_KIND = "settings";
/** Bumped only when the file layout changes; the settings body keeps its own migration path. */
export const SETTINGS_BACKUP_VERSION = 1;
/** A real settings file is a few kilobytes; a larger one is a wrong file, and reading it would stall the options page. */
export const SETTINGS_BACKUP_MAX_BYTES = 2 * 1024 * 1024;

export interface SettingsBackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  settings: ExtensionSettings;
}

export class SettingsBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsBackupError";
  }
}

/** Fields that identify a JSON object as extension settings rather than an unrelated document. */
const SETTINGS_MARKERS = [
  "providers",
  "activeProviderId",
  "targetLang",
  "sourceLang",
  "appearance",
  "shortcuts",
  "translationDisplayMode",
  "chunkSize",
  "concurrency"
] as const;

export function createSettingsBackup(
  settings: ExtensionSettings,
  exportedAt: Date = new Date()
): SettingsBackupFile {
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings: structuredClone(settings)
  };
}

/** Local-time stamp so consecutive exports on the same day stay distinguishable. */
export function settingsBackupFileName(exportedAt: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}`;
  const time = `${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}`;
  return `wupage-settings-${date}-${time}.json`;
}

/**
 * Accepts both an exported backup file and a bare settings object, so a hand-edited
 * or partial file still imports. Every legacy value is migrated by normalizeSettings,
 * which is the same path used when reading storage, so validation is not duplicated
 * here; keys that survive it are written back verbatim, which is not a filter for
 * unknown fields.
 */
export function parseSettingsBackup(text: string): ExtensionSettings {
  if (text.length > SETTINGS_BACKUP_MAX_BYTES) {
    throw new SettingsBackupError("导入失败：文件过大，这不是设置备份文件。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsBackupError("导入失败：文件不是有效的 JSON。");
  }
  const file = asRecord(parsed);
  if (!file) throw new SettingsBackupError("导入失败：文件内容不是设置对象。");
  if (file.app !== undefined && file.app !== BACKUP_APP) {
    throw new SettingsBackupError("导入失败：这不是 WuPage 的设置备份。");
  }
  if (file.kind !== undefined && file.kind !== BACKUP_KIND) {
    throw new SettingsBackupError("导入失败：这不是设置备份。");
  }
  if (file.version !== undefined && typeof file.version !== "number") {
    throw new SettingsBackupError("导入失败：备份文件的版本无法识别。");
  }
  if (typeof file.version === "number" && file.version > SETTINGS_BACKUP_VERSION) {
    throw new SettingsBackupError(`导入失败：备份来自更新版本的 WuPage（版本 ${file.version}），请先更新扩展。`);
  }
  const candidate = file.settings === undefined ? file : asRecord(file.settings);
  if (!candidate) throw new SettingsBackupError("导入失败：文件里没有可识别的设置。");
  if (!SETTINGS_MARKERS.some((key) => key in candidate)) {
    throw new SettingsBackupError("导入失败：文件里没有可识别的 WuPage 设置。");
  }
  return normalizeSettings(candidate);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
