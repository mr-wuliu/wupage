import { t, type MessageKey } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup, settingsBackupFilename, SETTINGS_BACKUP_MAX_BYTES, SETTINGS_BACKUP_MIME,
  createSettingsSyncBackup, parseSettingsSyncBackup, serializeSettingsSyncBackup, type SettingsBackup, type SettingsImportResult } from "../shared/settings-backup";
import type { ExtensionSettings } from "../shared/types";
import { publishBrowserSettings, readBrowserSettings, webDavSettings } from "./settings-sync";

type BackupOperation =
  | { mode: "export"; backup: SettingsBackup; source: ExtensionSettings }
  | { mode: "import"; backup: SettingsBackup; text: string }
  | { mode: "upload"; target: SyncTarget; write: () => Promise<void> }
  | { mode: "restore"; target: SyncTarget; text: string };
type SyncTarget = "browser" | "dav";

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
  const publishBrowser = query<HTMLButtonElement>("publishBrowserSettings");
  const restoreBrowser = query<HTMLButtonElement>("restoreBrowserSettings");
  const publishDav = query<HTMLButtonElement>("publishDavSettings");
  const restoreDav = query<HTMLButtonElement>("restoreDavSettings");
  const davFolder = query<HTMLInputElement>("settingsSyncDavFolder");
  const davUser = query<HTMLInputElement>("settingsSyncDavUser");
  const davPassword = query<HTMLInputElement>("settingsSyncDavPassword");
  const syncStatus = { browser: query("browserSettingsSyncStatus"), dav: query("webDavSettingsSyncStatus") };
  const controls = [exportButton, importButton, confirm, cancel, includeKeys, publishBrowser, restoreBrowser,
    publishDav, restoreDav, davFolder, davUser, davPassword];
  const dav = () => webDavSettings(davFolder.value, davUser.value, davPassword.value);
  let pending: BackupOperation | undefined;
  let busy = false;
  let closed = false;
  const urls = new Map<string, ReturnType<typeof setTimeout>>();

  const setBusy = (value: boolean): void => {
    busy = value;
    for (const control of controls) control.disabled = value;
    dialog.setAttribute("aria-busy", String(value));
  };
  function preview(operation: BackupOperation, copy: {
    title: MessageKey; summary: string; warning: string; confirm: MessageKey; destination?: string;
  }): void {
    if (closed) return;
    pending = operation;
    includeKeys.checked = false;
    keysField.hidden = operation.mode !== "export";
    query("settingsBackupDialogTitle").textContent = t(copy.title);
    query("settingsBackupSummary").textContent = copy.summary;
    const destination = query("settingsBackupDestination");
    destination.textContent = copy.destination ?? "";
    destination.hidden = !copy.destination;
    query("settingsBackupWarning").textContent = copy.warning;
    confirm.textContent = t(copy.confirm);
    dialogStatus.textContent = "";
    setBusy(false);
    dialog.showModal();
    cancel.focus();
  }

  const date = (value: string) => new Date(value).toLocaleString(t("interfaceLanguage"));
  const fileSummary = (backup: SettingsBackup) =>
    t("servicesWupage", backup.settings.providers.length, backup.extensionVersion, date(backup.createdAt));
  const syncSummary = (backup: { extensionVersion: string; createdAt: string }) =>
    t("settingsSyncSummary", backup.extensionVersion, date(backup.createdAt));

  exportButton.addEventListener("click", () => {
    if (busy || pending) return;
    setBusy(true);
    void (async () => {
      try {
        // Always read storage, never the form or its potentially stale baseline.
        const saved = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
        const backup = createSettingsBackup(saved, chrome.runtime.getManifest().version);
        preview({ mode: "export", backup, source: saved }, { title: "exportSettingsBackup",
          summary: fileSummary(backup), warning: exportWarning(false), confirm: "confirmExport" });
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
        const backup = parseSettingsBackup(text);
        preview({ mode: "import", backup, text }, { title: "importAndReplaceSettings", summary: fileSummary(backup),
          warning: t("importingImmediatelyReplacesAllSettingsAndDiscardsUnsaved", backup.includesKeys
            ? t("thisBackupIncludesCredentialsAndWillOverwriteThe") : t("thisBackupOmitsCredentialsImportingClearsExistingCredentials")),
          confirm: "confirmReplacement" });
      } catch (error) { options.status(message(error)); }
      finally { setBusy(false); }
    })();
  });

  function prepareSync(target: SyncTarget, mode: "upload" | "restore"): void {
    if (busy || pending) return;
    setBusy(true);
    const status = syncStatus[target];
    status.textContent = t(mode === "upload" ? "creatingBackup" : "settingsSyncReading");
    void (async () => {
      try {
        const remote = target === "dav" ? dav() : undefined;
        if (!remote && !chrome.storage?.sync) throw new Error(t("settingsSyncBrowserReadFailed"));
        if (mode === "restore") {
          const text = await (remote ? remote.read() : readBrowserSettings());
          const backup = parseSettingsSyncBackup(text);
          preview({ mode, target, text }, { title: "settingsSyncRestoreTitle", summary: syncSummary(backup),
            warning: t("settingsSyncRestoreWarning"), confirm: "settingsSyncConfirmRestore", destination: remote?.destination });
        } else {
          const saved = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
          const backup = createSettingsSyncBackup(saved, chrome.runtime.getManifest().version);
          const text = serializeSettingsSyncBackup(backup);
          const revision = remote ? await remote.revision() : null;
          preview({ mode, target, write: () => remote ? remote.write(text, revision) : publishBrowserSettings(text) }, {
            title: remote ? "settingsSyncDavUploadTitle" : "settingsSyncBrowserUploadTitle", summary: syncSummary(backup),
            warning: t("settingsSyncUploadScope") + " " + t(remote
              ? revision === null ? "settingsSyncDavCreate" : "settingsSyncDavOverwrite"
              : "settingsSyncBrowserOverwrite"),
            confirm: "settingsSyncConfirmUpload", destination: remote?.destination
          });
        }
        status.textContent = "";
      } catch (error) { status.textContent = message(error); }
      finally { setBusy(false); }
    })();
  }

  publishBrowser.addEventListener("click", () => prepareSync("browser", "upload"));
  restoreBrowser.addEventListener("click", () => prepareSync("browser", "restore"));
  publishDav.addEventListener("click", () => prepareSync("dav", "upload"));
  restoreDav.addEventListener("click", () => prepareSync("dav", "restore"));

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
    dialogStatus.textContent = t(operation.mode === "import" || operation.mode === "restore" ? "saving" : "creatingBackup");
    void (async () => {
      try {
        if (operation.mode === "export") {
          const backup = createSettingsBackup(operation.source, operation.backup.extensionVersion,
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
        } else if (operation.mode === "import") {
          const result = await sendRuntimeMessage<SettingsImportResult>({ type: "IMPORT_SETTINGS", backup: operation.text });
          if (closed) return;
          options.imported(result.settings);
          options.status(t("settingsImportedAndSaved")
            + (operation.backup.includesKeys ? "" : t("settingsRestoredThisBackupOmittedCredentialsSoPrevious"))
            + (result.imageTranslationDisabled ? t("ocrModelsAreMissingOnThisDeviceInstall") : ""));
        } else if (operation.mode === "upload") {
          await requestSyncConsent();
          await operation.write();
          syncStatus[operation.target].textContent = t(operation.target === "dav" ? "settingsSyncDavPublished" : "settingsSyncBrowserPublished");
        } else {
          const settings = await sendRuntimeMessage<ExtensionSettings>({ type: "RESTORE_SYNC_SETTINGS", backup: operation.text });
          if (closed) return;
          options.imported(settings);
          syncStatus[operation.target].textContent = t("settingsSyncRestored");
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
    davPassword.value = "";
    for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    urls.clear();
  }, { once: true });
}

async function requestSyncConsent(): Promise<void> {
  if (location.protocol !== "moz-extension:") return;
  // The upload confirmation is the user gesture required by Firefox.
  const permission: chrome.permissions.Permissions & { data_collection: string[] } = {
    data_collection: ["technicalAndInteraction"]
  };
  const granted = await chrome.permissions.request(permission).catch(() => false);
  if (!granted) throw new Error(t("settingsSyncConsentDenied"));
}

function message(error: unknown): string { return error instanceof Error ? error.message : t("settingsBackupOperationFailedTryAgain"); }
function exportWarning(includeKeys: boolean): string {
  return includeKeys
    ? t("thisUnencryptedTomlBackupIncludesSavedSettingsCredentials")
      : t("thisBackupOmitsCredentialsAndCustomRequestSettings");
}
