import { t } from "../shared/i18n";
export function setupSettingsResetControls(reset: () => Promise<void>): void {
  const query = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const trigger = query<HTMLButtonElement>("restore");
  const dialog = query<HTMLDialogElement>("settingsResetDialog");
  const cancel = query<HTMLButtonElement>("cancelSettingsReset");
  const confirm = query<HTMLButtonElement>("confirmSettingsReset");
  const status = query("settingsResetStatus");
  let busy = false;
  let closed = false;

  function setBusy(value: boolean): void {
    busy = value;
    trigger.disabled = cancel.disabled = confirm.disabled = value;
    dialog.setAttribute("aria-busy", String(value));
  }
  trigger.addEventListener("click", () => {
    if (closed || busy || dialog.open) return;
    status.textContent = "";
    dialog.showModal();
    cancel.focus();
  });
  cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!dialog.open) status.textContent = ""; });
  confirm.addEventListener("click", () => {
    if (closed || busy || !dialog.open) return;
    setBusy(true);
    status.textContent = t("resetting");
    void (async () => {
      try {
        await reset();
        if (!closed) dialog.close();
      } catch (error) {
        if (!closed) status.textContent = t("resetFailed", error instanceof Error ? error.message : t("tryAgain"));
      } finally { setBusy(false); }
    })();
  });
  window.addEventListener("pagehide", () => { closed = true; }, { once: true });
}
