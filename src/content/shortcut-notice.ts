let noticeTimer: number | undefined;

/** One transient status line shared by keyboard shortcut actions. */
export function showShortcutNotice(message: string, error = false): void {
  window.clearTimeout(noticeTimer);
  let host = document.getElementById("wupage-shortcut-notice");
  if (!host) {
    host = document.createElement("div");
    host.id = "wupage-shortcut-notice";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto 16px 24px!important;z-index:2147483647!important;pointer-events:none!important;display:flex!important;justify-content:center!important;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{font:14px/1.6 system-ui}p{margin:0;padding:10px 16px;max-width:520px;border:1px solid #637570;border-radius:10px;background:#20352f;color:#fff;box-shadow:0 4px 20px #0002;overflow-wrap:anywhere}p[data-error=true]{background:#78322d;border-color:#a56560}";
    const notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    root.append(style, notice);
    document.documentElement.append(host);
  }
  const notice = host.shadowRoot!.querySelector("p")!;
  notice.textContent = message;
  notice.dataset.error = String(error);
  noticeTimer = window.setTimeout(() => host.remove(), error ? 6000 : 3500);
}
