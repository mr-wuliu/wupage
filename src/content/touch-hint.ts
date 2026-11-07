import { t } from "../shared/i18n";
import { uiIconMarkup } from "../shared/ui-icons";
import { setHtmlContent } from "../shared/html";

const KEY = "wupage.touch-hint-seen";
let requested = false;

export async function showTouchHint(ball: HTMLElement): Promise<void> {
  if (requested || !chrome.storage?.local) return;
  requested = true;
  try {
    if ((await chrome.storage.local.get(KEY))[KEY] || !ball.isConnected || ball.closest("[hidden]")) return;
    const host = document.createElement("aside");
    host.id = "wupage-touch-hint";
    host.setAttribute("translate", "no");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto 12px max(16px,env(safe-area-inset-bottom))!important;z-index:2147483647!important;max-width:400px!important;margin:auto!important;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = "div{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;border:1px solid var(--wp-border,#c9d1cf);border-radius:12px;background:var(--wp-surface,#fff);color:var(--wp-foreground,#172026);box-shadow:0 4px 20px #0002;font:13px/1.6 system-ui,sans-serif}p{flex:1;margin:0}button{display:grid;place-items:center;flex:none;width:44px;height:44px;border:0;border-radius:8px;background:var(--wp-soft,#eef2f1);color:inherit;touch-action:manipulation}svg{width:16px;height:16px}";
    const container = document.createElement("div");
    const text = document.createElement("p"); text.setAttribute("role", "status");
    text.textContent = t("tapTheFloatingButtonToTranslateLongPress");
    const close = document.createElement("button"); close.type = "button"; close.setAttribute("aria-label", t("dismissFloatingButtonHint"));
    setHtmlContent(close, uiIconMarkup("cross"));
    let timer: ReturnType<typeof setTimeout>;
    const dismiss = () => { clearTimeout(timer); host.remove(); window.removeEventListener("pagehide", dismiss); };
    close.addEventListener("click", dismiss);
    window.addEventListener("pagehide", dismiss, { once: true });
    container.append(text, close); root.append(style, container); document.documentElement.append(host);
    timer = setTimeout(dismiss, 7000);
    await chrome.storage.local.set({ [KEY]: true });
  } catch { /* A help hint must never block the translation controls. */ }
}
