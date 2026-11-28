import { parseSettingsBackup, parseSettingsSyncBackup, type SettingsImportResult } from "../shared/settings-backup";
import { saveSettings } from "../shared/settings";
import { ocrRevision } from "./ocr-service";

export async function importSettingsBackup(text: string): Promise<SettingsImportResult> {
  const backup = parseSettingsBackup(text);
  let imageTranslationDisabled = false;
  const settings = await saveSettings(async () => {
    const next = backup.settings;
    if (next.imageTranslationEnabled && !await ocrRevision(next)) {
      next.imageTranslationEnabled = false;
      imageTranslationDisabled = true;
    }
    return next;
  });
  return { settings, imageTranslationDisabled };
}

export function restoreSyncedSettings(text: string) {
  const backup = parseSettingsSyncBackup(text);
  return saveSettings(latest => ({ ...latest, ...backup.settings }));
}
