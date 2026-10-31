import { normalizeSettings } from "./settings";
import { supportsServiceMode } from "./translation-service";
import type { ExtensionSettings, ProviderConfig, TranslationApiOptions } from "./types";

/** Marker written into exported files so a wrong JSON file is rejected clearly. */
const BACKUP_APP = "wupage";
const BACKUP_KIND = "settings";
/** Bumped only when the file layout changes; the settings body keeps its own migration path. */
export const SETTINGS_BACKUP_VERSION = 1;
/** A real settings file is a few kilobytes; a larger one is a wrong file, and reading it would stall the options page. */
export const SETTINGS_BACKUP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Key field names. Their values are blanked on export but the fields themselves stay,
 * because normalizeSettings drops a provider whose required string fields are missing.
 */
const PROVIDER_KEY_FIELDS = ["apiKey"] as const;
const SERVICE_KEY_FIELDS = ["apiKey", "accessKeyId", "secretAccessKey"] as const;

export interface SettingsBackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  /** Whether this file is allowed to carry keys; false means the keys were stripped. */
  includesKeys: boolean;
  settings: ExtensionSettings;
}

/**
 * A parsed file plus the intent recorded in it. Bare settings objects and files written
 * before the option existed report `includesKeys: true`, matching the old export behaviour.
 */
export interface ParsedSettingsBackup {
  settings: ExtensionSettings;
  includesKeys: boolean;
}

/** Blanks every key in place on a copy, so the provider still passes normalizeSettings. */
function withoutProviderKeys(provider: ProviderConfig): ProviderConfig {
  const copy = structuredClone(provider) as ProviderConfig;
  // ProviderConfig is a union, so a keyed write needs the record view the field lists describe.
  const record = copy as unknown as Record<string, unknown>;
  for (const field of PROVIDER_KEY_FIELDS) {
    if (typeof record[field] === "string") record[field] = "";
  }
  if (supportsServiceMode(copy) && copy.api) {
    const api: TranslationApiOptions = { ...copy.api };
    for (const field of SERVICE_KEY_FIELDS) {
      if (typeof api[field] === "string") api[field] = "";
    }
    copy.api = api;
  }
  return copy;
}

/** Whether this provider currently holds a key the user may not want written to a file. */
export function providerHasStoredKey(provider: ProviderConfig): boolean {
  if (PROVIDER_KEY_FIELDS.some((field) => {
    const value = (provider as unknown as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() !== "";
  })) return true;
  return supportsServiceMode(provider) && Boolean(provider.api)
    && SERVICE_KEY_FIELDS.some((field) => {
      const value = provider.api?.[field];
      return typeof value === "string" && value.trim() !== "";
    });
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

/**
 * Keys are stripped unless the caller explicitly opts in, so a file that leaves the browser
 * cannot leak a translation key by default. Blanking keeps each provider's shape, which is
 * what lets a key-less file still restore every other field.
 */
export function createSettingsBackup(
  settings: ExtensionSettings,
  exportedAt: Date = new Date(),
  options: { includesKeys?: boolean } = {}
): SettingsBackupFile {
  const includesKeys = options.includesKeys === true;
  const body = structuredClone(settings);
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    includesKeys,
    settings: includesKeys
      ? body
      : { ...body, providers: body.providers.map(withoutProviderKeys) }
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
export function parseSettingsBackup(text: string): ParsedSettingsBackup {
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
  return {
    settings: normalizeSettings(candidate),
    // A bare settings object carries no intent marker; treat it as a full file so a
    // hand-written key still imports, which is what the old format meant.
    includesKeys: file.includesKeys !== false
  };
}

/**
 * Fills keys the incoming file left blank with the ones already stored here. A key that is
 * absent from the file is missing data, not a request to clear this browser's copy; without
 * this an export that strips keys would wipe them on import and the services would stop
 * working. Non-empty incoming keys always win, so editing a file still takes effect.
 */
export function mergeStoredKeys(
  incoming: ExtensionSettings,
  current: ExtensionSettings
): { settings: ExtensionSettings; restoredKeys: number } {
  let restoredKeys = 0;
  const providers = incoming.providers.map((provider) => {
    const existing = current.providers.find(
      (candidate) => candidate.id === provider.id && candidate.type === provider.type
    );
    if (!existing) return provider;
    const merged = structuredClone(provider) as ProviderConfig;
    // Same union caveat as in withoutProviderKeys: index through the record view.
    const mergedRecord = merged as unknown as Record<string, unknown>;
    const existingRecord = existing as unknown as Record<string, unknown>;
    let changed = false;
    for (const field of PROVIDER_KEY_FIELDS) {
      const stored = existingRecord[field];
      if (mergedRecord[field] === "" && typeof stored === "string" && stored !== "") {
        mergedRecord[field] = stored;
        changed = true;
      }
    }
    if (supportsServiceMode(merged) && supportsServiceMode(existing)) {
      const api: TranslationApiOptions = { ...(merged.api ?? {}) };
      for (const field of SERVICE_KEY_FIELDS) {
        const stored = existing.api?.[field];
        if ((api[field] ?? "") === "" && typeof stored === "string" && stored !== "") {
          api[field] = stored;
          changed = true;
        }
      }
      if (Object.keys(api).length) merged.api = api;
    }
    if (changed) restoredKeys += 1;
    return merged;
  });
  return { settings: { ...incoming, providers }, restoredKeys };
}

/** Whether the file actually carried any key, which decides how the import is reported. */
export function settingsBackupHasKeys(settings: ExtensionSettings): boolean {
  return settings.providers.some(providerHasStoredKey);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
