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
    query("settingsBackupDialogTitle").textContent = mode === "export" ? "导出设置备份" : "导入并覆盖设置";
    query("settingsBackupSummary").textContent = `${backup.settings.providers.length} 个翻译服务 · WuPage ${backup.extensionVersion} · ${new Date(backup.createdAt).toLocaleString()}`;
    query("settingsBackupWarning").textContent = mode === "export" ? exportWarning(false)
      : `${backup.includesKeys ? "此备份包含密钥，将覆盖本机凭据。" : "此备份不包含密钥，将清空本机旧凭据；其他配置按备份恢复，密钥需重新填写。"}导入会立即覆盖全部设置，并丢弃当前未保存的编辑。仅导入可信来源的备份；文件中的服务地址决定后续翻译请求和密钥的接收方。建议先导出当前设置。`;
    confirm.textContent = mode === "export" ? "确认导出" : "确认覆盖";
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
        if (file.size > SETTINGS_BACKUP_MAX_BYTES) throw new Error("设置备份不能超过 5 MiB。");
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
    dialogStatus.textContent = operation.mode === "import" ? "正在保存…" : "正在生成备份…";
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
          options.status(backup.includesKeys ? "已生成包含密钥的完整备份，请查看浏览器下载记录。文件未加密，请妥善保管。"
            : "已生成不含密钥的设置备份，其余配置已保留，请查看浏览器下载记录。");
        } else {
          const result = await sendRuntimeMessage<SettingsImportResult>({ type: "IMPORT_SETTINGS", backup: operation.text });
          if (closed) return;
          options.imported(result.settings);
          options.status("已导入并保存设置。"
            + (operation.backup.includesKeys ? "" : "无密钥备份已清空本机旧凭据，其他配置已恢复，密钥需重新填写。")
            + (result.imageTranslationDisabled ? "本机未安装 OCR 模型，图片翻译保持关闭；安装模型后可重新开启。" : ""));
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

function message(error: unknown): string { return error instanceof Error ? error.message : "设置备份操作失败，请重试。"; }
function exportWarning(includeKeys: boolean): string {
  return includeKeys
    ? "备份包含全部已保存设置，以及密钥、请求头和模板等敏感信息，以未加密 TOML 保存。请妥善保管，不要公开分享。当前未保存的编辑不会导出。"
    : "备份不包含密钥，保留服务地址、请求头、模板、提示词及其他已保存设置，仅清空密钥字段和可识别的认证值。分享前请检查自定义内容中手动嵌入的敏感信息。当前未保存的编辑不会导出。";
}
