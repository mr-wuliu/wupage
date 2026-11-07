import { t, htmlMessage } from "./i18n";
import { ensureProviderIconStyles, providerIconMarkup } from "./provider-icons";
import type { ProviderConfig } from "./types";
import { uiIconMarkup } from "./ui-icons";
import { htmlFragment, setHtmlContent } from "./html";

const pickers = new WeakMap<HTMLSelectElement, () => void>();
let openPicker: { root: HTMLElement; close: (focus?: boolean) => void } | undefined;
let nextId = 0;

/** Enhance a native select while retaining its value, options and change events. */
export function enhanceProviderSelect(select: HTMLSelectElement, providers: ProviderConfig[]): void {
  ensureProviderIconStyles();
  ensurePickerStyles();
  select.dataset.providerTypes = JSON.stringify(Object.fromEntries(providers.map(({ id, type }) => [id, type])));
  const refresh = pickers.get(select);
  if (refresh) { refresh(); return; }

  select.hidden = true;
  const root = document.createElement("div");
  root.className = "wupage-provider-picker";
  setHtmlContent(root, `<button type="button" class="wupage-provider-trigger" aria-label="${htmlMessage("translationService")}" aria-haspopup="listbox" aria-expanded="false"></button><div class="wupage-provider-list" role="listbox" aria-label="${htmlMessage("translationService")}" popover="manual" hidden></div>`);
  select.after(root);
  const trigger = root.querySelector<HTMLButtonElement>("button")!;
  const list = root.querySelector<HTMLDivElement>("[role='listbox']")!;
  list.id = `wupage-provider-list-${++nextId}`;
  trigger.setAttribute("aria-controls", list.id);

  const close = (focus = false): void => {
    const wasOpen = !list.hidden;
    if (!list.hidden && list.hidePopover && list.matches(":popover-open")) list.hidePopover();
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (openPicker?.root === root) openPicker = undefined;
    if (focus) trigger.focus();
    if (wasOpen) root.dispatchEvent(new Event("wupage-provider-close", { bubbles: true }));
  };
  const render = (): void => {
    close();
    const types = JSON.parse(select.dataset.providerTypes!) as Record<string, ProviderConfig["type"]>;
    const markup = (option: HTMLOptionElement): string => providerIconMarkup(types[option.value] ? { type: types[option.value] } : undefined);
    const selected = select.selectedOptions[0];
    trigger.setAttribute("aria-label", t("selectedServiceLabel", selected?.textContent ?? t("noneSelected")));
    trigger.title = selected?.textContent ?? t("chooseTranslationService");
    setHtmlContent(trigger, selected ? markup(selected) : providerIconMarkup(undefined));
    const label = document.createElement("span");
    label.className = "wupage-provider-name";
    label.textContent = selected?.textContent ?? t("chooseTranslationService");
    trigger.append(label);
    trigger.append(htmlFragment(`<span class="wupage-provider-arrow" aria-hidden="true">${uiIconMarkup("arrow-down-03")}</span>`, trigger.ownerDocument));
    trigger.disabled = select.disabled;
    list.replaceChildren(...Array.from(select.options, (option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wupage-provider-choice";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(option.selected));
      button.tabIndex = -1;
      button.disabled = option.disabled;
      button.dataset.value = option.value;
      setHtmlContent(button, markup(option));
      const name = document.createElement("span");
      name.className = "wupage-provider-name";
      name.textContent = option.textContent;
      button.append(name);
      button.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        const changed = select.value !== option.value;
        select.value = option.value;
        close(true);
        render();
        if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return button;
    }));
  };
  const choices = (): HTMLButtonElement[] => Array.from(list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const open = (): void => {
    openPicker?.close();
    list.hidden = false;
    list.showPopover?.();
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upwards = below < 180 && above > below;
    const maxHeight = Math.max(80, Math.min(280, upwards ? above : below));
    for (const [key, value] of Object.entries({
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`, width: `${rect.width}px`,
      top: upwards ? "auto" : `${rect.bottom + 4}px`, bottom: upwards ? `${window.innerHeight - rect.top + 4}px` : "auto",
      "max-height": `${maxHeight}px`
    })) list.style.setProperty(key, value, "important");
    trigger.setAttribute("aria-expanded", "true");
    openPicker = { root, close };
    const selected = choices().find((button) => button.getAttribute("aria-selected") === "true") ?? choices()[0];
    selected?.focus();
    selected?.scrollIntoView?.({ block: "nearest" });
  };
  trigger.addEventListener("click", (event) => {
    event.preventDefault(); event.stopPropagation();
    if (list.hidden) open(); else close(true);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) { event.stopPropagation(); event.preventDefault(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (list.hidden) { open(); return; }
    const buttons = choices();
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: "nearest" });
  });
  select.addEventListener("change", render);
  pickers.set(select, render);
  render();
}

function ensurePickerStyles(): void {
  if (document.getElementById("wupage-provider-picker-styles")) return;
  const style = document.createElement("style");
  style.id = "wupage-provider-picker-styles";
  style.textContent = `
    .wupage-provider-picker { all: initial !important; display: block !important; position: relative !important; min-width: 0 !important; width: 100% !important; font: inherit !important; }
    .wupage-provider-picker button { all: initial !important; box-sizing: border-box !important; display: flex !important; align-items: center !important; gap: 9px !important; width: 100% !important; min-height: 36px !important; padding: 7px 10px !important; border-radius: 6px !important; color: var(--wp-foreground, #172026) !important; background: var(--wp-surface, #fff) !important; font: 500 13px/1.4 system-ui, sans-serif !important; text-align: left !important; cursor: pointer !important; }
    .wupage-provider-picker .wupage-provider-trigger { border: 1px solid var(--wp-border, #c9d1cf) !important; }
    .provider-select .wupage-provider-picker .wupage-provider-trigger { color: #edf5f1 !important; background: #263632 !important; border-color: #41504c !important; }
    .wupage-provider-picker button:hover, .wupage-provider-picker button:focus-visible, .wupage-provider-picker [aria-selected="true"] { background: var(--wp-selected, #edf4f1) !important; }
    .wupage-provider-picker button:focus-visible { outline: 2px solid var(--wp-accent, #116466) !important; outline-offset: -2px !important; }
    .wupage-provider-picker button:disabled { opacity: .5 !important; cursor: default !important; }
    .wupage-provider-picker .wupage-provider-name { all: initial !important; display: block !important; position: static !important; min-width: 0 !important; flex: 1 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; color: inherit !important; font: inherit !important; }
    .wupage-provider-picker .wupage-provider-arrow { all: initial !important; display: flex !important; position: static !important; flex: 0 0 10px !important; width: 10px !important; height: 10px !important; margin: 0 2px 0 8px !important; color: var(--wp-muted, #627077) !important; }
    .wupage-provider-arrow svg { width: 10px !important; height: 10px !important; }
    .wupage-provider-trigger[aria-expanded="true"] .wupage-provider-arrow { transform: rotate(180deg) !important; }
    .wupage-provider-list { all: initial !important; box-sizing: border-box !important; position: fixed !important; inset: auto; display: block !important; z-index: 2147483647 !important; overflow-y: auto !important; overscroll-behavior: contain !important; padding: 4px !important; margin: 0 !important; border: 1px solid var(--wp-border, #c9d1cf) !important; border-radius: 8px !important; background: var(--wp-surface, #fff) !important; box-shadow: 0 8px 24px #18282c29 !important; }
    .wupage-provider-list[hidden] { display: none !important; }
    .wupage-provider-picker select[hidden] { display: none !important; }
  `;
  (document.head ?? document.documentElement).append(style);
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !openPicker?.root.contains(event.target)) openPicker?.close();
  });
  document.addEventListener("scroll", (event) => {
    if (event.target instanceof Node && !openPicker?.root.contains(event.target)) openPicker?.close();
  }, true);
  window.addEventListener("resize", () => openPicker?.close());
  window.addEventListener("pagehide", () => openPicker?.close());
}
