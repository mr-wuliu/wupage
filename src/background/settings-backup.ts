import { parseSettingsBackup, type SettingsImportResult } from "../shared/settings-backup";
import { saveSettings } from "../shared/settings";
import { installedRevision } from "../ocr/model-store";

export async function importSettingsBackup(text: string): Promise<SettingsImportResult> {
  const backup = parseSettingsBackup(text);
  let imageTranslationDisabled = false;
  const settings = await saveSettings(async () => {
    const next = backup.settings;
    if (next.imageTranslationEnabled && !await installedRevision()) {
      next.imageTranslationEnabled = false;
      imageTranslationDisabled = true;
    }
    return next;
  });
  return { settings, imageTranslationDisabled };
}
