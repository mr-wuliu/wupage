import { installFrameRuntime } from "./frame-runtime";
import { initializeInterfaceLanguage } from "../shared/i18n";
import { injectContentStyles } from "./styles";
import { initSelectionTranslation } from "./selection-translation";
import { translateShortcutParagraphs } from "./paragraph-shortcut";
import { findTranslatableParagraph } from "./dom";
import { textNodeAtPoint } from "./text-flow";
import { translateParagraph } from "./paragraph-translation";
import { sendRuntimeRequest } from "./runtime";
import type { ExtensionSettings } from "../shared/types";
import { setupAppearance } from "../shared/appearance-runtime";
import { SETTINGS_KEY } from "../shared/defaults";
import { normalizeShortcutEnabled } from "../shared/shortcuts";
import { matchesParagraphClick, normalizeLocalShortcuts } from "../shared/local-shortcuts";

export async function activateFrameContent(documentKey: string, initialSettings?: ExtensionSettings) {
  await initializeInterfaceLanguage();
  injectContentStyles();
  initSelectionTranslation();
  const appearance = setupAppearance(undefined, { extensionPage: false });
  let localShortcuts = normalizeLocalShortcuts(undefined), shortcutEnabled = normalizeShortcutEnabled(undefined), revision = 0;
  const applySettings = (settings: ExtensionSettings) => {
    appearance.update(settings.appearance);
    localShortcuts = normalizeLocalShortcuts(settings.localShortcuts);
    shortcutEnabled = normalizeShortcutEnabled(settings.shortcutEnabled, settings.shortcuts, localShortcuts);
  };
  if (initialSettings) applySettings(initialSettings);
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => { if (!revision) applySettings(settings); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]?.newValue) { revision++; applySettings(changes[SETTINGS_KEY].newValue as ExtensionSettings); }
  });
  let paragraph = false;
  let pending = false;
  document.addEventListener("click", event => {
    if (!paragraph || !shortcutEnabled["paragraph-click"] || !matchesParagraphClick(event, localShortcuts["paragraph-click"]) || pending) return;
    const element = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (element?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    const target = findTranslatableParagraph(element ?? null, textNodeAtPoint(document, event.clientX, event.clientY) ?? undefined);
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); pending = true;
    void translateParagraph(target)
      .catch(() => {}).finally(() => { pending = false; });
  }, true);
  const setParagraph = (enabled: boolean) => {
    paragraph = enabled; document.documentElement.classList.toggle("wupage-paragraph-mode", enabled);
  };
  const runtime = installFrameRuntime(documentKey, { top: false });
  return { ...runtime, paragraph: setParagraph, selection: translateShortcutParagraphs };
}
