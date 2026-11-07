import icons from "./provider-icons/icons.json";
import type { ProviderConfig } from "./types";
import { uiIconMarkup } from "./ui-icons";

const generic = uiIconMarkup("code");
const local = uiIconMarkup("display");
const serviceMarks = {
  tencent: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1677ff"/><path d="M6 7h12v3h-4.5v8h-3v-8H6Z" fill="#fff"/></svg>',
  yandex: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fc3f1d"/><path d="m6 6 4.5 7v5h3v-5L18 6h-3.5L12 10.5 9.5 6Z" fill="#fff"/></svg>',
  volcengine: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1664ff"/><path d="m5 7 5 11h4l5-11h-3.5L12 15l-3.5-8Z" fill="#fff"/></svg>',
  mymemory: '<svg viewBox="0 0 24 24"><path d="M4 2h16a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="#116466"/><path d="M6 15V6h3l3 4 3-4h3v9h-3v-5l-3 4-3-4v5Z" fill="#fff"/></svg>'
};

export function providerIconMarkup(provider: Pick<ProviderConfig, "type"> | undefined): string {
  let icon: keyof typeof icons | keyof typeof serviceMarks | "local" | "generic";
  switch (provider?.type) {
    case "microsoft-web-translate":
    case "microsoft-translator": icon = "microsoft-color"; break;
    case "google-web-translate":
    case "google-cloud-translation": icon = "google-color"; break;
    case "tencent-transmart": icon = "tencent"; break;
    case "yandex-web-translate": icon = "yandex"; break;
    case "volcengine-web-translate": icon = "volcengine"; break;
    case "doubao-web": icon = "doubao-color"; break;
    case "mymemory": icon = "mymemory"; break;
    case "deepl": icon = "deepl-color"; break;
    case "index-translate": icon = "bilibiliindex"; break;
    case "deepseek": icon = "deepseek-color"; break;
    case "zhipu-glm": icon = "zhipu-color"; break;
    case "openai-compatible": icon = "openai"; break;
    case "anthropic-compatible": icon = "anthropic"; break;
    case "firefox-local": icon = "local"; break;
    default: icon = "generic";
  }
  const svg = icon === "generic" ? generic : icon === "local" ? local
    : icon in serviceMarks ? serviceMarks[icon as keyof typeof serviceMarks] : icons[icon as keyof typeof icons];
  const markup = icon === "generic" || icon === "local" ? svg : svg.replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
  return `<span class="wupage-provider-icon" data-provider-icon="${icon}" aria-hidden="true">${markup}</span>`;
}

export function ensureProviderIconStyles(): void {
  if (document.getElementById("wupage-provider-icon-styles")) return;
  const style = document.createElement("style");
  style.id = "wupage-provider-icon-styles";
  style.textContent = `
    .wupage-provider-icon { all: initial !important; display: inline-flex !important; position: static !important; flex: 0 0 20px !important; width: 20px !important; height: 20px !important; align-items: center !important; justify-content: center !important; color: inherit !important; vertical-align: middle !important; pointer-events: none !important; }
    .wupage-provider-icon svg { display: block !important; position: static !important; width: 20px !important; height: 20px !important; flex: none !important; margin: 0 !important; transform: none !important; }
  `;
  (document.head ?? document.documentElement).append(style);
}
