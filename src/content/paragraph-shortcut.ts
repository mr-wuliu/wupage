import { t } from "../shared/i18n";
import { findTranslatableParagraph } from "./dom";
import { translateParagraph } from "./paragraph-translation";
import { discoverShadowRoots } from "./dom-roots";

const EXCLUDED = "input,textarea,select,button,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='combobox'],[role='button'],img,video,audio,canvas,svg,#wupage-selection-tools,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-debug-panel,#wupage-image-tools,#wupage-shortcut-notice";

function resolveParagraph(element: Element | null, anchor?: Node): Element | null {
  if (!element || element === document.body || element === document.documentElement || element.closest(EXCLUDED)) return null;
  return findTranslatableParagraph(element, anchor);
}

/** Keep the saved shortcut ID while routing it through the shared paragraph engine. */
export async function translateShortcutParagraphs(): Promise<void> {
  const selection = window.getSelection();
  const targets = new Set<Element>();
  let selected = false;
  for (let index = 0; index < (selection?.rangeCount ?? 0); index++) {
    const range = selection!.getRangeAt(index);
    if (range.collapsed) continue;
    selected = true;
    const collect = (node: Node): void => {
      if (!node.textContent?.trim() || !range.intersectsNode(node)
        || (node === range.startContainer && range.startOffset === node.textContent.length)
        || (node === range.endContainer && range.endOffset === 0)) return;
      const paragraph = resolveParagraph(node.parentElement, node);
      if (paragraph) targets.add(paragraph);
    };
    const ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === Node.TEXT_NODE) collect(ancestor);
    else {
      const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) collect(walker.currentNode);
    }
  }
  if (!selected) {
    let hovered = [...document.querySelectorAll(":hover")].at(-1) ?? null;
    while (hovered?.shadowRoot) {
      discoverShadowRoots(hovered, false);
      const inner = [...hovered.shadowRoot.querySelectorAll(":hover")].at(-1);
      if (!inner) break;
      hovered = inner;
    }
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const paragraph = resolveParagraph(hovered) ?? resolveParagraph(focused);
    if (paragraph) targets.add(paragraph);
  }
  if (!targets.size) throw new Error(t("hoverOverAParagraphOrSelectItsText"));
  await Promise.all([...targets].map(target => translateParagraph(target)));
}
