import { t } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup, settingsBackupFilename, SETTINGS_BACKUP_MAX_BYTES, SETTINGS_BACKUP_MIME,
  type SettingsBackup, type SettingsImportResult } from "../shared/settings-backup";
import type { ExtensionSettings } from "../shared/types";

export function setupSettingsBackupControls(options: {
  imported: (settings: ExtensionSettings) => void;
  status: (message: string) => void;
}): void {
  const query = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const exportButton = query<HTMLButtonElement>("exportSettings");
  const importButton = query<HTMLButtonElement>("importSettings");
  const fileInput = query<HTMLInputElement>("settingsBackupFile");
  const dialog = query<HTMLDialogElement>("settingsBackupDialog");
  const confirm = query<HTMLButtonElement>("confirmSettingsBackup");
  const cancel = query<HTMLButtonElement>("cancelSettingsBackup");
  const dialogStatus = query("settingsBackupDialogStatus");
  const includeKeys = query<HTMLInputElement>("settingsBackupIncludeKeys");
  const keysField = query("settingsBackupKeysField");
  let pending: { mode: "export" | "import"; backup: SettingsBackup; text: string; source?: ExtensionSettings } | undefined;
  let busy = false;
  let closed = false;
  const urls = new Map<string, ReturnType<typeof setTimeout>>();

  const setBusy = (value: boolean): void => {
    busy = value;
    exportButton.disabled = importButton.disabled = confirm.disabled = cancel.disabled = value;
    includeKeys.disabled = value;
    dialog.setAttribute("aria-busy", String(value));
  };
  function preview(mode: "export" | "import", backup: SettingsBackup, text: string, source?: ExtensionSettings): void {
    if (closed) return;
    pending = { mode, backup, text, source };
    includeKeys.checked = false;
    keysField.hidden = mode !== "export";
    query("settingsBackupDialogTitle").textContent = mode === "export" ? t("exportSettingsBackup") : t("importAndReplaceSettings");
    query("settingsBackupSummary").textContent = t("servicesWupage", backup.settings.providers.length, backup.extensionVersion, new Date(backup.createdAt).toLocaleString(t("interfaceLanguage")));
    query("settingsBackupWarning").textContent = mode === "export" ? exportWarning(false)
      : t("importingImmediatelyReplacesAllSettingsAndDiscardsUnsaved", backup.includesKeys ? t("thisBackupIncludesCredentialsAndWillOverwriteThe") : t("thisBackupOmitsCredentialsImportingClearsExistingCredentials"));
    confirm.textContent = mode === "export" ? t("confirmExport") : t("confirmReplacement");
    dialogStatus.textContent = "";
    setBusy(false);
    dialog.showModal();
    cancel.focus();
  }

  exportButton.addEventListener("click", () => {
    if (busy || pending) return;
    setBusy(true);
    void (async () => {
      try {
        // Always read storage, never the form or its potentially stale baseline.
        const saved = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
        const backup = createSettingsBackup(saved, chrome.runtime.getManifest().version);
        preview("export", backup, serializeSettingsBackup(backup), saved);
      } catch (error) { options.status(message(error)); }
      finally { setBusy(false); }
    })();
  });
  includeKeys.addEventListener("change", () => {
    if (pending?.mode === "export") {
      query("settingsBackupWarning").textContent = exportWarning(includeKeys.checked);
      dialogStatus.textContent = "";
    }
  });
  importButton.addEventListener("click", () => { if (!busy && !pending) fileInput.click(); });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // The same file can be retried after cancellation/failure.
    if (!file || busy || pending) return;
    setBusy(true);
    void (async () => {
      try {
        if (file.size > SETTINGS_BACKUP_MAX_BYTES) throw new Error(t("settingsBackupsMustBe5MibOrSmaller"));
        const text = await file.text();
        preview("import", parseSettingsBackup(text), text);
      } catch (error) { options.status(message(error)); }
      finally { setBusy(false); }
    })();
  });
  const close = (): void => { pending = undefined; dialog.close(); };
  cancel.addEventListener("click", () => { if (!busy) close(); });
  dialog.addEventListener("cancel", event => {
    if (busy) event.preventDefault();
    else pending = undefined;
  });
  dialog.addEventListener("close", () => {
    // Chromium queues this event. A new preview may already have opened.
    if (!dialog.open) { pending = undefined; dialogStatus.textContent = ""; }
  });
  confirm.addEventListener("click", () => {
    if (!pending || busy) return;
    const operation = pending;
    setBusy(true);
    dialogStatus.textContent = operation.mode === "import" ? t("saving") : t("creatingBackup");
    void (async () => {
      try {
        if (operation.mode === "export") {
          const backup = createSettingsBackup(operation.source!, operation.backup.extensionVersion,
            new Date(operation.backup.createdAt), { includeKeys: includeKeys.checked });
          const text = serializeSettingsBackup(backup);
          const url = URL.createObjectURL(new Blob([text], { type: `${SETTINGS_BACKUP_MIME};charset=utf-8` }));
          // Keep the object URL alive long enough for Firefox to start the download.
          urls.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000));
          const link = document.createElement("a");
          link.href = url; link.download = settingsBackupFilename(backup);
          document.body.append(link);
          try { link.click(); } finally { link.remove(); }
          options.status(backup.includesKeys ? t("fullBackupWithCredentialsCreatedFindItIn")
            : t("settingsBackupCreatedWithoutCredentialsFindItIn"));
        } else {
          const result = await sendRuntimeMessage<SettingsImportResult>({ type: "IMPORT_SETTINGS", backup: operation.text });
          if (closed) return;
          options.imported(result.settings);
          options.status(t("settingsImportedAndSaved")
            + (operation.backup.includesKeys ? "" : t("settingsRestoredThisBackupOmittedCredentialsSoPrevious"))
            + (result.imageTranslationDisabled ? t("ocrModelsAreMissingOnThisDeviceInstall") : ""));
        }
        close();
      } catch (error) {
        // Keep both the old form and the preview so a failed write is retryable.
        dialogStatus.textContent = message(error);
      } finally { setBusy(false); }
    })();
  });
  window.addEventListener("pagehide", () => {
    closed = true; pending = undefined;
    for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    urls.clear();
  }, { once: true });
}

function message(error: unknown): string { return error instanceof Error ? error.message : t("settingsBackupOperationFailedTryAgain"); }
function exportWarning(includeKeys: boolean): string {
  return includeKeys
    ? t("thisUnencryptedTomlBackupIncludesSavedSettingsCredentials")
    : t("thisBackupKeepsSavedServiceAddressesHeadersTemplates");
}
